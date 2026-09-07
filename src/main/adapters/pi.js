const { execFile } = require("node:child_process");
const os = require("node:os");
const { JsonlProcess, cliSpawn } = require("../host/jsonl");
const { sessionUsage, latestUsage } = require('./pi-usage');

function toolText(content) {
  const text = Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(content ?? '');
  return text.length > 24000 ? text.slice(0, 24000) + '\n[桌面预览已截断]' : text;
}

const manifest = {
  id: "pi",
  name: "Pi",
  icon: "pinumber1_80899.svg",
  capabilities: { streaming: true, thinking: true, tools: true, approvals: true, questions: true, models: true, thinkingLevels: true, permissionModes: true, resume: true, fork: true, usage: true, contextUsage: true },
};

/** Pi 的权限模型 = 项目信任（project trust）：启动时用 --approve / --no-approve 覆盖一次 */
const PI_PERMISSION_MODES = [
  { id: "default", label: "默认", hint: "按全局设置处理项目级设置与扩展（defaultProjectTrust）" },
  { id: "approve", label: "信任项目", hint: "本次信任该项目的设置与扩展（--approve）" },
  { id: "no-approve", label: "忽略项目资源", hint: "本次不加载项目级设置与扩展（--no-approve）" },
];

function firstLine(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.split("\n").find((line) => line.trim())?.slice(0, 120) ?? "";
}

function summarizeContent(content) {
  if (!Array.isArray(content)) return firstLine(content);
  const text = content.find((block) => block.type === "text")?.text;
  return firstLine(text ?? "");
}

function sanitizeName(title) {
  return String(title || "").replace(/["&|<>^%]/g, "").trim().slice(0, 40) || "Harness Mix 任务";
}

/** 工具结果里的图片块 → 统一 artifact 事件（各 Harness 返回产物在桌面层对齐呈现；超大图片不入会话存档） */
function imageArtifacts(content, toolCallId) {
  if (!Array.isArray(content)) return [];
  const out = [];
  content.forEach((block, i) => {
    if (block?.type !== "image" || typeof block.data !== "string" || !block.data) return;
    if (block.data.length > 5_000_000) return;
    out.push({ kind: "artifact", artifact: { id: `${toolCallId ?? "pi"}-img-${i}`, type: "image", name: block.name || "图片", mime: block.mimeType || "image/png", data: block.data } });
  });
  return out;
}

/** project() 可能返回数组（工具结果同时有摘要与图片产物），统一展开投影 */
function emitAll(emitEvent, mapped) {
  for (const item of Array.isArray(mapped) ? mapped : [mapped]) if (item) emitEvent(item);
}

function spawnPi(args, cwd, hooks) {
  const { command, args: cliArgs } = cliSpawn("pi", ["--mode", "rpc", ...args]);
  return new JsonlProcess(command, cliArgs, { cwd }, hooks);
}

/** Pi Adapter：pi.cmd --mode rpc，会话/模型/工具/权限都由 Pi 原生维护，这里只做事件投影 */
function create(emit) {
  return {
    manifest,

    async inspect() {
      const result = await new Promise((resolve) => {
        const { command, args } = cliSpawn("pi", ["--version"]);
        execFile(command, args, { windowsHide: true }, (error, stdout) => resolve({ ok: !error, stdout }));
      });
      return result.ok
        ? { available: true, detail: `pi ${String(result.stdout).trim()}` }
        : { available: false, detail: "未找到 pi CLI（npm i -g @earendil-works/pi-coding-agent）" };
    },

    async open({ thread, emit: emitEvent, diagnostic }) {
      const args = ["--session-id", thread.nativeSessionId, "--name", sanitizeName(thread.title)];
      if (thread.options?.permissionMode === "approve") args.push("--approve");
      if (thread.options?.permissionMode === "no-approve") args.push("--no-approve");
      const process = spawnPi(args, thread.cwd, {
        onEvent: (event) => emitAll(emitEvent, project(event)),
        onDiagnostic: (message) => diagnostic(message),
      });
      const state = await process.command({ type: "get_state" });
      let model = state?.model ? { id: state.model.id, name: state.model.name } : undefined;
      // 应用草稿期选择的模型与思考档位（仍由 Pi 原生执行切换）
      if (thread.options?.model?.provider) {
        model = await process.command({ type: "set_model", provider: thread.options.model.provider, modelId: thread.options.model.id })
          .then((m) => ({ id: m.id ?? thread.options.model.id, name: m.name ?? thread.options.model.name }))
          .catch(() => model);
      }
      if (thread.options?.thinking) await process.command({ type: "set_thinking_level", level: thread.options.thinking }).catch(() => {});
      return {
        process,
        nativeSessionId: state?.sessionId ?? thread.nativeSessionId,
        nativeSessionFile: state?.sessionFile,
        model,
      };
    },

    async send(session, text) {
      await session.process.command({ type: "prompt", message: text });
    },

    async cancel(session) {
      await session.process.command({ type: "abort" });
    },

    async listModels() {
      // 需要进程内目录，由 runtime 在 open 后调用 listModels(session)
      return null;
    },

    async listModelsFor(session) {
      const data = await session.process.command({ type: "get_available_models" });
      const models = Array.isArray(data?.models) ? data.models : [];
      return models.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
    },

    async setModel(session, model) {
      const data = await session.process.command({ type: "set_model", provider: model.provider, modelId: model.id });
      return data ? { id: data.id ?? model.id, name: data.name ?? model.name } : model;
    },

    /** 审批/提问应答：extension_ui_response 子协议 */
    async respond(session, _requestId, response) {
      const payload = { type: "extension_ui_response", id: _requestId };
      if (response.cancelled) payload.cancelled = true;
      else if (response.confirmed !== undefined) payload.confirmed = response.confirmed;
      else payload.value = response.optionId ?? response.value ?? "";
      session.process.send(payload);
    },

    async setThinkingLevel(session, level) {
      await session.process.command({ type: "set_thinking_level", level });
    },

    /** 上下文窗口占用：Pi 原生统计（与压缩/页脚同源） */
    async getContextUsage(session) {
      const data = await session.process.command({ type: "get_session_stats" });
      return sessionUsage(data);
    },

    /** 目录探测：临时起一个无会话 RPC 进程，拿模型目录与思考档位后即销毁（带缓存由 runtime 负责） */
    async describe() {
      const process = spawnPi(["--no-session"], os.tmpdir(), {});
      try {
        const modelsData = await process.command({ type: "get_available_models" });
        const levelsData = await process.command({ type: "get_available_thinking_levels" }).catch(() => null);
        return {
          models: (modelsData?.models ?? []).map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider, contextWindow: m.contextWindow })),
          thinkingLevels: (levelsData?.levels ?? []).map((l) => ({ id: l, label: l })),
          permissionModes: PI_PERMISSION_MODES,
        };
      } finally {
        process.stop();
      }
    },

    /** 任务级 Fork：另起 pi 进程，用 CLI --fork 从源会话分叉出全新原生会话 */
    async fork(sourceThread, { emit: emitEvent, diagnostic }) {
      const process = spawnPi(["--fork", sourceThread.nativeSessionId, "--name", `${sanitizeName(sourceThread.title)} · Fork`], sourceThread.cwd, {
        onEvent: (event) => emitAll(emitEvent, project(event)),
        onDiagnostic: (message) => diagnostic(message),
      });
      const state = await process.command({ type: "get_state" });
      if (!state?.sessionId || state.sessionId === sourceThread.nativeSessionId) throw new Error("Pi 未返回新的 Fork 会话");
      return { session: { process, nativeSessionId: state.sessionId, nativeSessionFile: state.sessionFile } };
    },

    async close(session) {
      session.process.stop();
    },
  };
}

/** Pi 原生事件 → 统一事件投影（事件转换层） */
function project(event) {
  switch (event.type) {
    case 'message_end':
      return latestUsage(event.message);
    case "message_update": {
      const delta = event.assistantMessageEvent || {};
      if (delta.type === "text_delta" && delta.delta) return { kind: "text-delta", text: delta.delta };
      if (delta.type === "thinking_delta" && delta.delta) return { kind: "thinking-delta", text: delta.delta };
      return null;
    }
    case "tool_execution_start":
      return { kind: "tool", toolCallId: event.toolCallId, title: event.toolName || "工具", state: "running", detail: firstLine(event.args ? Object.values(event.args)[0] : ""), input: toolText(event.args?.command ?? JSON.stringify(event.args ?? {}, null, 2)) };
    case "tool_execution_update":
      return { kind: "tool", toolCallId: event.toolCallId, title: event.toolName || "工具", state: "running", detail: summarizeContent(event.partialResult?.content), output: toolText(event.partialResult?.content) };
    case "tool_execution_end":
      return [
        { kind: "tool", toolCallId: event.toolCallId, title: event.toolName || "工具", state: event.isError ? "error" : "done", detail: summarizeContent(event.result?.content), output: toolText(event.result?.content) },
        ...imageArtifacts(event.result?.content, event.toolCallId),
      ];
    case "extension_ui_request": {
      if (event.method === "notify") return { kind: "notice", level: event.notifyType || "info", text: event.message || event.title || "通知" };
      if (event.method === "setStatus") return event.statusText ? { kind: "status", text: event.statusText } : null;
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        return {
          kind: "approval",
          requestId: event.id,
          method: event.method,
          title: event.title || "Harness 请求确认",
          message: event.message,
          placeholder: event.placeholder ?? event.prefill,
          options: Array.isArray(event.options) ? event.options.map((o) => ({ id: String(o), label: String(o) })) : undefined,
        };
      }
      return null;
    }
    case "agent_settled":
      return { kind: "completed" };
    case "agent_end":
      return event.willRetry ? { kind: "status", text: "请求失败，自动重试中…" } : null;
    case "auto_retry_start":
      return { kind: "status", text: `自动重试（${event.attempt}/${event.maxAttempts}）…` };
    case "auto_retry_end":
      return event.success ? { kind: "status", text: "重试成功" } : { kind: "error", message: `自动重试失败：${event.finalError || "未知错误"}` };
    case "compaction_start":
      return { kind: "status", text: "上下文压缩中…" };
    case "compaction_end":
      return event.result ? { kind: "status", text: `压缩完成（${event.result.tokensBefore} → ${event.result.estimatedTokensAfter} tokens）` } : null;
    case "extension_error":
      return { kind: "notice", level: "error", text: `扩展错误：${event.error}` };
    default:
      return null;
  }
}

module.exports = { manifest, create };
