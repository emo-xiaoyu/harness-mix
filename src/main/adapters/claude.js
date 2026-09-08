const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { cliSpawn } = require("../host/jsonl");
const { recordNative } = require("../harness-adapter/fixture-recorder");

const manifest = {
  id: "claude",
  name: "Claude Code",
  icon: "claude-color.svg",
  // 完整接入（对齐 codex-host）：官方 Agent SDK query() 常驻双向 stream-json 会话，
  // 审批/提问经 canUseTool 桥接回 Host，中断/模型/权限模式走原生控制协议。
  capabilities: { streaming: true, thinking: true, tools: true, approvals: true, questions: true, models: true, thinkingLevels: false, permissionModes: true, resume: true, fork: true, forkFromMessage: true, compaction: true, usage: true, contextUsage: true },
};

/** Claude Code 原生权限模式（SDK PermissionMode 全集），与其 TUI/Desktop 一致 */
const CLAUDE_PERMISSION_MODES = [
  { id: "default", label: "默认（询问）", hint: "编辑和其他受保护操作前询问" },
  { id: "plan", label: "规划模式", hint: "探索并制定计划；批准计划后退出规划" },
  { id: "acceptEdits", label: "接受编辑", hint: "允许文件编辑；其他受保护操作前询问" },
  { id: "auto", label: "自动模式", hint: "由 Claude 判断权限请求" },
  { id: "dontAsk", label: "免询问", hint: "跳过权限询问（非绕过检查）" },
  { id: "bypassPermissions", label: "绕过权限", hint: "跳过全部权限检查，谨慎使用", danger: true },
];

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const value = input.command ?? input.file_path ?? input.pattern ?? input.description ?? Object.values(input)[0];
  return typeof value === "string" ? value.split("\n")[0].slice(0, 120) : "";
}

/** Claude stream-json 单行事件 → 统一事件（纯映射，运行时与 fixture 回放共用） */
function projectEvent(event) {
  const out = [];
  if (event.type === "system" && event.subtype === "init" && event.session_id) {
    out.push({ kind: "session", nativeSessionId: event.session_id });
  } else if (event.type === "system" && event.subtype === "api_retry") {
    out.push({ kind: "status", text: `Claude 模型限流（${event.error_status ?? ""}），重试 ${event.attempt}/${event.max_retries}…` });
  } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
    out.push({ kind: 'text-delta', text: '上下文已由 Claude Code 压缩。' });
  } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type === "thinking" && block.thinking) out.push({ kind: "thinking-delta", text: block.thinking, nativeRef: { sessionId: event.session_id, itemId: event.message.id } });
      if (block.type === "text" && block.text) out.push({ kind: "text-delta", text: block.text, nativeRef: { sessionId: event.session_id, itemId: event.message.id } });
      if (block.type === "tool_use") out.push({ kind: "tool", toolCallId: block.id, title: block.name || "工具", state: "done", detail: summarizeInput(block.input) });
    }
  } else if (event.type === "user" && Array.isArray(event.message?.content)) {
    const result = event.tool_use_result;
    if (result?.filePath && typeof result.content === 'string' && (result.type === 'create' || typeof result.originalFile === 'string')) {
      out.push({ kind: 'file-change', source: 'native', changes: [{ path: result.filePath,
        before: result.originalFile ?? '', after: result.content, complete: true,
        changeType: result.type === 'create' ? 'added' : 'modified',
        nativeRef: { sessionId: event.session_id, toolCallId: event.message.content.find(b => b.tool_use_id)?.tool_use_id },
      }] });
    }
    // 工具结果中的图片 → 统一 artifact 投影（与其他 Harness 对齐）
    for (const block of event.message.content) {
      if (block?.type !== "tool_result") continue;
      const parts = Array.isArray(block.content) ? block.content : [];
      parts.forEach((part, i) => {
        if (part?.type === "image" && part.source?.type === "base64" && typeof part.source.data === "string") {
          out.push({ kind: "artifact", artifact: { id: `${block.tool_use_id ?? "claude"}-img-${i}`, type: "image", name: "图片", mime: part.source.media_type || "image/png", data: part.source.data.length <= 5_000_000 ? part.source.data : undefined } });
        }
      });
    }
  } else if (event.type === "result") {
    const usage = usageFromResult(event);
    if (usage) out.push({ kind: "usage", usage });
    if (event.is_error || event.subtype !== "success") out.push({ kind: "error", message: event.result || `Claude 执行失败（${event.subtype ?? "error"}）` });
    out.push({ kind: "completed", finalAnswer: !event.is_error && event.subtype === "success" });
  }
  return out.map(mapped => ({ ...mapped, nativeRef: {
    sessionId: event.session_id, itemId: event.message?.id,
    ...(mapped.toolCallId ? { toolCallId: mapped.toolCallId } : {}), ...mapped.nativeRef,
  } }));
}

/** result 事件 → 上下文用量（官方 modelUsage.contextWindow 为权威窗口大小） */
function usageFromResult(event) {
  const usage = event?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const models = Object.values(event.modelUsage ?? {});
  const window = models.find((m) => Number.isFinite(m?.contextWindow))?.contextWindow ?? null;
  const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (!tokens && !window) return undefined;
  return {
    tokens: tokens || null,
    contextWindow: window,
    contextPercent: tokens && window ? 100 * tokens / window : null,
  };
}

/** canUseTool → Host 审批卡片；AskUserQuestion → 选项提问卡片 */
function projectApproval(requestId, toolName, input, suggestions) {
  if (toolName === "AskUserQuestion") {
    const question = (Array.isArray(input?.questions) ? input.questions : [])[0] ?? {};
    return {
      kind: "approval", requestId, method: undefined,
      title: question.header || question.question || "Claude 提问",
      message: question.question,
      options: (Array.isArray(question.options) ? question.options : []).map((o) => ({ id: String(o.label), label: String(o.label), hint: o.description })),
    };
  }
  return {
    kind: "approval", requestId, method: undefined,
    title: `${toolName} 请求权限`,
    message: summarizeInput(input),
    options: [
      { id: "allow", label: "允许" },
      ...(Array.isArray(suggestions) && suggestions.length ? [{ id: "allowAlways", label: "始终允许" }] : []),
      { id: "deny", label: "拒绝", kind: "reject" },
    ],
  };
}

/** 应答 → SDK PermissionResult */
function toPermissionResult(pending, response) {
  const { toolName, input, suggestions } = pending;
  if (response?.cancelled) return { behavior: "deny", message: "用户取消了请求", interrupt: true };
  if (toolName === "AskUserQuestion") {
    const question = (Array.isArray(input?.questions) ? input.questions : [])[0] ?? {};
    const answer = response?.optionId ?? response?.value;
    if (answer == null) return { behavior: "deny", message: "用户未作答" };
    return { behavior: "allow", updatedInput: { ...input, answers: { [question.question ?? "question"]: String(answer) } } };
  }
  const choice = response?.optionId ?? (response?.confirmed === false ? "deny" : "allow");
  if (choice === "deny") return { behavior: "deny", message: "用户拒绝了该操作" };
  if (choice === "allowAlways" && Array.isArray(suggestions) && suggestions.length) {
    return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
  }
  return { behavior: "allow", updatedInput: input };
}

/** SDK streaming-input 消息队列（保持打开，进程生命周期内可连续推送） */
class MessageQueue {
  constructor() { this.items = []; this.waiters = []; this.ended = false; }
  push(message) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }
  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

async function loadSdk() {
  return import("@anthropic-ai/claude-agent-sdk");
}

/** 建立一个常驻 SDK 会话（open 与 fork 共用）：构造 query、启动事件泵 */
function spawnSession(sdk, { cwd, resumeId, permissionMode, modelId, emit }) {
  const input = new MessageQueue();
  const session = {
    nativeSessionId: resumeId,
    cwd,
    permissionMode,
    model: undefined,
    input,
    query: undefined,
    pendingApprovals: new Map(),
    // 注意：runtime 以浅拷贝保存 adapter session（{ adapter, ...session }），
    // 泵写入的可变状态必须放在共享引用的 state 容器内，拷贝内外才一致。
    state: { turn: null, crashed: false, lastUsage: undefined, checkpointId: undefined },
  };

  session.query = sdk.query({
    prompt: input,
    options: {
      cwd,
      ...(resumeId ? { resume: resumeId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(process.env.HARNESS_MIX_CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.HARNESS_MIX_CLAUDE_EXECUTABLE } : {}),
      canUseTool: (toolName, toolInput, { signal, suggestions }) => {
        const requestId = randomUUID();
        emit(projectApproval(requestId, toolName, toolInput, suggestions));
        return new Promise((resolve) => {
          const onAbort = () => {
            session.pendingApprovals.delete(requestId);
            resolve({ behavior: "deny", message: "会话已中断" });
          };
          session.pendingApprovals.set(requestId, { resolve, toolName, input: toolInput, suggestions });
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    },
  });

  // 事件泵：SDK 消息 → 统一事件投影；result 结算当前回合。
  // 注意：system/init 在首个用户消息到达时才发出，open() 不等待 init。
  void (async () => {
    try {
      for await (const event of session.query) {
        recordNative(manifest.id, event);
        if (event.type === "system" && event.subtype === "init") {
          session.nativeSessionId = event.session_id;
          session.model = { id: event.model, name: event.model };
          session.permissionMode = event.permissionMode ?? session.permissionMode;
          emit({ kind: "session", nativeSessionId: event.session_id, model: session.model });
          continue;
        }
        if (event.type === "result") {
          const usage = usageFromResult(event);
          if (usage) session.state.lastUsage = usage;
          session.state.checkpointId = event.user_message_uuid ?? session.state.checkpointId;
          for (const mapped of projectEvent(event)) {
            // 结算事件携带原生检查点（assistant uuid），供 fork 边界定位
            if (mapped.kind === 'completed') mapped.nativeRef = { ...mapped.nativeRef, checkpointId: session.state.checkpointId };
            emit(mapped);
          }
          session.state.turn?.resolve();
          session.state.turn = null;
          continue;
        }
        if (event.type === 'assistant' && event.uuid) session.state.checkpointId = event.uuid;
        for (const mapped of projectEvent(event)) emit(mapped);
      }
      // 流正常结束（close）：未结算的回合按取消处理
      session.state.turn?.resolve();
      session.state.turn = null;
    } catch (error) {
      session.state.crashed = true;
      if (session.state.turn) { session.state.turn.reject(error); session.state.turn = null; }
      else emit({ kind: "error", message: `Claude 会话中断：${error.message}` });
    }
  })();
  return session;
}

/** Claude Code Adapter：官方 Agent SDK 常驻会话，能力事件经统一投影落到线程模型 */
function create() {
  return {
    manifest,

    async inspect() {
      const result = await new Promise((resolve) => {
        const { command, args } = cliSpawn("claude", ["--version"]);
        execFile(command, args, { windowsHide: true }, (error, stdout) => resolve({ ok: !error, stdout }));
      });
      try { await loadSdk(); }
      catch { return { available: false, detail: "缺少 @anthropic-ai/claude-agent-sdk（npm install）" }; }
      return result.ok
        ? { available: true, detail: `claude ${String(result.stdout).trim()} · Agent SDK` }
        : { available: true, detail: "Agent SDK 就绪（内置原生 CLI；未检测到独立 claude 命令）" };
    },

    async open({ thread, emit }) {
      const sdk = await loadSdk();
      return spawnSession(sdk, {
        cwd: thread.cwd,
        resumeId: thread.restore ? thread.nativeSessionId : undefined,
        permissionMode: thread.options?.permissionMode,
        modelId: thread.options?.model?.id,
        emit,
      });
    },

    async send(session, text) {
      if (!session.query || session.state?.crashed) throw new Error("Claude 原生会话不可用");
      await new Promise((resolve, reject) => {
        session.state.turn = { resolve, reject };
        session.input.push({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
          parent_tool_use_id: null,
        });
      });
    },

    async cancel(session) {
      // 原生优雅中断；超时后由 Host 走 close 兜底
      await Promise.race([
        session.query?.interrupt().catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    },

    async listCommands(session) {
      const base = [{ id: 'compact', label: '压缩上下文', description: '由 Claude Code 原生压缩当前会话', action: 'execute' }];
      if (!session?.query) return base;
      try {
        const commands = await session.query.supportedCommands();
        return [
          ...base,
          ...commands.filter((c) => c.name !== 'compact').map((c) => ({
            id: c.name, label: '/' + c.name, description: c.description ?? '', action: 'insert', text: '/' + c.name + ' ',
          })),
        ];
      } catch { return base; }
    },
    async executeCommand(session, id, hooks) {
      if (id !== 'compact') throw new Error('未知 Claude 指令');
      await this.send(session, '/compact', hooks);
    },
    async fork(source, { emit, message }) {
      const sdk = await loadSdk();
      const { forkSession, getSessionMessages } = sdk;
      const history = await getSessionMessages(source.nativeSessionId, { dir: source.cwd });
      let boundary = message?.coreTurn?.nativeTurnRef?.checkpointId;
      if (message && !boundary) {
        const final = message.coreItems?.filter(item => item.phase === 'final').map(item => item.content).join('') || message.text;
        const matches = history.filter(entry => entry.type === 'assistant' && entry.message?.content?.filter(b => b.type === 'text').map(b => b.text).join('') === final);
        if (matches.length !== 1) throw new Error('旧回复无法唯一定位原生记录，不能安全分支');
        boundary = matches[0].uuid;
      }
      if (message && !history.some(entry => entry.uuid === boundary)) throw new Error('未找到该回复的 Claude 原生记录');
      const result = await forkSession(source.nativeSessionId, { dir: source.cwd, upToMessageId: boundary, title: `${source.title} · Fork` });
      const copied = await getSessionMessages(result.sessionId, { dir: source.cwd });
      const checkpointMap = Object.fromEntries(copied.map((entry, index) => [history[index].uuid, entry.uuid]));
      // Fork 出的新原生会话立即拉起常驻进程（resume 到新 sessionId），与 open() 同路径
      const session = spawnSession(sdk, {
        cwd: source.cwd,
        resumeId: result.sessionId,
        permissionMode: source.options?.permissionMode,
        emit,
      });
      return { checkpointMap, session };
    },

    async listModelsFor(session) {
      if (!session?.query) return null;
      try {
        const models = await session.query.supportedModels();
        session.models = models.map((m) => ({ id: m.value, name: m.displayName || m.value, description: m.description, resolved: m.resolvedModel }));
        return session.models;
      } catch { return null; }
    },
    async setModel(session, model) {
      await session.query?.setModel(model.id);
      session.model = { id: model.id, name: model.name ?? model.id };
      return session.model;
    },
    async setPermissionMode(session, mode) {
      session.permissionMode = mode;
      await session.query?.setPermissionMode(mode);
    },
    async describe() {
      // 目录探测需常驻会话；模型目录在会话打开后经 listModelsFor 获取，这里只声明权限模式
      return { models: null, thinkingLevels: null, permissionModes: CLAUDE_PERMISSION_MODES };
    },
    async describeFor(session) {
      const models = await this.listModelsFor(session);
      return { models, thinkingLevels: null, permissionModes: CLAUDE_PERMISSION_MODES };
    },

    async getContextUsage(session) { return session.state?.lastUsage; },

    async respond(session, requestId, response) {
      const pending = session.pendingApprovals.get(requestId);
      if (!pending) return;
      session.pendingApprovals.delete(requestId);
      pending.resolve(toPermissionResult(pending, response));
    },

    async close(session) {
      for (const pending of session.pendingApprovals?.values() ?? []) {
        pending.resolve({ behavior: "deny", message: "会话已关闭" });
      }
      session.pendingApprovals?.clear();
      session.input?.end();
      try { session.query?.close(); } catch { /* already gone */ }
    },
  };
}

module.exports = { manifest, create, projectEvent };
