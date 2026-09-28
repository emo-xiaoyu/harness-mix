function textBlocks(content) {
  return (Array.isArray(content) ? content : []).filter(block => block?.type === 'text' && block.text)
    .map(block => block.text).join('\n');
}

function messagesFromEvents(events) {
  const messages = [];
  let assistant = null;
  const flush = (time) => {
    if (!assistant) return;
    if (assistant.parts.length) {
      assistant.info.time.completed = time || assistant.info.time.created || 1;
      messages.push(assistant);
    }
    assistant = null;
  };
  for (const event of events) {
    const data = event?.data ?? {};
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      flush(event.time);
      const text = textBlocks(data.content);
      if (text) messages.push({ info: { role: 'user', time: { created: event.time } }, parts: [{ type: 'text', text }] });
    } else if (event.type === 'assistant/message') {
      assistant ??= { info: { role: 'assistant', time: { created: event.time } }, parts: [] };
      const text = textBlocks(data.message?.content);
      if (text) assistant.parts.push({ type: 'text', text });
    } else if (event.type === 'tool/call') {
      assistant ??= { info: { role: 'assistant', time: { created: event.time } }, parts: [] };
      assistant.parts.push({ type: 'tool', callID: data.callId, tool: data.name,
        state: { status: 'running', input: data.arguments } });
    } else if (event.type === 'tool/result' && assistant) {
      const block = (data.message?.content ?? []).find(part => part?.type === 'tool-result');
      const tool = assistant.parts.find(part => part.type === 'tool' && part.callID === (block?.toolCallId ?? data.message?.source?.callId));
      if (tool) tool.state = { ...tool.state, status: block?.isError || data.error ? 'error' : 'completed',
        output: textBlocks(block?.content) };
    } else if (event.type === 'turn/end') {
      flush(event.time);
    }
  }
  return messages;
}

function childStatus(entry, events) {
  const lastEnd = events.findLast(event => event.type === 'turn/end');
  const lastStart = events.findLast(event => event.type === 'turn/start');
  if (lastStart && (!lastEnd || lastStart.seq > lastEnd.seq)) return 'running';
  if (!lastEnd) return entry.activity === 'running' ? 'running' : 'stopped';
  return lastEnd.data?.reason?.kind === 'completed' ? 'success' : 'stopped';
}

function readSnapshot(host, address) {
  return new Promise((resolve, reject) => {
    let done = false;
    let cancel;
    const finish = (error, snapshot) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      cancel?.();
      if (error) reject(error);
      else resolve(snapshot);
    };
    const timeout = setTimeout(() => finish(new Error('DSH 子会话快照超时')), 10000);
    cancel = host.openStream('session/follow', {
      request: { address, maxMessages: 100 },
    }, {
      onItem: value => { if (value?.type === 'snapshot') finish(null, value); },
      onError: error => finish(error),
      onEnd: () => finish(new Error('DSH 子会话流未返回快照')),
    });
    if (done) cancel();
  });
}

async function readEvents(host, address) {
  const snapshot = await readSnapshot(host, address);
  const records = [...(snapshot.records ?? [])];
  let hasMore = snapshot.hasMore;
  for (let pageCount = 0; hasMore && pageCount < 100; pageCount++) {
    const firstSeq = records[0]?.event?.seq;
    if (!Number.isInteger(firstSeq) || firstSeq <= 0) throw new Error('DSH 子会话历史游标无效');
    const page = await host.call('session/page', { request: { address,
      throughSeq: snapshot.cursor, beforeSeq: firstSeq, maxMessages: 100 } });
    if (!page.records?.length) throw new Error('DSH 子会话历史页为空');
    records.unshift(...page.records);
    hasMore = page.hasMore;
  }
  if (hasMore) throw new Error('DSH 子会话历史超出投影页数上限');
  return records.filter(record => record?.type === 'event').map(record => record.event);
}

function createDshSubagentBridge(host, parentId, emit, { intervalMs = 3000 } = {}) {
  const signatures = new Map();
  let closed = false;
  let pending;
  let timer;
  let watching = false;
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void scan(); }, intervalMs);
    timer.unref?.();
  };
  function scan() {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const catalog = await host.call('subagents/list', { parentSessionId: parentId });
      const children = (catalog?.entries ?? []).filter(entry => entry.kind === 'child' && typeof entry.id === 'string');
      let hasRunning = false;
      for (const entry of children) {
        let events;
        try { events = await readEvents(host, { kind: 'subagent', parentSessionId: parentId,
          childSessionId: entry.id, mode: entry.mode }); }
        catch { continue; }
        if (closed) return;
        const event = { kind: 'native-subagent', nativeSessionId: entry.id,
          title: entry.label || 'DSH · 子代理', task: entry.label || '',
          status: childStatus(entry, events), messages: messagesFromEvents(events) };
        if (event.status === 'running') hasRunning = true;
        const signature = JSON.stringify(event);
        if (signatures.get(entry.id) !== signature) {
          signatures.set(entry.id, signature);
          emit(event);
        }
      }
      if (watching || hasRunning) schedule();
    })().catch(() => { /* An older DSH host may not expose the catalog. */ })
      .finally(() => { pending = null; });
    return pending;
  }
  function watch() { watching = true; void scan(); schedule(); }
  function stopWatching() { watching = false; }
  function close() { closed = true; clearTimeout(timer); signatures.clear(); }
  return { scan, watch, stopWatching, close };
}

module.exports = { createDshSubagentBridge, messagesFromEvents, childStatus, readEvents };
