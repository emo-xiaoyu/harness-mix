const { randomUUID } = require("node:crypto");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { CapabilityManager } = require('../protocol-core/capability-manager');
const { normalizeCapabilities } = require('../harness-adapter/manifest');
const { Store } = require("./store");
const { buildAdapters } = require("../adapters");
const { ReviewController } = require('../workspace/review-controller');
const { ReviewStore } = require('../workspace/review');
const { CoreSession } = require('./core-session');

/**
 * Host Runtime：harness-mix 的核心职责 —— 自研 Desktop 背后的
 * 会话管理、任务恢复/Fork 编排、统一事件投影与持久化。
 * 各 Harness（Pi、Claude Code、DSH…）的会话、模型调用、工具和权限
 * 仍由其原生程序维护，Adapter 只负责原生协议接入与事件转换。
 */
class HostRuntime {
  constructor({ dataDirectory, observer = null }) {
    this.store = new Store(dataDirectory);
    this.threads = [];
    this.sessions = new Map(); // threadId -> { adapter, ...session }
    this.listeners = new Set();
    this.adapters = new Map();
    this.status = {};
    this.capabilityManager = new CapabilityManager();
    this.catalogs = new Map(); // harnessId -> describe() 缓存（模型目录/思考档位/权限模式）
    this.reviews = new ReviewStore(dataDirectory);
    this.settlements = new Set();
    this.reviewMonitors = new Map();
    this.reviewTasks = new Set();
    this.openings = new Map();
    this.reviewController = new ReviewController(this, { save: () => this.#save(), broadcast: () => this.#broadcast() });
    this.execution = new CoreSession();
    this.core = this.execution.core;
    this.observer = observer;
  }

  async initialize() {
    this.threads = await this.store.load();
    const emit = (event) => this.#applyEvent(event);
    for (const adapter of buildAdapters(emit)) this.adapters.set(adapter.manifest.id, adapter);
    const inspections = await Promise.all([...this.adapters.values()].map(async (adapter) => [adapter.manifest.id, await adapter.inspect().catch((e) => ({ available: false, detail: e.message }))]));
    this.status = Object.fromEntries(inspections);
    // 惰性恢复：启动时只把持久化的任务标记为待恢复，原生进程在下次发送/打开时按需拉起
    for (const thread of this.threads) {
      thread.connectionStatus = 'ready';
      if (thread.nativeSessionId && thread.messages?.length) thread.restore = true;
      if (thread.status === "working" || thread.status === "opening") thread.status = "ready";
      for (const message of thread.messages ?? []) {

        if (message.reviewId && !message.review) message.reviewError = '上次任务中断，文件快照未结算，不能安全撤回。';
      }
      thread.reviewPending = false;
      thread.pendingApprovals = [];
      thread.tools = (thread.tools ?? []).map((tool) => (tool.state === "running" ? { ...tool, state: "interrupted" } : tool));
      this.execution.threadCreated(thread);
    }
    await this.#save();
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** 各 Harness 原生目录探测（模型/思考档位/权限模式），结果缓存 */
  async describe(harnessId) {
    if (this.catalogs.has(harnessId)) return this.catalogs.get(harnessId);
    const adapter = this.#requireAdapter(harnessId);
    if (typeof adapter.describe !== "function") throw new Error(`${adapter.manifest.name} 未提供目录探测`);
    const session = [...this.sessions.values()].find(s => s.adapter === adapter);
    const catalog = session && adapter.describeFor ? await adapter.describeFor(session) : await adapter.describe();
    this.catalogs.set(harnessId, catalog);
    return catalog;
  }

  getCapabilities(harnessId) {
    this.capabilityManager.register(harnessId, normalizeCapabilities(this.adapters.get(harnessId)?.manifest.capabilities));
    return this.capabilityManager.get(harnessId);
  }

  snapshot() {
    return {
      threads: this.threads.map(({ coreState, ...thread }) => ({ ...thread, capabilities: this.getCapabilities(thread.harnessId), coreEnabled: true })),
      adapters: [...this.adapters.values()].map((a) => ({ id: a.manifest.id, name: a.manifest.name, icon: a.manifest.icon, capabilities: a.manifest.capabilities, coreCapabilities: this.getCapabilities(a.manifest.id), ...this.status[a.manifest.id] })),
    };
  }

  async createThread({ harnessId, cwd, title, options }) {
    const adapter = this.#requireAdapter(harnessId);
    await this.#assertCwd(cwd);
    const thread = {
      id: randomUUID(), harnessId, title: title || "新任务", cwd,
      nativeSessionId: randomUUID(), status: "opening",
      messages: [], tools: [], pendingApprovals: [], createdAt: Date.now(), restore: false,
      options: options && typeof options === "object" ? {
        model: options.model?.id ? { id: String(options.model.id), name: String(options.model.name ?? options.model.id), provider: options.model.provider } : undefined,
        thinking: typeof options.thinking === "string" ? options.thinking : undefined,
        permissionMode: typeof options.permissionMode === "string" ? options.permissionMode : undefined,
      } : {},
    };
    this.threads.unshift(thread);
    this.execution.threadCreated(thread);
    await this.#save();
    this.#broadcast();
    await this.#open(thread, adapter);
    return thread;
  }

  async listCommands({ threadId, harnessId }) {
    const thread = threadId ? this.#requireThread(threadId) : null;
    const adapter = this.#requireAdapter(thread?.harnessId ?? harnessId);
    if (typeof adapter.listCommands !== 'function') return [];
    // Opening a command menu must never resume a native session.
    const session = thread ? this.sessions.get(thread.id) : null;
    return adapter.listCommands(session);
  }

  async executeCommand(threadId, commandId) {
    const thread = this.#requireThread(threadId);
    const commands = await this.listCommands({ threadId });
    const command = commands.find(c => c.id === commandId && c.action === 'execute');
    if (!command) throw new Error('当前 Harness 不支持此指令');
    await this.send(threadId, '/' + command.id, command.id);
    await this.#refreshContextUsage(thread);
    await this.#save();
    this.#broadcast();
    if (thread.error) throw new Error(thread.error);
  }

  async send(threadId, text, commandId) {
    const thread = this.#requireThread(threadId);
    if (this.execution.isRunning(thread.id)) throw new Error("任务正在执行，请先停止或等待完成");
    if (typeof text !== "string" || !text.trim()) throw new Error("请输入消息");
    const session = await this.#ensureOpen(thread);
    if (!session) throw Error(thread.error ?? '原生会话未连接');
    if (this.threads.some(t => t.cwd.toLowerCase() === thread.cwd.toLowerCase() && (this.execution.isRunning(t.id) || t.reviewPending))) throw Error('同一项目已有任务执行或结算中，请等待完成以避免审查记录混入其他任务');
    thread.messages.push({ id: randomUUID(), role: "user", text, at: Date.now() });
    thread.updatedAt = Date.now();
    delete thread.error;
    this.execution.turnStarted(thread, text);
    const message = thread.messages.at(-1);
    this.observer?.turnStarted(thread, this.core);
    this.#syncCore(thread);
    try { message.reviewId = await this.reviews.begin(thread.cwd); }
    catch (e) { message.reviewError = '本轮未建立文件快照：' + e.message; }
    if (!this.execution.isRunning(thread.id)) {
      if (message.reviewId) await this.#settleReview(thread, message);
      return;
    }
    this.startReviewUpdates(thread, message);
    await this.#save();
    this.#broadcast();
    try {
      const hooks = { emit: (event) => this.#applyEvent({ threadId, event }) };
      if (commandId) await session.adapter.executeCommand(session, commandId, hooks);
      else await session.adapter.send(session, text, hooks);
    } catch (error) {
      // 用户取消造成的 reject 已由 cancel() 结算，不再标错
      if (this.execution.isRunning(thread.id)) this.#applyEvent({ threadId, event: { kind: "error", message: error.message } });
    }
  }

  async cancel(threadId) {
    const session = this.sessions.get(threadId);
    const thread = this.threads.find(t => t.id === threadId);
    // Record the user's cancellation before the native acknowledgement can settle.
    if (thread && this.execution.isRunning(thread.id)) this.#applyEvent({ threadId, event: { kind: 'completed', stopReason: 'cancelled' } });
    if (session) await session.adapter.cancel(session).catch(() => {});
  }

  /** 审批/提问应答：路由回对应 Adapter 的原生协议 */
  async respondApproval(threadId, requestId, response) {
    const thread = this.#requireThread(threadId);
    const session = this.sessions.get(threadId);
    if (!session) throw new Error('原生会话未连接，无法提交回答');
    await this.core.interactions.respond(threadId, requestId, response,
      (item, answer) => session.adapter.respond(session, item.requestId, answer));
    this.#syncCore(thread);
    await this.#save();
    this.#broadcast();
  }

  /** 模型目录：Adapter open 后从原生程序获取 */
  async listModels(threadId) {
    const thread = this.#requireThread(threadId);
    const adapter = this.#requireAdapter(thread.harnessId);
    if (!this.getCapabilities(thread.harnessId).model.selection) throw new Error(`${adapter.manifest.name} 暂不支持在桌面层选择模型`);
    const session = await this.#ensureOpen(thread);
    if (typeof adapter.listModelsFor === "function") {
      const models = await adapter.listModelsFor(session);
      if (models?.length) thread.models = models;
    }
    await this.#save();
    this.#broadcast();
    return thread.models ?? [];
  }

  async setModel(threadId, model) {
    const thread = this.#requireThread(threadId);
    const session = await this.#ensureOpen(thread);
    const applied = await session.adapter.setModel(session, model);
    thread.model = applied ?? model;
    thread.options ??= {};
    thread.options.model = thread.model;
    this.execution.apply(thread, { kind: 'usage', usage: { tokens: null, contextWindow: null, contextPercent: null }, timestamp: Date.now() });
    await this.#refreshContextUsage(thread);
    await this.#save();
    this.#broadcast();
    return thread.model;
  }

  async setThinking(threadId, level) {
    const thread = this.#requireThread(threadId);
    const adapter = this.#requireAdapter(thread.harnessId);
    if (!this.getCapabilities(thread.harnessId).model.thinkingLevel) throw new Error(`${adapter.manifest.name} 不支持思考档位`);
    const session = await this.#ensureOpen(thread);
    await session.adapter.setThinkingLevel(session, level);
    thread.options ??= {};
    thread.options.thinking = level;
    await this.#save();
    this.#broadcast();
  }

  /** 合并任务选项；权限模式能热应用则热应用（Claude），否则下次连接原生进程时生效（Pi 启动旗标） */
  async setOptions(threadId, options) {
    const thread = this.#requireThread(threadId);
    thread.options = { ...thread.options, ...options };
    const session = this.sessions.get(threadId);
    if (session && options.permissionMode && typeof session.adapter.setPermissionMode === "function") {
      await session.adapter.setPermissionMode(session, options.permissionMode);
    }
    await this.#save();
    this.#broadcast();
    return thread.options;
  }

  /** 任务 Fork：由 Adapter 向原生程序申请分叉出新会话，Host 建立新任务卡片 */
  async forkThread(threadId, messageId) {
    const source = this.#requireThread(threadId);
    const adapter = this.#requireAdapter(source.harnessId);
    if (!this.getCapabilities(source.harnessId).session.fork || typeof adapter.fork !== "function") {
      throw new Error(`${adapter.manifest.name} 的原生接口暂不支持 Fork`);
    }
    if (this.execution.isRunning(source.id)) throw new Error("任务执行中，请等待完成后再 Fork");
    if (source.status === "opening") throw new Error("任务正在连接 Harness，请稍后");
    if (source.reviewPending) throw new Error('文件变更正在结算，请稍后分支');
    const message = messageId ? source.messages.find(m => m.id === messageId && m.role === 'assistant' && !m.streaming) : null;
    if (messageId && !this.getCapabilities(source.harnessId).session.forkFromMessage) throw new Error('该 Harness 暂不支持从指定回复分支');
    if (messageId && !message) throw new Error('分支回复不存在或尚未完成');
    const history = message ? source.messages.slice(0, source.messages.indexOf(message) + 1) : source.messages;
    let forkThreadId = null;
    const { session, nativeSessionId, checkpointMap } = await adapter.fork(source, {
      emit: (event) => { if (forkThreadId) this.#applyEvent({ threadId: forkThreadId, event }); },
      diagnostic: () => {},
      message,
    });
    const thread = {
      id: randomUUID(), harnessId: source.harnessId, title: `${source.title} · Fork`, cwd: source.cwd,
      nativeSessionId: nativeSessionId ?? session.nativeSessionId, status: "ready",
      // IDs are scoped to a thread; clone together to retain tool references.
      messages: structuredClone(history.filter((m) => !m.streaming)),
      tools: structuredClone((source.tools ?? []).filter(tool => !message || history.some(entry => entry.id === tool.messageId))),
      pendingApprovals: [], createdAt: Date.now(), forkedFrom: source.id, restore: false,
      options: structuredClone(source.options ?? {}), model: session.model ?? source.model,
    };
    forkThreadId = thread.id;
    if (checkpointMap) {
      for (const entry of thread.messages) {
        const ref = entry.coreTurn?.nativeTurnRef;
        if (ref?.checkpointId) ref.checkpointId = checkpointMap[ref.checkpointId];
        if (ref?.sessionId) ref.sessionId = thread.nativeSessionId;
      }
    }
    this.threads.unshift(thread);
    this.execution.threadCreated(thread);
    this.sessions.set(thread.id, { adapter, ...session, threadId: thread.id });
    await this.#save();
    this.#broadcast();
    return thread;
  }

  /** 删除任务：关闭原生会话进程并移除记录（原生会话文件保留在 Harness 侧） */
  async removeThread(threadId) {
    const thread = this.#requireThread(threadId);
    const session = this.sessions.get(threadId);
    if (session) { await session.adapter.close(session).catch(() => {}); this.sessions.delete(threadId); }
    this.threads = this.threads.filter((t) => t.id !== threadId);
    await this.#save();
    this.#broadcast();
  }

  /** 移动任务到另一个项目：关闭当前原生进程，下次发送在新目录惰性恢复（项目级会话的原生历史可能不跟随） */
  async moveThread(threadId, cwd) {
    const thread = this.#requireThread(threadId);
    if (thread.status === "working") throw new Error("任务执行中，不能移动");
    await this.#assertCwd(cwd);
    if (thread.cwd === cwd) return thread;
    const session = this.sessions.get(threadId);
    if (session) { await session.adapter.close(session).catch(() => {}); this.sessions.delete(threadId); thread.restore = true; }
    thread.cwd = cwd;
    await this.#save();
    this.#broadcast();
    return thread;
  }

  async close() {
    clearTimeout(this.saveTimer); clearTimeout(this.broadcastTimer);
    for (const monitor of this.reviewMonitors.values()) { monitor.closed = true; clearInterval(monitor.timer); }
    this.reviewMonitors.clear();
    for (const session of this.sessions.values()) await session.adapter.close(session).catch(() => {});
    await Promise.allSettled([...this.reviewTasks]);
    clearTimeout(this.saveTimer); clearTimeout(this.broadcastTimer);
    await this.#save();
  }

  /* ---------------- 内部 ---------------- */

  #requireAdapter(harnessId) {
    const adapter = this.adapters.get(harnessId);
    if (!adapter) throw new Error(`未知 Harness：${harnessId}`);
    if (!this.status[harnessId]?.available) throw new Error(this.status[harnessId]?.detail || "该 Harness 不可用");
    return adapter;
  }

  #requireThread(threadId) {
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error("任务不存在");
    return thread;
  }

  async #assertCwd(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("请选择存在的绝对工作目录");
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("工作目录不存在");
  }

  /** 惰性打开：任务首次使用时才拉起原生进程；restore 标记让 Adapter 走原生恢复路径 */
  async #ensureOpen(thread) {
    const existing = this.sessions.get(thread.id);
    if (existing) return existing;
    const adapter = this.#requireAdapter(thread.harnessId);
    if (!this.openings.has(thread.id)) {
      const opening = this.#open(thread, adapter).finally(() => this.openings.delete(thread.id));
      this.openings.set(thread.id, opening);
    }
    await this.openings.get(thread.id);
    return this.sessions.get(thread.id);
  }

  async #open(thread, adapter) {
    thread.connectionStatus = 'opening';
    thread.status = "opening";
    this.#broadcast();
    try {
      const session = await adapter.open({
        thread,
        emit: (event) => event && this.#applyEvent({ threadId: thread.id, event }),
        diagnostic: (message) => this.#notify("info", `[${adapter.manifest.id}] ${message}`.slice(0, 300)),
      });
      thread.nativeSessionId = session.nativeSessionId ?? thread.nativeSessionId;
      thread.model = thread.model ?? session.model;
      if (session.models?.length) thread.models = session.models;
      thread.connectionStatus = "ready";
      thread.status = "ready";
      delete thread.error;
      this.sessions.set(thread.id, { adapter, ...session, threadId: thread.id });
      delete thread.restore;
      this.execution.apply(thread, { kind: 'session', nativeSessionId: thread.nativeSessionId, timestamp: Date.now() });
    } catch (error) {
      thread.connectionStatus = "error";
      thread.status = "error";
      thread.error = thread.restore ? `原生会话恢复失败：${error.message}` : error.message;
    }
    await this.#save();
    this.#broadcast();
  }

  /** 统一事件投影：Adapter 转换后的标准事件落到线程模型上 */
  #applyEvent({ threadId, event }) {
    if (!event) return;
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const turn = this.execution.lastTurn(thread.id);
    event = { ...event, timestamp: event.timestamp ?? Date.now() };
    const { settled, ignored } = this.execution.apply(thread, event);
    if (ignored) return;
    if (event.kind === 'session') {
      if (event.nativeSessionId) thread.nativeSessionId = event.nativeSessionId;
      if (event.model) thread.model = event.model;
    }
    if (event.kind === 'status' || event.kind === 'notice') this.#notify(event.kind === 'status' ? 'status' : event.level ?? 'info', event.text, thread.id);
    this.observer?.event(thread, event, this.core);
    if (settled) {
      thread.updatedAt = event.timestamp;
      this.#refreshContextUsage(thread);
      const task = this.#settleReview(thread, thread.messages.find(m => m.coreTurnId === turn.id));
      this.reviewTasks.add(task);
      void task.finally(() => this.reviewTasks.delete(task));
    }
    const structural = !['text-delta', 'thinking-delta', 'usage'].includes(event.kind);
    if (structural) {
      void this.#save();
      this.#broadcast();
    } else {
      this.#saveSoon();
      this.#broadcastSoon();
    }
  }

  /** Core diagnostics; Renderer receives projected views through snapshot(). */
  coreSnapshot() {
    return this.execution.snapshot();
  }

  /** Shadow 对照报告：mismatch / error / warning 全量，供 E2E 与调试断言 */
  shadowReport() {
    return this.observer?.report() ?? { enabled: false, reason: 'Legacy comparison is test-only; production uses Core exclusively.' };
  }

  #settleReview(...args) { return this.reviewController.settle(...args); }
  readReview(...args) { return this.reviewController.readReview(...args); }
  reviewMessage(...args) { return this.reviewController.reviewMessage(...args); }
  startReviewUpdates(...args) { return this.reviewController.startReviewUpdates(...args); }
  emitReviewUpdate(...args) { return this.reviewController.emitReviewUpdate(...args); }
  undoFile(...args) { return this.reviewController.undoFile(...args); }

  /** Refresh authoritative context usage when the adapter exposes it. */
  #refreshContextUsage(thread, strict = false) {
    const session = this.sessions.get(thread.id);
    if (!session || typeof session.adapter.getContextUsage !== "function") return;
    const turnId = this.execution.lastTurn(thread.id)?.id;
    return session.adapter.getContextUsage(session).then((usage) => {
      if (!usage || this.execution.lastTurn(thread.id)?.id !== turnId) return;
      this.#applyEvent({ threadId: thread.id, event: { kind: 'usage', usage } });
      this.#saveSoon();
      this.#broadcastSoon();
    }).catch(error => { if (strict) throw error; });
  }

  async refreshUsage(threadId) {
    const thread = this.#requireThread(threadId);
    if (typeof this.#requireAdapter(thread.harnessId).getContextUsage !== 'function') return thread.coreUsage ?? {};
    const session = await this.#ensureOpen(thread);
    if (!session) throw new Error(thread.error ?? '无法连接原生会话');
    await this.#refreshContextUsage(thread, true);
    return thread.coreUsage ?? {};
  }

  #notify(level, text, threadId) {
    for (const listener of this.listeners) listener({ type: "toast", level, text, threadId });
  }

  #broadcast() {
    for (const listener of this.listeners) listener({ type: "core/thread-updated" });
  }

  #broadcastSoon() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => { this.broadcastTimer = null; this.#broadcast(); }, 120);
  }

  #syncCore(thread) { this.execution.sync(thread); }

  #save() {
    for (const thread of this.threads) this.#syncCore(thread);
    return this.store.save(this.threads);
  }

  #saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.#save(); }, 500);
  }
}

module.exports = { HostRuntime };
