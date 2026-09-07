const { randomUUID } = require("node:crypto");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { Store } = require("./store");
const { appendDelta, projectTool, finishMessage } = require('./transcript');
const { buildAdapters } = require("../adapters");
const { ReviewStore } = require('../workspace/review');

/**
 * Host Runtime：harness-mix 的核心职责 —— 自研 Desktop 背后的
 * 会话管理、任务恢复/Fork 编排、统一事件投影与持久化。
 * 各 Harness（Pi、Claude Code、DSH…）的会话、模型调用、工具和权限
 * 仍由其原生程序维护，Adapter 只负责原生协议接入与事件转换。
 */
class HostRuntime {
  constructor({ dataDirectory }) {
    this.store = new Store(dataDirectory);
    this.threads = [];
    this.sessions = new Map(); // threadId -> { adapter, ...session }
    this.listeners = new Set();
    this.adapters = new Map();
    this.status = {};
    this.catalogs = new Map(); // harnessId -> describe() 缓存（模型目录/思考档位/权限模式）
    this.reviews = new ReviewStore(dataDirectory);
    this.settlements = new Set();
    this.reviewMonitors = new Map();
  }

  async initialize() {
    this.threads = await this.store.load();
    const emit = (event) => this.#applyEvent(event);
    for (const adapter of buildAdapters(emit)) this.adapters.set(adapter.manifest.id, adapter);
    const inspections = await Promise.all([...this.adapters.values()].map(async (adapter) => [adapter.manifest.id, await adapter.inspect().catch((e) => ({ available: false, detail: e.message }))]));
    this.status = Object.fromEntries(inspections);
    // 惰性恢复：启动时只把持久化的任务标记为待恢复，原生进程在下次发送/打开时按需拉起
    for (const thread of this.threads) {
      if (thread.status === "working" || thread.status === "opening") thread.status = "ready";
      for (const message of thread.messages ?? []) {
        if (message.streaming) finishMessage(thread, message, 'interrupted', thread.updatedAt ?? message.at);
        if (message.reviewId && !message.review) message.reviewError = '上次任务中断，文件快照未结算，不能安全撤回。';
      }
      thread.reviewPending = false;
      thread.pendingApprovals = [];
      thread.tools = (thread.tools ?? []).map((tool) => (tool.state === "running" ? { ...tool, state: "interrupted" } : tool));
    }
    await this.#save();
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** 各 Harness 原生目录探测（模型/思考档位/权限模式），结果缓存 */
  async describe(harnessId) {
    if (this.catalogs.has(harnessId)) return this.catalogs.get(harnessId);
    const adapter = this.#requireAdapter(harnessId);
    if (typeof adapter.describe !== "function") throw new Error(`${adapter.manifest.name} 未提供目录探测`);
    const catalog = await adapter.describe();
    this.catalogs.set(harnessId, catalog);
    return catalog;
  }

  snapshot() {
    return {
      threads: this.threads,
      adapters: [...this.adapters.values()].map((a) => ({ id: a.manifest.id, name: a.manifest.name, icon: a.manifest.icon, capabilities: a.manifest.capabilities, ...this.status[a.manifest.id] })),
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
    await this.#save();
    this.#broadcast();
    await this.#open(thread, adapter);
    return thread;
  }

  async send(threadId, text) {
    const thread = this.#requireThread(threadId);
    if (thread.status === "working") throw new Error("任务正在执行，请先停止或等待完成");
    if (typeof text !== "string" || !text.trim()) throw new Error("请输入消息");
    const session = await this.#ensureOpen(thread);
    if (!session) throw Error(thread.error ?? '原生会话未连接');
    if (this.threads.some(t => t.id !== thread.id && t.cwd.toLowerCase() === thread.cwd.toLowerCase() && t.status === 'working')) throw Error('同一项目已有任务执行中，请等待完成以避免审查记录混入其他任务');
    thread.messages.push({ id: randomUUID(), role: "user", text, at: Date.now() });
    thread.messages.push({ id: randomUUID(), role: "assistant", text: "", at: Date.now(), streaming: true });
    thread.status = "working";
    thread.updatedAt = Date.now();
    const message = thread.messages.at(-1);
    try { message.reviewId = await this.reviews.begin(thread.cwd); }
    catch (e) { message.reviewError = '本轮未建立文件快照：' + e.message; }
    if (!message.streaming) return; // Cancel during snapshot preparation must not send a prompt.
    this.startReviewUpdates(thread, message);
    await this.#save();
    this.#broadcast();
    try {
      await session.adapter.send(session, text, { emit: (event) => this.#applyEvent({ threadId, event }) });
    } catch (error) {
      // 用户取消造成的 reject 已由 cancel() 结算，不再标错
      if (thread.status === "working") this.#applyEvent({ threadId, event: { kind: "error", message: error.message } });
    }
  }

  async cancel(threadId) {
    const session = this.sessions.get(threadId);
    if (session) await session.adapter.cancel(session).catch(() => {});
    const thread = this.threads.find((t) => t.id === threadId);
    if (thread && thread.status === "working") this.#applyEvent({ threadId, event: { kind: "completed", stopReason: "cancelled" } });
  }

  /** 审批/提问应答：路由回对应 Adapter 的原生协议 */
  async respondApproval(threadId, requestId, response) {
    const thread = this.#requireThread(threadId);
    const index = (thread.pendingApprovals ?? []).findIndex((a) => a.requestId === requestId);
    if (index === -1) throw new Error("该请求已处理或已过期");
    const session = this.sessions.get(threadId);
    if (session) await session.adapter.respond(session, requestId, response);
    thread.pendingApprovals.splice(index, 1);
    await this.#save();
    this.#broadcast();
  }

  /** 模型目录：Adapter open 后从原生程序获取 */
  async listModels(threadId) {
    const thread = this.#requireThread(threadId);
    const adapter = this.#requireAdapter(thread.harnessId);
    if (!adapter.manifest.capabilities.models) throw new Error(`${adapter.manifest.name} 暂不支持在桌面层选择模型`);
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
    await this.#save();
    this.#broadcast();
    return thread.model;
  }

  async setThinking(threadId, level) {
    const thread = this.#requireThread(threadId);
    const adapter = this.#requireAdapter(thread.harnessId);
    if (!adapter.manifest.capabilities.thinkingLevels) throw new Error(`${adapter.manifest.name} 不支持思考档位`);
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
  async forkThread(threadId) {
    const source = this.#requireThread(threadId);
    const adapter = this.#requireAdapter(source.harnessId);
    if (!adapter.manifest.capabilities.fork || typeof adapter.fork !== "function") {
      throw new Error(`${adapter.manifest.name} 的原生接口暂不支持 Fork`);
    }
    if (source.status === "working") throw new Error("任务执行中，请等待完成后再 Fork");
    if (source.status === "opening") throw new Error("任务正在连接 Harness，请稍后");
    const emit = (event) => this.#applyEvent(event);
    const { session, nativeSessionId } = await adapter.fork(source, {
      emit: (event) => emit({ threadId: "__fork__", event }), // Fork 期间事件直接丢弃（尚无线程归属）
      diagnostic: () => {},
    });
    const thread = {
      id: randomUUID(), harnessId: source.harnessId, title: `${source.title} · Fork`, cwd: source.cwd,
      nativeSessionId, status: "ready",
      // IDs are scoped to a thread; clone together to retain tool references.
      messages: structuredClone(source.messages.filter((m) => !m.streaming)),
      tools: structuredClone(source.tools ?? []),
      pendingApprovals: [], createdAt: Date.now(), forkedFrom: source.id, restore: false,
    };
    this.threads.unshift(thread);
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
    for (const monitor of this.reviewMonitors.values()) { monitor.closed = true; clearInterval(monitor.timer); }
    this.reviewMonitors.clear();
    for (const session of this.sessions.values()) await session.adapter.close(session).catch(() => {});
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
    await this.#open(thread, adapter);
    return this.sessions.get(thread.id);
  }

  async #open(thread, adapter) {
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
      thread.status = "ready";
      delete thread.error;
      this.sessions.set(thread.id, { adapter, ...session, threadId: thread.id });
      delete thread.restore;
    } catch (error) {
      thread.status = "error";
      thread.error = thread.restore ? `原生会话恢复失败：${error.message}` : error.message;
    }
    await this.#save();
    this.#broadcast();
  }

  /** 统一事件投影：Adapter 转换后的标准事件落到线程模型上 */
  #applyEvent({ threadId, event }) {
    if (!event) return;
    if (threadId === "__fork__") return;
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const last = thread.messages.at(-1);
    let structural = true;
    switch (event.kind) {
      case "text-delta": {
        const target = last?.role === "assistant" && last.streaming ? last : this.#appendAssistant(thread);
        target.text += event.text;
        appendDelta(target, 'text', event.text);
        structural = false;
        break;
      }
      case "thinking-delta": {
        const target = last?.role === "assistant" && last.streaming ? last : this.#appendAssistant(thread);
        target.thinking = (target.thinking ?? "") + event.text;
        appendDelta(target, 'thinking', event.text);
        structural = false;
        break;
      }
      case "tool": {
        const target = last?.role === 'assistant' && last.streaming ? last : this.#appendAssistant(thread);
        projectTool(thread, target, event);
        break;
      }
      case "artifact": {
        // 各 Harness 返回的图片 / 文件产物：挂到当前 assistant 消息上，Renderer 统一渲染
        const a = event.artifact;
        if (!a || typeof a !== "object") break;
        const target = last?.role === "assistant" ? last : this.#appendAssistant(thread);
        target.artifacts ??= [];
        if (target.artifacts.some((x) => x.id === a.id)) break;
        target.artifacts.push({
          id: a.id ?? randomUUID(),
          type: a.type === "image" ? "image" : "file",
          name: String(a.name ?? a.uri ?? "产物").slice(0, 120),
          mime: typeof a.mime === "string" ? a.mime : undefined,
          uri: typeof a.uri === "string" ? a.uri : undefined,
          data: typeof a.data === "string" && a.data.length <= 5_500_000 ? a.data : undefined,
        });
        break;
      }
      case "approval":
        thread.pendingApprovals ??= [];
        if (!thread.pendingApprovals.some((a) => a.requestId === event.requestId)) {
          thread.pendingApprovals.push({ requestId: event.requestId, method: event.method, title: event.title, message: event.message, options: event.options, placeholder: event.placeholder, at: Date.now() });
        }
        break;
      case "usage":
        thread.usage = { ...thread.usage, ...event.usage };
        structural = false;
        break;
      case "session":
        if (event.nativeSessionId) thread.nativeSessionId = event.nativeSessionId;
        if (event.model) thread.model = event.model;
        break;
      case "status":
        this.#notify("status", event.text, threadId);
        return;
      case "notice":
        this.#notify(event.level ?? "info", event.text);
        return;
      case "completed": {
        finishMessage(thread, last, event.stopReason ?? 'completed');
        thread.updatedAt = Date.now();
        this.#refreshContextUsage(thread);
        void this.#settleReview(thread, last, 'ready');
        break;
      }
      case "error": {
        thread.error = event.message;
        finishMessage(thread, last, 'error');
        void this.#settleReview(thread, last, 'error');
        break;
      }
      default:
        return;
    }
    if (structural) {
      void this.#save();
      this.#broadcast();
    } else {
      this.#saveSoon();
      this.#broadcastSoon();
    }
  }

  #appendAssistant(thread) {
    const message = { id: randomUUID(), role: "assistant", text: "", at: Date.now(), streaming: true };
    thread.messages.push(message);
    return message;
  }

  async #settleReview(thread, message, status) {
    if (this.settlements.has(thread.id)) return;
    this.settlements.add(thread.id);
    const monitor = this.reviewMonitors.get(thread.id);
    if (monitor) { monitor.closed = true; clearInterval(monitor.timer); this.reviewMonitors.delete(thread.id); }
    thread.reviewPending = true;
    try {
      if (message?.reviewId) message.review = await this.reviews.finish(message.reviewId);
      if (message?.review) this.emitReviewUpdate(thread, message, message.review);
    } catch (e) { if (message) message.reviewError = '文件审查暂不可用：' + e.message; }
    finally {
      thread.reviewPending = false;
      thread.status = status;
      this.settlements.delete(thread.id);
      await this.#save(); this.#broadcast();
    }
  }

  reviewMessage(threadId, messageId) {
    const thread = this.#requireThread(threadId);
    const message = thread.messages.find(m => m.id === messageId);
    if (!message?.review) throw Error('该轮没有可审查的文件快照（旧历史无法补建）');
    return { thread, message };
  }

  // The UI subscribes to a turn-scoped event; workspace snapshots stay in Main.
  startReviewUpdates(thread, message) {
    if (!message.reviewId || this.reviewMonitors.has(thread.id)) return;
    const monitor = { busy: false, closed: false };
    const tick = async () => {
      if (monitor.closed || monitor.busy || !message.streaming) return;
      monitor.busy = true;
      try {
        const review = this.reviews.summary(await this.reviews.preview(message.reviewId));
        if (!monitor.closed && message.streaming) {
          message.liveReview = review;
          this.emitReviewUpdate(thread, message, review);
        }
      } catch (e) {
        if (!monitor.closed) for (const listener of this.listeners) listener({ type: 'turn/diff/updated', threadId: thread.id, turnId: message.id, error: e.message });
      } finally { monitor.busy = false; }
    };
    monitor.timer = setInterval(() => void tick(), 2000);
    monitor.timer.unref?.();
    this.reviewMonitors.set(thread.id, monitor);
    void tick();
  }

  emitReviewUpdate(thread, message, review) {
    for (const listener of this.listeners) listener({ type: 'turn/diff/updated', threadId: thread.id, turnId: message.id, review });
  }

  async undoFile(threadId, messageId, file) {
    const { thread, message } = this.reviewMessage(threadId, messageId);
    const record = await this.reviews.load(message.review.id);
    if ((await fs.realpath(thread.cwd)).toLowerCase() !== record.root.toLowerCase()) throw Error('任务目录已移动，禁止从新目录撤回旧项目文件');
    if (this.threads.some(t => t.cwd.toLowerCase() === thread.cwd.toLowerCase() && t.status === 'working')) throw Error('项目任务执行中，不能撤回');
    message.review = await this.reviews.undo(message.review.id, file);
    await this.#save(); this.#broadcast();
    return message.review;
  }

  /** 回合结束后向原生程序拉取权威上下文占用（Pi get_session_stats；DSH 由 usage_update 实时推送） */
  #refreshContextUsage(thread) {
    const session = this.sessions.get(thread.id);
    if (!session || typeof session.adapter.getContextUsage !== "function") return;
    session.adapter.getContextUsage(session).then((usage) => {
      if (!usage) return;
      thread.usage = { ...thread.usage, ...usage };
      this.#saveSoon();
      this.#broadcastSoon();
    }).catch(() => {});
  }

  #notify(level, text, threadId) {
    for (const listener of this.listeners) listener({ type: "toast", level, text, threadId });
  }

  #broadcast() {
    for (const listener of this.listeners) listener({ type: "snapshot" });
  }

  #broadcastSoon() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => { this.broadcastTimer = null; this.#broadcast(); }, 120);
  }

  #save() { return this.store.save(this.threads); }

  #saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.#save(); }, 500);
  }
}

module.exports = { HostRuntime };
