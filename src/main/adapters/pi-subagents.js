const { randomUUID } = require('node:crypto');

const STATUS_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';
const INSPECT_PREFIX = 'PI_SUBAGENT_INSPECT_JSON:';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function widgetPayload(event, key, prefix) {
  if (event?.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.widgetKey !== key) return null;
  const line = event.widgetLines?.[0];
  if (typeof line !== 'string' || !line.startsWith(prefix)) return null;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
}

function nativeStatus(state) {
  if (state === 'complete' || state === 'completed') return 'success';
  if (state === 'failed' || state === 'rejected') return 'failed';
  if (state === 'paused' || state === 'stopped') return 'stopped';
  return 'running';
}

function inspectMessages(reply) {
  const rows = [];
  for (const [index, row] of (reply.messages ?? []).entries()) {
    if (row?.role === 'user' && row.kind === 'text') {
      rows.push({ info: { role: 'user' }, parts: [{ type: 'text', text: row.text }] });
      continue;
    }
    const parts = row?.kind === 'text' ? [{ type: 'text', text: row.text }]
      : row?.kind === 'toolCall' || row?.kind === 'toolResult'
        ? [{ type: 'tool', callID: `pi-subagent-tool-${index}`, tool: row.name || '工具',
          state: { status: row.isError ? 'error' : 'completed',
            ...(row.kind === 'toolCall' ? { input: row.text } : { output: row.text }) } }] : [];
    if (parts.length) rows.push({ info: { role: 'assistant', time: { completed: Date.now() } }, parts });
  }
  if (!rows.length && reply.finalOutput) rows.push({ info: { role: 'assistant', time: { completed: Date.now() } },
    parts: [{ type: 'text', text: reply.finalOutput }] });
  return rows;
}

function foregroundMessages(result) {
  const rows = [];
  const task = result.task && result.task !== '[prompt redacted]' ? result.task : '';
  if (task && !(result.messages ?? []).some(message => message?.role === 'user')) {
    rows.push({ info: { role: 'user' }, parts: [{ type: 'text', text: task }] });
  }
  for (const message of result.messages ?? []) {
    if (message?.role !== 'assistant' && message?.role !== 'user') continue;
    const parts = (message.content ?? []).flatMap(block => {
      if (block?.type === 'text' && block.text) return [{ type: 'text', text: block.text }];
      if (block?.type === 'thinking' && block.thinking) return [{ type: 'reasoning', text: block.thinking }];
      if (block?.type === 'toolCall') return [{ type: 'tool', callID: block.id, tool: block.name,
        state: { status: 'completed', input: block.arguments } }];
      return [];
    });
    if (parts.length) rows.push({ info: { role: message.role, time: { completed: message.role === 'assistant' ? Date.now() : undefined } }, parts });
  }
  if (!rows.some(row => row.info.role === 'assistant') && result.finalOutput) {
    rows.push({ info: { role: 'assistant', time: { completed: Date.now() } },
      parts: [{ type: 'text', text: result.finalOutput }] });
  }
  return rows;
}

function createPiSubagentBridge(process, parentId, emit, harnessName = 'Pi') {
  const nodes = new Map();
  const replies = new Map();
  let closed = false;
  function schedule(node) {
    if (closed || node.timer || node.inspectPending) return;
    node.timer = setTimeout(() => {
      node.timer = null;
      void inspect(node);
    }, 350);
    node.timer.unref?.();
  }
  async function inspect(node) {
    if (closed || node.inspectPending) return;
    node.inspectPending = true;
    const requestId = randomUUID();
    let timer;
    try {
      const replyPromise = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Pi subagent inspect timeout')), 5000);
        timer.unref?.();
        replies.set(requestId, resolve);
      });
      void replyPromise.catch(() => {});
      const command = `/subagents-inspect-rpc ${requestId} ${node.asyncId}${node.childId ? ` ${node.childId}` : ''} --lines 200`;
      await process.command({ type: 'prompt', message: command });
      const reply = await replyPromise;
      if (reply?.error || reply?.kind !== 'pi-subagents.inspect-reply' || reply.version !== 1) return;
      const snapshotStatus = nativeStatus(node.status);
      emit({ kind: 'native-subagent', nativeSessionId: node.nativeId,
        title: reply.label || node.title, task: reply.task || '',
        status: snapshotStatus === 'running' ? nativeStatus(reply.status) : snapshotStatus,
        messages: inspectMessages(reply) });
    } catch { /* A child can disappear before inspection; later status can retry. */ }
    finally { clearTimeout(timer); replies.delete(requestId); node.inspectPending = false; }
  }
  function onEvent(event) {
    if ((event?.type === 'tool_execution_update' || event?.type === 'tool_execution_end') && event.toolName === 'subagent') {
      const finished = event.type === 'tool_execution_end';
      const details = (finished ? event.result : event.partialResult)?.details;
      const invocationId = typeof event.toolCallId === 'string' && event.toolCallId
        ? `tool:${event.toolCallId}` : typeof details?.runId === 'string' ? details.runId : null;
      if (invocationId && Array.isArray(details?.results)) {
        for (const result of details.results) {
          if (!Number.isInteger(result?.index) || !result.agent) continue;
          emit({ kind: 'native-subagent', nativeSessionId: `${parentId}:pi-subagents:${invocationId}:step:${result.index}`,
            title: `${harnessName} · ${result.agent}`,
            task: result.task === '[prompt redacted]' ? '' : result.task || '',
            status: finished ? result.exitCode === 0 && !result.error ? 'success' : 'failed' : 'running',
            messages: finished ? foregroundMessages(result) : [] });
        }
      }
      return false;
    }
    if (event?.type !== 'extension_ui_request' || event.method !== 'setWidget') return false;
    if (event.widgetKey === 'subagent-inspect') {
      const reply = widgetPayload(event, 'subagent-inspect', INSPECT_PREFIX);
      if (reply?.requestId && replies.has(reply.requestId)) replies.get(reply.requestId)(reply);
      return true;
    }
    if (event.widgetKey !== 'subagent-async') return false;
    const snapshot = widgetPayload(event, 'subagent-async', STATUS_PREFIX);
    if (snapshot?.kind !== 'pi-subagents.async-status-snapshot' || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) return true;
    for (const run of snapshot.runs) {
      if (typeof run?.id !== 'string' || !SAFE_ID.test(run.id)) continue;
      const children = Array.isArray(run.children) && run.children.length ? run.children : [run];
      for (const [index, child] of children.entries()) {
        if (typeof child?.id !== 'string') continue;
        const candidate = child === run ? undefined : child.id;
        const childId = candidate && SAFE_ID.test(candidate) ? candidate
          : child?.kind === 'step' ? `step:${index}` : undefined;
        if (child !== run && !childId) continue;
        const nativeId = `${parentId}:pi-subagents:${run.id}:${childId || 'root'}`;
        let node = nodes.get(nativeId);
        if (!node) {
          node = { nativeId, asyncId: run.id, childId, title: `${harnessName} · ${child.label || run.label || '子代理'}` };
          nodes.set(nativeId, node);
          emit({ kind: 'native-subagent', nativeSessionId: nativeId, title: node.title,
            task: '', status: nativeStatus(child.state), messages: [] });
        }
        node.status = child.state;
        schedule(node);
      }
    }
    return true;
  }
  function close() {
    closed = true;
    for (const node of nodes.values()) clearTimeout(node.timer);
    replies.clear();
  }
  return { onEvent, close };
}

module.exports = { createPiSubagentBridge, inspectMessages, foregroundMessages, nativeStatus };
