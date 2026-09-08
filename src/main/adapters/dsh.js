const { randomUUID } = require("node:crypto");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DshWebHost, DSH_ROOT } = require("./dsh-web-host");
const { recordNative } = require("../harness-adapter/fixture-recorder");

const manifest = {
  id: "dsh",
  name: "DeepSeek Harness",
  icon: "deepseek-color.svg",
  // 完整接入（对齐 codex-host）：官方 Web Remote 协议（Typert RPC + remote.mux 流），
  // 审批/提问走 $events waterfall 原生应答；ACP 自动化面（无 fork/提问/plan）已弃用。
  capabilities: { plan: true, streaming: true, thinking: true, tools: true, approvals: true, questions: true, models: true, thinkingLevels: true, permissionModes: false, resume: true, fork: true, forkFromMessage: true, compaction: true, usage: true, contextUsage: true },
};

const MAX_TOOL_TEXT = 24_000;

function textValue(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value.slice(0, MAX_TOOL_TEXT);
  try { return JSON.stringify(value, null, 2).slice(0, MAX_TOOL_TEXT); }
  catch { return String(value).slice(0, MAX_TOOL_TEXT); }
}

/** ToolResultMessage → 首个 tool-result 块（callId/文本/isError） */
function toolResultBlock(message) {
  const block = (Array.isArray(message?.content) ? message.content : []).find((b) => b?.type === "tool-result");
  if (!block) return undefined;
  const text = (Array.isArray(block.content) ? block.content : [])
    .map((c) => (c?.type === "text" ? c.text : c?.text)).filter(Boolean).join("\n").trim();
  return { toolCallId: block.toolCallId ?? message?.source?.callId, text: text ? text.slice(0, MAX_TOOL_TEXT) : undefined, isError: Boolean(block.isError) };
}

function summarizeArguments(raw) {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const input = JSON.parse(raw);
    const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? Object.values(input)[0];
    return typeof value === "string" ? value.split("\n")[0].slice(0, 120) : "";
  } catch { return raw.split("\n")[0].slice(0, 120); }
}

function flattenCatalog(catalog) {
  const models = [];
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      models.push({
        id: model.id, name: model.name || model.id, provider: group.id, description: model.description,
        efforts: Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts.map((e) => ({ id: e.id, label: e.name || e.id, hint: e.description })) : undefined,
        defaultEffort: model.reasoning?.defaultEffort,
      });
    }
  }
  return models;
}

function selectionOf(projections) {
  const value = projections?.values?.modelSelection;
  const current = value?.next ?? value?.lastUsed;
  return current ? { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort } : undefined;
}

/**
 * SessionWireEvent（session/follow 帧）→ 统一事件投影（纯映射，运行时与 fixture 回放共用）。
 * session 参数用于跨事件积累（上下文窗口、检查点 seq），投影本身不写 Host 状态。
 */
function projectWireEvent(frame, session) {
  const out = [];
  const enrich = (value) => ({ ...value, nativeRef: { sessionId: session?.nativeSessionId, ...(value.toolCallId ? { toolCallId: value.toolCallId } : {}), ...(value.nativeRef ?? {}) } });
  if (!frame || frame.type !== "event") return out;
  const event = frame.event;
  const data = event?.data ?? {};
  const base = { seq: event.seq };
  switch (event?.type) {
    case "assistant/chunk": {
      const chunk = data.chunk;
      if (!chunk) break;
      if (chunk.type === "text-delta" && chunk.text) out.push({ kind: "text-delta", text: chunk.text });
      else if (chunk.type === "reasoning-delta" && chunk.text) out.push({ kind: "thinking-delta", text: chunk.text });
      else if (chunk.type === "usage" && chunk.usage) {
        const usage = usageFrom(chunk.usage, session?.state?.contextWindow);
        if (usage) out.push({ kind: "usage", usage });
      }
      break;
    }
    // assistant/message 为已提交消息：文本/思考已经由 chunk 增量投影，这里只记录检查点与用量
    case "assistant/message": {
      if (session) session.state.checkpointSeq = event.seq;
      const usage = usageFrom(data.usage, session?.state?.contextWindow);
      if (usage) out.push({ kind: "usage", usage });
      break;
    }
    case "tool/call":
      out.push({ kind: "tool", toolCallId: data.callId, title: data.name || "DSH 工具", state: "running", detail: summarizeArguments(data.arguments), input: textValue(data.arguments) });
      break;
    case "tool/result": {
      const result = toolResultBlock(data.message);
      out.push({
        kind: "tool", toolCallId: result?.toolCallId, state: (data.error || result?.isError) ? "error" : "done",
        output: result?.text ?? (data.error ? `${data.error.name}: ${data.error.code}` : undefined),
      });
      break;
    }
    case "request/context":
      if (session && Number.isFinite(data.contextWindow)) session.state.contextWindow = data.contextWindow;
      if (data.model) {
        const model = { id: data.model, name: data.model, provider: data.provider };
        if (session) {
          session.state.selection = { provider: data.provider, model: data.model, reasoningEffort: session.state.selection?.reasoningEffort };
          session.model = model;
        }
        out.push({ kind: "session", model });
      }
      break;
    case "model/selection":
      if (data.selection ?? data.next) {
        const sel = data.selection ?? data.next;
        if (session) session.state.selection = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort };
        out.push({ kind: "session", model: { id: sel.model, name: sel.model, provider: sel.provider } });
      }
      break;
    case "todo/write":
      out.push({ kind: "plan", entries: data.todos ?? data.entries ?? [] });
      break;
    case "compaction/start":
      out.push({ kind: "status", text: "DSH 正在压缩上下文…" });
      break;
    case "compaction/end":
    case "compaction/summary":
      out.push({ kind: "status", text: "DSH 上下文压缩完成。" });
      break;
    case "turn/end": {
      const reason = data.reason?.kind ?? "completed";
      if (reason === "error" || data.reason?.error) out.push({ kind: "error", message: data.reason?.error?.message ?? data.reason?.message ?? "DSH 回合失败" });
      out.push({
        kind: "completed",
        finalAnswer: reason === "completed",
        stopReason: reason === "interrupted" || reason === "cancelled" ? "cancelled" : "completed",
        ...(session?.state?.checkpointSeq != null ? { nativeRef: { checkpointId: String(session.state.checkpointSeq) } } : {}),
      });
      break;
    }
    default:
      break;
  }
  return out.map((mapped) => enrich({ ...base, ...mapped, nativeRef: { ...mapped.nativeRef } }));
}

function usageFrom(usage, contextWindow) {
  if (!usage) return undefined;
  const tokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) || null;
  if (!tokens && !contextWindow) return undefined;
  return { tokens, contextWindow: contextWindow ?? null, contextPercent: tokens && contextWindow ? 100 * tokens / contextWindow : null };
}

/** approval/request waterfall → Host 审批卡片 */
function projectApproval(frame, sessionId) {
  const request = frame.request ?? {};
  return {
    kind: "approval", requestId: `dsh-${frame.eventId}`,
    title: `${request.toolName ?? "工具"} 请求权限`,
    message: request.reason,
    options: [
      { id: "allowed-once", label: "允许" },
      { id: "rejected", label: "拒绝", kind: "reject" },
    ],
    nativeRef: { sessionId, interactionId: String(frame.eventId) },
  };
}

/** user-questions/request waterfall → 提问卡片（首个问题；多问题 v1 顺序展示第一题） */
function projectQuestion(frame, sessionId) {
  const question = (Array.isArray(frame.request?.questions) ? frame.request.questions : [])[0] ?? {};
  const options = Array.isArray(question.options) ? question.options : [];
  return {
    kind: "approval", requestId: `dsh-${frame.eventId}`,
    method: options.length ? undefined : "input",
    title: question.header || question.question || "DSH 提问",
    message: question.detail ?? (options.length ? question.question : undefined),
    placeholder: options.length ? undefined : "请输入…",
    options: options.map((o) => ({ id: String(o.label), label: String(o.label), hint: o.description })),
    nativeRef: { sessionId, interactionId: String(frame.eventId) },
  };
}

/** DeepSeek Harness Adapter：dsh web（Web Remote）常驻宿主，会话/工具/权限全归原生 DSH */
function create() {
  return {
    manifest,

    async inspect() {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(DSH_ROOT, "package.json"), "utf8"));
        if (typeof pkg.scripts?.dsh !== "string") throw new Error("根 package.json 未声明 dsh 脚本");
        await fs.stat(path.join(DSH_ROOT, "node_modules"));
        return { available: true, detail: `原生 Web Remote · ${DSH_ROOT}` };
      } catch (error) {
        return { available: false, detail: `DSH 原生运行时不可用（${DSH_ROOT}）：${error.message}；可用 HARNESS_MIX_DSH_ROOT 指定` };
      }
    },

    async open({ thread, emit: emitEvent, diagnostic }) {
      const host = await DshWebHost.acquire(diagnostic);
      const session = {
        host,
        nativeSessionId: thread.restore ? thread.nativeSessionId : undefined,
        cwd: thread.cwd,
        model: undefined,
        models: undefined,
        thinkingLevels: undefined,
        pendingApprovals: new Map(),
        // runtime 浅拷贝 session：泵写入的可变状态放共享 state 容器
        state: { turn: null, usage: undefined, contextWindow: undefined, checkpointSeq: undefined, selection: undefined },
        unwatch: undefined,
        cancelFollow: undefined,
      };

      const failTurn = (error) => {
        if (session.state.turn) { session.state.turn.reject(error); session.state.turn = null; }
        for (const pending of session.pendingApprovals.values()) pending.reject(error);
        session.pendingApprovals.clear();
      };

      // restore：直接 follow 既有原生会话；否则 session/create 新建
      if (!session.nativeSessionId) {
        const created = await host.call("session/create", { request: { cwd: thread.cwd } });
        session.nativeSessionId = created.sessionId;
      }
      const sessionId = session.nativeSessionId;

      // 审批/提问 waterfall 路由（agentId = sessionId）
      session.unwatch = host.onEvent((frame) => {
        if (frame?.type === "closed") { failTurn(new Error("dsh web 连接已断开")); return; }
        if (frame?.type !== "waterfall" || frame.agentId !== sessionId) return;
        recordNative(manifest.id, frame);
        const requestId = `dsh-${frame.eventId}`;
        const isQuestion = frame.event === "user-questions/request";
        if (frame.event !== "approval/request" && !isQuestion) return;
        emitEvent(isQuestion ? projectQuestion(frame, sessionId) : projectApproval(frame, sessionId));
        session.pendingApprovals.set(requestId, { eventId: frame.eventId, isQuestion, question: frame.request?.questions?.[0] });
      });

      // 会话跟随流：快照（投影基线）+ 实时事件
      let snapshotSeen;
      const snapshotReady = new Promise((resolve) => { snapshotSeen = resolve; });
      session.cancelFollow = host.openStream("session/follow", {
        request: { address: { kind: "session", sessionId } },
      }, {
        onItem: (value) => {
          recordNative(manifest.id, value);
          if (value?.type === "snapshot") {
            const sel = selectionOf(value.projections);
            if (sel) {
              session.state.selection = sel;
              session.model = { id: sel.model, name: sel.model, provider: sel.provider };
              emitEvent({ kind: "session", nativeSessionId: sessionId, model: session.model });
            } else {
              emitEvent({ kind: "session", nativeSessionId: sessionId });
            }
            snapshotSeen();
            return;
          }
          for (const mapped of projectWireEvent(value, session)) {
            emitEvent(mapped);
            if (mapped.kind === "completed") {
              session.state.turn?.resolve();
              session.state.turn = null;
            }
          }
        },
        onError: (error) => {
          failTurn(error);
          emitEvent({ kind: "error", message: `DSH 会话流中断：${error.message}` });
        },
      });

      // 等首帧快照，让 open() 返回时即带有原生模型选择（超时无害，快照后续仍会到达）
      await Promise.race([snapshotReady, new Promise((r) => setTimeout(r, 15_000))]);

      // 草稿期选择的模型/思考档位：经原生 selectModel 应用（失败静默）
      const wanted = thread.options?.model;
      const current = session.state.selection;
      if (wanted?.provider && wanted.id && (wanted.provider !== current?.provider || wanted.id !== current?.model)) {
        await host.call("session/selectModel", { request: { sessionId, provider: wanted.provider, model: wanted.id, reasoningEffort: thread.options.thinking } }).catch(() => {});
      } else if (thread.options?.thinking && current?.provider) {
        await host.call("session/selectModel", { request: { sessionId, provider: current.provider, model: current.model, reasoningEffort: thread.options.thinking } }).catch(() => {});
      }
      return session;
    },

    async send(session, text, hooks) {
      // 官方 slash 命令通道：/compact 由 commands/execute 原生执行（同 DSH Web UI），不进模型
      if (text.trim() === "/compact" && hooks?.emit) return this.executeCommand(session, "compact", hooks);
      // Web Remote：prompt 立即 accepted；回合结算以 turn/end 事件为准
      await new Promise((resolve, reject) => {
        session.state.turn = { resolve, reject };
        session.host.call("session/prompt", {
          request: { requestId: randomUUID(), sessionId: session.nativeSessionId, mode: "queue", content: [{ type: "text", text }] },
        }).catch((error) => {
          session.state.turn = null;
          reject(error);
        });
      });
    },

    async cancel(session) {
      await session.host.call("session/cancel", { request: { sessionId: session.nativeSessionId } }).catch(() => {});
    },

    async listCommands() {
      return [{ id: "compact", label: "压缩上下文", description: "由 DSH 原生总结并压缩当前会话", action: "execute" }];
    },
    async executeCommand(session, id, { emit }) {
      if (id !== "compact") throw new Error("未知 DSH 指令");
      const execution = await session.host.call("commands/execute", { agentId: session.nativeSessionId, line: "/compact", images: [] });
      if (execution?.result?.kind === "error") throw new Error(execution.result.text ?? "DSH 压缩失败");
      emit({ kind: "text-delta", text: execution?.result?.text || "上下文已由 DSH 压缩。" });
      emit({ kind: "completed", finalAnswer: true });
    },

    async listModelsFor(session) {
      const catalog = await session.host.call("session/modelCatalog", {});
      session.models = flattenCatalog(catalog);
      return session.models;
    },

    async describe() {
      const host = await DshWebHost.acquire(() => {});
      try {
        const catalog = await host.call("session/modelCatalog", {});
        const models = flattenCatalog(catalog);
        const current = models.find((m) => m.provider === catalog.default?.provider && m.id === catalog.default?.model) ?? models[0];
        return { models, thinkingLevels: current?.efforts ?? null, permissionModes: [] };
      } finally {
        DshWebHost.release();
      }
    },

    async describeFor(session) {
      const models = await this.listModelsFor(session);
      const current = models?.find((m) => m.provider === session.state?.selection?.provider && m.id === session.state?.selection?.model)
        ?? models?.find((m) => m.id === session.model?.id);
      return { models, thinkingLevels: current?.efforts ?? null, permissionModes: [] };
    },

    async setModel(session, model) {
      await session.host.call("session/selectModel", {
        request: { sessionId: session.nativeSessionId, provider: model.provider, model: model.id, reasoningEffort: session.state?.selection?.reasoningEffort },
      });
      session.model = { id: model.id, name: model.name ?? model.id, provider: model.provider };
      session.state.selection = { provider: model.provider, model: model.id, reasoningEffort: session.state?.selection?.reasoningEffort };
      return session.model;
    },

    async setThinkingLevel(session, level) {
      const sel = session.state?.selection ?? session.model;
      if (!sel?.provider) throw new Error("DSH 当前模型未知，无法设置思考档位");
      await session.host.call("session/selectModel", {
        request: { sessionId: session.nativeSessionId, provider: sel.provider, model: sel.model ?? sel.id, reasoningEffort: level },
      });
      session.state.selection = { provider: sel.provider, model: sel.model ?? sel.id, reasoningEffort: level };
    },

    async getContextUsage(session) { return session.state?.usage; },

    /** 审批/提问应答：$events/result 原生回执 */
    async respond(session, requestId, response) {
      const pending = session.pendingApprovals.get(requestId);
      if (!pending) return;
      session.pendingApprovals.delete(requestId);
      let outcome;
      if (pending.isQuestion) {
        const answer = response?.optionId ?? response?.value;
        outcome = response?.cancelled
          ? { kind: "rejected", error: { name: "Error", message: "用户取消" } }
          : { kind: "result", value: { answers: [{ id: pending.question?.id ?? "question", selected: answer != null && pending.question?.options?.length ? [String(answer)] : [], ...(answer != null && !pending.question?.options?.length ? { custom: String(answer) } : {}) }] } };
      } else {
        const value = response?.cancelled ? "cancelled" : response?.optionId ?? (response?.confirmed === false ? "rejected" : "allowed-once");
        outcome = { kind: "result", value };
      }
      await session.host.answerWaterfall(pending.eventId, outcome);
    },

    /** 任务 Fork：原生 session/fork（ACP 面不支持的能力），atSeq 定位分支边界 */
    async fork(source, { emit, diagnostic, message }) {
      const host = await DshWebHost.acquire(diagnostic);
      try {
        const atSeq = message?.coreTurn?.nativeTurnRef?.checkpointId;
        const request = { sessionId: source.nativeSessionId };
        if (atSeq != null) request.atSeq = Number(atSeq);
        const result = await host.call("session/fork", { request });
        // 新会话立即建立跟随流（与 open() 同路径），交由 runtime 登记
        const session = await this.open({ thread: { cwd: source.cwd, restore: true, nativeSessionId: result.sessionId, options: source.options }, emit, diagnostic });
        return { session };
      } finally {
        DshWebHost.release();
      }
    },

    async close(session) {
      for (const pending of session.pendingApprovals?.values() ?? []) pending.reject(new Error("会话已关闭"));
      session.pendingApprovals?.clear();
      try { session.cancelFollow?.(); } catch { /* 已断开 */ }
      try { session.unwatch?.(); } catch { /* 已断开 */ }
      await DshWebHost.release();
    },
  };
}

module.exports = { manifest, create, projectWireEvent, flattenCatalog };
