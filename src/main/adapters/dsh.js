const { promises: fs } = require("node:fs");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const { JsonlProcess, cliSpawn } = require("../host/jsonl");

const DSH_ROOT = process.env.HARNESS_MIX_DSH_ROOT || "E:\\dsh\\deepseek-harness";

const manifest = {
  id: "dsh",
  name: "DeepSeek Harness",
  icon: "deepseek-color.svg",
  // DSH ACP 为自动化协议：不支持 fork / 提问，权限审批为一次性 allow/reject（无权限模式配置项）
  capabilities: { streaming: true, thinking: true, tools: true, approvals: true, questions: false, models: true, thinkingLevels: true, permissionModes: false, resume: true, fork: false, usage: true, contextUsage: true },
};

const TOOL_STATUS = { pending: "running", in_progress: "running", completed: "done", failed: "error" };

function pickModelOptions(configOptions) {
  if (!Array.isArray(configOptions)) return { models: undefined, current: undefined };
  const modelOption = configOptions.find((o) => /(^|_)model($|_)/i.test(o.id ?? o.configId ?? ""));
  if (!modelOption || !Array.isArray(modelOption.options)) return { models: undefined, current: undefined };
  // DSH 的选项按 provider 分组嵌套：{ group, name, options:[{value,name}] }，这里展平为叶子列表
  const leaves = [];
  const walk = (entries, group) => {
    for (const entry of entries) {
      if (Array.isArray(entry.options)) walk(entry.options, entry.name ?? entry.group ?? group);
      else leaves.push({ id: String(entry.value ?? entry.id ?? entry.name), name: String(entry.name ?? entry.value ?? entry.id), provider: group, description: entry.description });
    }
  };
  walk(modelOption.options, undefined);
  const currentValue = modelOption.currentValue ?? modelOption.current;
  const current = leaves.find((m) => m.id === currentValue);
  return { models: leaves.length ? leaves : undefined, current: current ?? (currentValue ? { id: String(currentValue), name: String(currentValue) } : undefined) };
}

function pickThinkingLevels(configOptions) {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find((o) => /reasoning|thought/i.test(o.id ?? o.category ?? ""));
  if (!option || !Array.isArray(option.options)) return undefined;
  return option.options.map((o) => ({ id: String(o.value ?? o.id), label: o.name ?? String(o.value), hint: o.description }));
}

/** DeepSeek Harness Adapter：pnpm dsh --profile acp，标准 ACP v1 JSON-RPC over stdio */
function create(emit) {
  return {
    manifest,

    async inspect() {
      const exists = await fs.stat(DSH_ROOT).then(() => true).catch(() => false);
      return exists
        ? { available: true, detail: `ACP · ${DSH_ROOT}` }
        : { available: false, detail: `未找到 DSH 检出（${DSH_ROOT}），可用 HARNESS_MIX_DSH_ROOT 指定` };
    },

    async open({ thread, emit: emitEvent, diagnostic }) {
      const pendingPermissions = new Map();
      const { command, args } = cliSpawn("npm", ["run", "dsh", "--", "--profile", "acp"]);
      const process = new JsonlProcess(command, args, { cwd: DSH_ROOT }, {
        onEvent: (event) => emitEvent(projectNotification(event)),
        onDiagnostic: (message) => diagnostic(message),
        onRequest: async (request) => {
          if (request.method === "session/request_permission") {
            const requestId = `dsh-${request.id}`;
            const toolCall = request.params?.toolCall ?? {};
            const options = Array.isArray(request.params?.options) ? request.params.options : [];
            emitEvent({
              kind: "approval",
              requestId,
              method: "permission",
              title: toolCall.title || "DSH 权限请求",
              message: toolCall.kind ? `工具类型：${toolCall.kind}` : undefined,
              options: options.map((o) => ({ id: String(o.optionId ?? o.id), label: o.name ?? String(o.optionId), kind: o.kind })),
            });
            // 等待 Host 回复（runtime.respond → 下方 respond）
            return new Promise((resolve, reject) => {
              pendingPermissions.set(requestId, { rawId: request.id, resolve, reject });
            });
          }
          throw new Error(`暂不支持的请求：${request.method}`);
        },
      });

      await process.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const opened = thread.restore
        ? await process.request("session/resume", { sessionId: thread.nativeSessionId, cwd: thread.cwd, mcpServers: [] })
        : await process.request("session/new", { cwd: thread.cwd, mcpServers: [] });

      const { models, current } = pickModelOptions(opened.configOptions ?? opened.config_options);
      const session = { process, nativeSessionId: opened.sessionId, models, model: current ? { id: current.id, name: current.name } : undefined, pendingPermissions };
      // 应用草稿期选择的模型与思考档位（DSH 原生配置项）
      if (thread.options?.model?.id && thread.options.model.id !== current?.id) {
        await process.request("session/set_config_option", { sessionId: session.nativeSessionId, configId: "model", value: thread.options.model.id }).catch(() => {});
        session.model = thread.options.model;
      }
      if (thread.options?.thinking) {
        await process.request("session/set_config_option", { sessionId: session.nativeSessionId, configId: "reasoning_effort", value: thread.options.thinking }).catch(() => {});
      }
      return session;
    },

    async send(session, text, { emit } = {}) {
      // ACP：prompt 在整个回合（含工具执行）结束后才 resolve，结算即为 completed
      await session.process.request("session/prompt", { sessionId: session.nativeSessionId, prompt: [{ type: "text", text }] });
      emit?.({ kind: "completed" });
    },

    async cancel(session) {
      session.process.notify("session/cancel", { sessionId: session.nativeSessionId });
    },

    async listModelsFor(session) {
      return session.models ?? null;
    },

    async setModel(session, model) {
      await session.process.request("session/set_config_option", { sessionId: session.nativeSessionId, configId: "model", value: model.id });
      return model;
    },

    async setThinkingLevel(session, level) {
      await session.process.request("session/set_config_option", { sessionId: session.nativeSessionId, configId: "reasoning_effort", value: level });
    },

    /** 目录探测：起一个临时 ACP 会话读取配置项（模型目录 + 推理档位）后关闭 */
    async describe() {
      const { command, args } = cliSpawn("npm", ["run", "dsh", "--", "--profile", "acp"]);
      const process = new JsonlProcess(command, args, { cwd: DSH_ROOT }, {});
      try {
        await process.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const opened = await process.request("session/new", { cwd: os.tmpdir(), mcpServers: [] });
        const configOptions = opened.configOptions ?? opened.config_options;
        const { models } = pickModelOptions(configOptions);
        await process.request("session/close", { sessionId: opened.sessionId }).catch(() => {});
        return { models, thinkingLevels: pickThinkingLevels(configOptions), permissionModes: [] };
      } finally {
        process.stop();
      }
    },

    async respond(session, requestId, response) {
      const pending = session.pendingPermissions?.get(requestId);
      if (!pending) return;
      session.pendingPermissions.delete(requestId);
      const optionId = response.cancelled ? undefined : response.optionId;
      pending.resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    },

    async close(session) {
      try { await session.process.request("session/close", { sessionId: session.nativeSessionId }); } catch { /* 进程可能已退出 */ }
      session.process.stop();
    },
  };
}

/** ACP session/update 通知 → 统一事件投影 */
function projectNotification(event) {
  if (event.method !== "session/update") return null;
  const update = event.params?.update;
  if (!update) return null;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content;
      if (!content) return null;
      // 文本之外的返回产物（图片 / 资源链接）也投影为统一 artifact，与其他 Harness 对齐
      if (content.type === "text" && content.text) return { kind: "text-delta", text: content.text };
      if (content.type === "image" && typeof content.data === "string" && content.data) {
        return { kind: "artifact", artifact: { id: randomUUID(), type: "image", name: content.name || "图片", mime: content.mimeType || "image/png", data: content.data.length <= 5_000_000 ? content.data : undefined } };
      }
      if (content.type === "resource_link" && content.uri) {
        return { kind: "artifact", artifact: { id: randomUUID(), type: "file", name: content.name || content.uri, uri: content.uri } };
      }
      if (content.type === "resource" && typeof content.resource?.text === "string") return { kind: "text-delta", text: content.resource.text };
      return null;
    }
    case "agent_thought_chunk":
      return update.content?.text ? { kind: "thinking-delta", text: update.content.text } : null;
    case "tool_call":
      return { kind: "tool", toolCallId: update.toolCallId, title: update.title || "DSH 工具", state: TOOL_STATUS[update.status] ?? "running", detail: update.kind };
    case "tool_call_update": {
      const state = TOOL_STATUS[update.status];
      return state ? { kind: "tool", toolCallId: update.toolCallId, title: update.title || "DSH 工具", state, detail: undefined } : null;
    }
    case "usage_update":
      return { kind: "usage", usage: { used: update.used, size: update.size, contextPercent: update.size ? Math.round((100 * update.used) / update.size) : undefined } };
    case "plan":
      return { kind: "status", text: "已更新执行计划" };
    default:
      return null;
  }
}

module.exports = { manifest, create };
