const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { cliSpawn } = require("../host/jsonl");
const { OpenClawGatewayHost, readGatewayConfig } = require("./openclaw-gateway");
const { recordNative } = require("../harness-adapter/fixture-recorder");

// 静态思考档位仅作兜底；会话级权威目录来自 sessions.describe（thinkingLevels/thinkingDefault，随模型而变）
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"];
const AGENT_TIMEOUT_MS = 600_000; // 与 openclaw agent --timeout 默认值一致

const manifest = {
  id: "openclaw",
  name: "OpenClaw",
  icon: "openclaw-color.svg",
  aliases: ["openclaw"],
  // 能力均按 Gateway 2026.5.12 实测声明；未逐字段验证的面（reasoning 流/plan/patch/图片）不声明。
  // usage/contextUsage 取自 sessions.describe 的原生 token 统计与上下文窗口，不用累计输入量伪装。
  capabilities: { streaming: true, thinking: false, tools: true, approvals: true, questions: false, models: true, thinkingLevels: true, permissionModes: false, resume: true, fork: false, forkFromMessage: false, compaction: false, usage: true, contextUsage: true, attachments: true },
};

const textOfContent = (result) => (result?.content ?? []).map((c) => (c?.type === "text" ? c.text : "")).filter(Boolean).join("\n");
const stringifyArgs = (args) => {
  if (args == null) return undefined;
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
};

/**
 * Gateway agent 广播事件（{runId, stream, data, sessionKey, seq, ts}）→ 统一事件投影。
 * 纯映射（运行时与 fixture 回放共用）；session 仅用于跨事件累积（assistant 累计文本、生命周期错误）。
 * item/plan/patch/approval/compaction 流形态未逐字段实测，v1 只投影已验证的流，不伪造。
 */
function projectAgentEvent(payload, session) {
  const out = [];
  if (!payload || typeof payload !== "object") return out;
  const data = payload.data ?? {};
  switch (payload.stream) {
    case "assistant": {
      let delta = typeof data.delta === "string" ? data.delta : "";
      if (!delta && typeof data.text === "string") {
        // 缺 delta 时按累计文本差分补齐
        const last = session?.state?.lastAssistantText ?? "";
        delta = data.text.startsWith(last) ? data.text.slice(last.length) : data.text;
      }
      if (typeof data.text === "string" && session) session.state.lastAssistantText = data.text;
      if (delta) out.push({ kind: "text-delta", text: delta });
      break;
    }
    case "tool": {
      if (!data.toolCallId) break;
      const title = data.meta ? `${data.name ?? "tool"} ${data.meta}` : (data.name ?? "tool");
      if (data.phase === "start") {
        out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: "running", input: stringifyArgs(data.args) });
      } else if (data.phase === "update") {
        const output = textOfContent(data.partialResult);
        if (output) out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: "running", output });
      } else if (data.phase === "result") {
        out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: data.isError ? "error" : "done", output: textOfContent(data.result) || (data.isError ? "原生工具执行失败" : undefined) });
      }
      break;
    }
    case "command_output": {
      // 命令输出与工具卡片同一投影（toolCallId 归并）：delta 增量输出，end 携带退出码收尾
      if (!data.toolCallId) break;
      const title = data.title || data.name || "command";
      if (data.phase === "delta") {
        if (typeof data.output === "string" && data.output) out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: "running", output: data.output });
      } else if (data.phase === "end") {
        out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: data.status === "completed" ? "done" : "error", output: data.output, detail: data.exitCode != null ? `exit ${data.exitCode}` : undefined });
      }
      break;
    }
    case "lifecycle": {
      if (session && data.phase === "error") session.state.lastError = typeof data.error === "string" ? data.error : data.error?.message;
      break;
    }
    default:
      break;
  }
  return out;
}

/** exec/plugin 审批请求广播 → 统一 approval 事件 */
function projectApproval(eventName, payload, sessionKey) {
  const id = String(payload?.id ?? "");
  const request = payload?.request ?? {};
  const isPlugin = eventName.startsWith("plugin.") || id.startsWith("plugin:");
  const lines = [];
  if (request.command) lines.push(`\`${request.command}\``);
  if (request.cwd) lines.push(`工作目录：${request.cwd}`);
  if (request.ask) lines.push(`原因：${request.ask}`);
  return {
    kind: "approval",
    requestId: `openclaw-${id}`,
    title: isPlugin ? "插件权限审批" : "命令执行审批",
    message: lines.join("\n") || undefined,
    options: [
      { id: "allowed-once", label: "允许一次" },
      { id: "allowed-always", label: "始终允许" },
      { id: "rejected", label: "拒绝", kind: "reject" },
    ],
    nativeRef: { sessionId: sessionKey, interactionId: id },
  };
}

/** sessions.describe 行 → 会话状态（生效模型、思考档位目录与当前值、原生用量）。字段随 turn 推进逐渐齐备。 */
function applySessionDescription(session, row) {
  if (!row || typeof row !== "object") return;
  if (Array.isArray(row.thinkingLevels) && row.thinkingLevels.length) {
    session.state.thinkingLevels = row.thinkingLevels.map((l) => ({ id: String(l.id ?? l), label: String(l.label ?? l.id ?? l) }));
  }
  if (typeof row.thinkingDefault === "string") session.state.thinkingDefault = row.thinkingDefault;
  if (row.model) {
    const id = row.modelProvider ? `${row.modelProvider}/${row.model}` : String(row.model);
    session.model = session.models?.find((m) => m.id === id) ?? { id, name: String(row.model), provider: row.modelProvider };
  }
  if (Number.isFinite(row.totalTokens) && Number.isFinite(row.contextTokens) && row.contextTokens > 0) {
    const usage = { tokens: row.totalTokens, contextWindow: row.contextTokens, contextPercent: Math.round((row.totalTokens / row.contextTokens) * 10000) / 100 };
    if (typeof row.estimatedCostUsd === "number" && row.estimatedCostUsd > 0) usage.cost = row.estimatedCostUsd;
    session.state.usage = usage;
  }
}

/** 拉取并应用会话状态；返回是否有可用用量。 */
async function refreshSessionState(session) {
  const described = await session.host.call("sessions.describe", { key: session.nativeSessionId }).catch(() => null);
  applySessionDescription(session, described?.session);
  return session.state.usage;
}
function create() {
  const adapter = {
    manifest,

    async inspect() {
      const cli = cliSpawn("openclaw", ["--version"]);
      const version = await new Promise((resolve) => execFile(cli.command, cli.args, { windowsHide: true, timeout: 10000 }, (error, out) => resolve(error ? null : out.trim())));
      if (!version) return { available: false, detail: "OpenClaw CLI 不可用（npm i -g openclaw）" };
      try {
        const cfg = await readGatewayConfig();
        return { available: true, detail: `${version} · Gateway 127.0.0.1:${cfg.port}` };
      } catch (error) {
        return { available: false, detail: `OpenClaw 配置不可读：${error.message}` };
      }
    },

    async describe() {
      // 全局模型目录：只读已有 Gateway（不为选择器拉起进程），不可达时交回空目录
      try {
        const host = await OpenClawGatewayHost.acquire(() => {}, { autostart: false });
        try { return { models: await listModels(host), thinkingLevels: thinkingCatalog(), permissionModes: [] }; }
        finally { await OpenClawGatewayHost.release(); }
      } catch { return { models: null, thinkingLevels: [], permissionModes: [] }; }
    },

    async open({ thread, emit: emitEvent, diagnostic = () => {} }) {
      const host = await OpenClawGatewayHost.acquire(diagnostic);
      const session = {
        host,
        cwd: thread.cwd,
        nativeSessionId: null,
        state: { lastAssistantText: "", lastError: null, runId: null },
        pendingApprovals: new Map(), // requestId -> approvalId
        modelOverride: null,
        thinkingOverride: null,
        emit: emitEvent,
        unwatch: null,
      };

      try {
        // 新会话显式登记（携带工作目录与标题），恢复会话直接沿用原生 sessionKey
        if (thread.restore && thread.nativeSessionId) {
          session.nativeSessionId = thread.nativeSessionId;
        } else {
          const label = String(thread.title || "Harness Mix 任务").slice(0, 60);
          const baseKey = `harness-mix-${thread.nativeSessionId || randomUUID()}`;
          let created = await host.call("sessions.create", { key: baseKey, label, cwd: thread.cwd }).catch(() => null);
          if (!created?.key) created = await host.call("sessions.create", { key: baseKey, label }).catch(() => null);
          session.nativeSessionId = created?.key ?? `agent:main:${baseKey}`;
        }

        session.unwatch = host.onEvent((frame) => {
          recordNative(manifest.id, frame);
          if (frame?.type === "closed") {
            for (const pending of session.pendingApprovals.values()) pending.reject?.(new Error("OpenClaw Gateway 连接已断开"));
            session.pendingApprovals.clear();
            return;
          }
          if (frame.type !== "event") return;
          // agent 流：按 runId（本轮）或 sessionKey（本会话）归属
          if (frame.event === "agent") {
            const payload = frame.payload ?? {};
            if (payload.runId !== session.state.runId && payload.sessionKey !== session.nativeSessionId) return;
            for (const event of projectAgentEvent(payload, session)) emitEvent(event);
            return;
          }
          // 审批广播：只归集显式携带本会话 sessionKey 的请求，不劫持其他客户端的审批
          if (frame.event === "exec.approval.requested" || frame.event === "plugin.approval.requested") {
            const payload = frame.payload ?? {};
            if (payload.request?.sessionKey !== session.nativeSessionId) return;
            const id = String(payload.id ?? "");
            if (!id) return;
            const projected = projectApproval(frame.event, payload, session.nativeSessionId);
            session.pendingApprovals.set(projected.requestId, { approvalId: id });
            emitEvent(projected);
            return;
          }
          if (frame.event === "exec.approval.resolved" || frame.event === "plugin.approval.resolved") {
            // 他端（如 OpenClaw 自有 UI）已处理的审批：同步收掉卡片
            const requestId = `openclaw-${frame.payload?.id ?? ""}`;
            if (session.pendingApprovals.delete(requestId)) emitEvent({ kind: "interaction-responded", requestId });
          }
        });

        const models = await listModels(host).catch(() => []);
        if (models.length) session.models = models;
        // 生效模型/思考档位/用量以 sessions.describe 为准（恢复会话直接取到，新会话首个 turn 后齐备）
        await refreshSessionState(session);
        if (thread.options?.model) await adapter.setModel(session, thread.options.model);
        if (thread.options?.thinking) await adapter.setThinkingLevel(session, thread.options.thinking);
        emitEvent({ kind: "session", nativeSessionId: session.nativeSessionId, model: session.model });
        return session;
      } catch (error) {
        try { session.unwatch?.(); } catch { /* 已断开 */ }
        await OpenClawGatewayHost.release();
        throw error;
      }
    },

    async describeFor(session) {
      const levels = session.state.thinkingLevels ?? thinkingCatalog();
      // 原生 sessions.describe 上报的 thinkingDefault 即当前生效档，标记后由协议层作为安全预选秀下发
      const marked = session.state.thinkingDefault
        ? levels.map(l => ({ ...l, default: l.id === session.state.thinkingDefault }))
        : levels;
      return { models: session.models ?? null, thinkingLevels: marked, permissionModes: [] };
    },

    async listModelsFor(session) { return listModels(session.host); },

    async send(session, text, hooks, attachments) {
      const params = {
        message: text,
        sessionKey: session.nativeSessionId,
        idempotencyKey: randomUUID(),
        deliver: false, // 回复只走 Desktop 原生流，不向 OpenClaw 渠道投递
      };
      // 图片走 Gateway agent RPC 原生 attachments 字段：{ mimeType, content(base64), fileName }（协议 schema 见附件归一化实现）
      const images = attachments?.images ?? [];
      if (images.length) {
        params.attachments = images.map((img) => ({
          mimeType: img.mime || "image/png",
          content: img.data,
          fileName: img.name || undefined,
        }));
      }
      if (session.modelOverride) params.model = session.modelOverride;
      if (session.thinkingOverride) params.thinking = session.thinkingOverride;
      const accepted = await session.host.call("agent", params);
      if (accepted?.status === "in_flight") throw new Error("该会话已有进行中的原生任务，请稍候");
      const runId = accepted?.runId;
      if (!runId) throw new Error("OpenClaw Gateway 未返回 runId");
      session.state.runId = runId;
      session.state.lastAssistantText = "";
      session.state.lastError = null;
      try {
        const result = await session.host.call("agent.wait", { runId, timeoutMs: AGENT_TIMEOUT_MS }, AGENT_TIMEOUT_MS + 30_000);
        // turn 结束后回读原生会话状态：生效模型、思考目录、token 用量（真实统计，不用估计值冒充）
        const modelBefore = session.model?.id;
        await refreshSessionState(session);
        if (session.state.usage) hooks.emit({ kind: "usage", usage: session.state.usage });
        if (session.model && session.model.id !== modelBefore) hooks.emit({ kind: "session", nativeSessionId: session.nativeSessionId, model: session.model });
        if (result?.status === "ok") { hooks.emit({ kind: "completed", finalAnswer: true }); return; }
        if (result?.stopReason === "rpc") return; // 用户取消：runtime 已按取消结算
        throw new Error(result?.error || session.state.lastError || `原生任务未正常结束（${result?.status ?? "未知"}）`);
      } finally {
        if (session.state.runId === runId) session.state.runId = null;
      }
    },

    async cancel(session) {
      const runId = session.state.runId;
      await session.host.call("sessions.abort", runId ? { key: session.nativeSessionId, runId } : { key: session.nativeSessionId }).catch(() => {});
    },

    async respond(session, requestId, response) {
      const pending = session.pendingApprovals.get(requestId);
      if (!pending) throw new Error("未知或已过期的原生审批请求");
      const decision = response?.confirmed === true || response?.optionId === "allowed-once" ? "allow-once"
        : response?.optionId === "allowed-always" ? "allow-always"
        : "deny"; // 拒绝/取消统一收敛为 deny，不替用户放行
      const method = pending.approvalId.startsWith("plugin:") ? "plugin.approval.resolve" : "exec.approval.resolve";
      await session.host.call(method, { id: pending.approvalId, decision });
      session.pendingApprovals.delete(requestId);
    },

    async setModel(session, model) {
      // Gateway 按 run 应用 model 覆盖（需 operator.admin，握手已声明）；逐轮生效，不写原生配置
      session.modelOverride = model.id;
      session.model = model;
      return model;
    },

    async setThinkingLevel(session, level) {
      const catalog = session.state.thinkingLevels?.map((l) => l.id) ?? THINKING_LEVELS;
      if (!catalog.includes(level)) throw new Error(`OpenClaw 当前会话不支持思考档位 ${level}`);
      session.thinkingOverride = level;
    },

    async getContextUsage(session) { return session.state.usage; },

    async close(session) {
      for (const pending of session.pendingApprovals.values()) pending.reject?.(new Error("会话已关闭"));
      session.pendingApprovals.clear();
      try { session.unwatch?.(); } catch { /* 已断开 */ }
      await OpenClawGatewayHost.release();
    },
  };
  return adapter;
}

/** models.list → 统一目录（id 带 provider 前缀，与 agent 的 model 覆盖参数同形） */
async function listModels(host) {
  const result = await host.call("models.list", {});
  const rows = Array.isArray(result?.models) ? result.models : [];
  return rows.filter((m) => m && m.id).map((m) => ({
    id: m.provider ? `${m.provider}/${m.id}` : String(m.id),
    name: m.name || String(m.id),
    provider: m.provider,
    description: m.contextWindow ? `上下文窗口 ${Math.round(m.contextWindow / 1000)}k` : undefined,
  }));
}

function thinkingCatalog() {
  return THINKING_LEVELS.map((id) => ({ id, label: id }));
}

module.exports = { manifest, create, projectAgentEvent, projectApproval, applySessionDescription, THINKING_LEVELS };
