const { randomUUID } = require('node:crypto');
const { appendDelta, projectTool, finishMessage } = require('./legacy-transcript.cjs');

// Compatibility projection retained only while Shadow parity gates are active.
function applyLegacyEvent(thread, event, effects) {
    const last = thread.messages.at(-1);
    let structural = true;
    switch (event.kind) {
      case "text-delta": {
        const target = last?.role === "assistant" && last.streaming ? last : appendAssistant(thread);
        target.text += event.text;
        appendDelta(target, 'text', event.text);
        structural = false;
        break;
      }
      case "thinking-delta": {
        const target = last?.role === "assistant" && last.streaming ? last : appendAssistant(thread);
        target.thinking = (target.thinking ?? "") + event.text;
        appendDelta(target, 'thinking', event.text);
        structural = false;
        break;
      }
      case "tool": {
        const target = last?.role === 'assistant' && last.streaming ? last : appendAssistant(thread);
        projectTool(thread, target, event);
        break;
      }
      case "artifact": {
        // 各 Harness 返回的图片 / 文件产物：挂到当前 assistant 消息上，Renderer 统一渲染
        const a = event.artifact;
        if (!a || typeof a !== "object") break;
        const target = last?.role === "assistant" ? last : appendAssistant(thread);
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
      case "plan":
      case "file-change":
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

        effects.notify("status", event.text, thread.id);
        return { handled: true, structural: false };
      case "notice":

        effects.notify(event.level ?? "info", event.text);
        return { handled: true, structural: false };
      case "completed": {
        finishMessage(thread, last, event.stopReason ?? 'completed', event.timestamp);
        thread.updatedAt = Date.now();
        effects.refreshUsage(thread);
        void effects.settleReview(thread, last, 'ready');
        break;
      }
      case "error": {
        thread.error = event.message;
        finishMessage(thread, last, 'error', event.timestamp);
        void effects.settleReview(thread, last, 'error');
        break;
      }
      default:
        return { handled: false };
    }
    return { handled: true, structural };
}

function appendAssistant(thread) {
  const message = { id: randomUUID(), role: 'assistant', text: '', at: Date.now(), streaming: true };
  thread.messages.push(message);
  return message;
}

module.exports = { applyLegacyEvent };
