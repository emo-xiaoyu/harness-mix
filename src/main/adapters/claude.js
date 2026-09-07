const { execFile, spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { cliSpawn } = require("../host/jsonl");

const manifest = {
  id: "claude",
  name: "Claude Code",
  icon: "claude-color.svg",
  // 初步接入（脚手架）：每次提问独立 spawn `claude -p --output-format stream-json`，
  // 通过 --resume 让 Claude 原生恢复会话。审批/模型目录走原生 CLI，暂不投影。
  capabilities: { streaming: true, thinking: false, tools: true, approvals: false, questions: false, models: false, thinkingLevels: false, permissionModes: true, resume: true, fork: false, usage: false, contextUsage: false },
};

/** Claude Code 原生权限模式（--permission-mode），与其 TUI/Desktop 一致 */
const CLAUDE_PERMISSION_MODES = [
  { id: "manual", label: "默认（询问）", hint: "编辑和其他受保护操作前询问" },
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

/** Claude Code Adapter（脚手架）：stream-json 输出逐行投影为统一事件 */
function create() {
  return {
    manifest,

    async inspect() {
      const result = await new Promise((resolve) => {
        const { command, args } = cliSpawn("claude", ["--version"]);
        execFile(command, args, { windowsHide: true }, (error, stdout) => resolve({ ok: !error, stdout }));
      });
      return result.ok
        ? { available: true, detail: `claude ${String(result.stdout).trim()}` }
        : { available: false, detail: "未找到 claude CLI，当前为预览入口" };
    },

    async open({ thread }) {
      // 无常驻进程：首个提问时创建进程并捕获 Claude 分配的 session_id
      return { nativeSessionId: thread.restore ? thread.nativeSessionId : undefined, current: null, cwd: thread.cwd, permissionMode: thread.options?.permissionMode };
    },

    async send(session, text, { emit }) {
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      if (session.nativeSessionId) args.push("--resume", session.nativeSessionId);
      if (session.permissionMode) args.push("--permission-mode", session.permissionMode);
      const { command, args: cliArgs } = cliSpawn("claude", args);
      await new Promise((resolve, reject) => {
        const child = spawn(command, cliArgs, { cwd: session.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        session.current = child;
        const decoder = new StringDecoder("utf8");
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += decoder.write(chunk);
          let index;
          while ((index = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.type === "system" && event.subtype === "init" && event.session_id) {
              session.nativeSessionId = event.session_id;
              emit({ kind: "session", nativeSessionId: event.session_id });
            } else if (event.type === "system" && event.subtype === "api_retry") {
              emit({ kind: "status", text: `Claude 模型限流（${event.error_status ?? ""}），重试 ${event.attempt}/${event.max_retries}…` });
            } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) emit({ kind: "text-delta", text: block.text });
                if (block.type === "tool_use") emit({ kind: "tool", toolCallId: block.id, title: block.name || "工具", state: "done", detail: summarizeInput(block.input) });
              }
            } else if (event.type === "user" && Array.isArray(event.message?.content)) {
              // 工具结果中的图片 → 统一 artifact 投影（与其他 Harness 对齐）
              for (const block of event.message.content) {
                if (block?.type !== "tool_result") continue;
                const parts = Array.isArray(block.content) ? block.content : [];
                parts.forEach((part, i) => {
                  if (part?.type === "image" && part.source?.type === "base64" && typeof part.source.data === "string") {
                    emit({ kind: "artifact", artifact: { id: `${block.tool_use_id ?? "claude"}-img-${i}`, type: "image", name: "图片", mime: part.source.media_type || "image/png", data: part.source.data.length <= 5_000_000 ? part.source.data : undefined } });
                  }
                });
              }
            } else if (event.type === "result") {
              if (event.is_error || event.subtype === "error_during_execution") emit({ kind: "error", message: event.result || "Claude 执行失败" });
              emit({ kind: "completed" });
            }
          }
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("exit", (code) => {
          session.current = null;
          if (code === 0) resolve();
          else reject(new Error(stderr.trim().split("\n").pop() || `claude 退出码 ${code}`));
        });
        child.stdin.end(text);
      });
    },

    async cancel(session) {
      session.current?.kill();
    },

    async listModelsFor() { return null; },
    async setModel() { throw new Error("Claude Code 模型请在原生 CLI 中配置"); },
    async setPermissionMode(session, mode) { session.permissionMode = mode; },
    async describe() { return { models: null, thinkingLevels: null, permissionModes: CLAUDE_PERMISSION_MODES }; },
    async respond() { /* 暂不投影审批 */ },
    async close(session) { session.current?.kill(); },
  };
}

module.exports = { manifest, create };
