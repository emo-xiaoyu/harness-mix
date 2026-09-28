function taskStatus(status) {
  if (status === 'completed') return 'success';
  if (status === 'cancelled' || status === 'timed_out') return 'stopped';
  if (status === 'failed') return 'failed';
  return 'running';
}

function historyMessages(history) {
  const messages = [];
  for (const row of history?.messages ?? []) {
    if (row?.role !== 'user' && row?.role !== 'assistant') continue;
    const parts = (Array.isArray(row.content) ? row.content : []).flatMap(part => {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text) return [{ type: 'text', text: part.text }];
      if (part?.type === 'thinking' && typeof part.thinking === 'string') return [{ type: 'reasoning', text: part.thinking }];
      if (part?.type === 'toolCall') return [{ type: 'tool', callID: part.id, tool: part.name,
        state: { status: 'completed', input: part.arguments } }];
      return [];
    });
    if (!parts.length) continue;
    messages.push({ info: { role: row.role,
      time: { created: row.timestamp, ...(row.role === 'assistant' ? { completed: row.timestamp || 1 } : {}) } }, parts });
  }
  return messages;
}

function createOpenClawSubagentBridge(host, parentKey, emit, { intervalMs = 3000 } = {}) {
  const signatures = new Map();
  let closed = false;
  let pending = null;
  let timer = null;
  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void scan(); }, intervalMs);
    timer.unref?.();
  }
  function scan() {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const response = await host.call('tasks.list', { sessionKey: parentKey, limit: 100 });
      const tasks = (response?.tasks ?? []).filter(task => task?.sessionKey === parentKey
        && task.runtime === 'subagent' && typeof task.childSessionKey === 'string'
        && task.childSessionKey !== parentKey);
      for (const task of tasks) {
        let messages = [];
        try {
          messages = historyMessages(await host.call('chat.history', { sessionKey: task.childSessionKey, limit: 200 }));
        } catch { /* The child can be created before its transcript is readable. */ }
        const event = { kind: 'native-subagent', nativeSessionId: task.childSessionKey,
          title: task.title || 'OpenClaw · 子代理', task: task.title || '',
          status: taskStatus(task.status), messages };
        const signature = JSON.stringify(event);
        if (signatures.get(task.childSessionKey) !== signature && !closed) {
          signatures.set(task.childSessionKey, signature);
          emit(event);
        }
      }
      if (tasks.some(task => taskStatus(task.status) === 'running')) schedule();
    })().catch(() => { /* Older Gateway versions may not expose the task ledger. */ })
      .finally(() => { pending = null; });
    return pending;
  }
  function close() { closed = true; clearTimeout(timer); signatures.clear(); }
  return { scan, close };
}

module.exports = { createOpenClawSubagentBridge, historyMessages, taskStatus };
