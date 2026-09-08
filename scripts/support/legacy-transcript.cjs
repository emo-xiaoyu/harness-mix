const { randomUUID } = require('node:crypto');

// A durable, ordered projection. Native tools keep their identities; the host
// records presentation order only, never replays their side effects.
function appendDelta(message, kind, text, now = Date.now()) {
  if (!text) return;
  message.items ??= [];
  const previous = message.items.at(-1);
  if (previous?.kind === kind && !previous.endedAt) previous.text += text;
  else {
    if (previous && !previous.endedAt) previous.endedAt = now;
    message.items.push({ id: randomUUID(), kind, text, at: now });
  }
}

function projectTool(thread, message, event, now = Date.now()) {
  thread.tools ??= [];
  let tool = event.toolCallId
    ? thread.tools.findLast(t => t.id === event.toolCallId && t.messageId === message.id)
    : thread.tools.findLast(t => t.title === event.title && t.state === 'running' && t.messageId === message.id);
  if (!tool) {
    tool = { id: event.toolCallId ?? randomUUID(), messageId: message.id, title: event.title, at: now };
    thread.tools.push(tool);
    message.items ??= [];
    const previous = message.items.at(-1);
    if (previous && !previous.endedAt) previous.endedAt = now;
    message.items.push({ id: randomUUID(), kind: 'tool', toolId: tool.id, at: now });
  }
  tool.state = event.state ?? tool.state ?? 'running';
  for (const key of ['detail', 'input', 'output']) if (typeof event[key] === 'string') tool[key] = event[key];
  if (tool.state !== 'running') tool.endedAt = now;
}

function finishMessage(thread, message, reason = 'completed', now = Date.now()) {
  if (!message || message.role !== 'assistant') return;
  delete message.streaming;
  message.endedAt ??= now;
  message.stopReason = reason;
  for (const item of message.items ?? []) item.endedAt ??= now;
  for (const tool of thread.tools ?? []) {
    if (tool.messageId === message.id && tool.state === 'running') {
      tool.state = 'interrupted'; // A settled turn is not proof of tool success.
      tool.endedAt = now;
    }
  }
}

module.exports = { appendDelta, projectTool, finishMessage };
