const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol } = require('../src/main/native/protocol');
const { projectEvent } = require('../src/main/adapters/claude');
const { acpAdapter } = require('../src/main/adapters/acp');
const { JsonlProcess } = require('../src/main/host/jsonl');

async function checkTransport() {
  // A real JSONL child exercises structured-only ACP output and unsupported
  // reverse requests without requiring an installed agent or model account.
  const code = `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'session/prompt') {
        const update = { sessionUpdate: 'tool_call', toolCallId: 'call', status: 'completed', rawInput: { path: 'x' }, rawOutput: { value: 42 } };
        console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test', update } }));
      }
      if (m.method) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'session/new' ? { sessionId: 'test' } : m.method === 'session/prompt' ? { stopReason: 'end_turn' } : {} }));
    });`;
  const adapter = acpAdapter({ id: 'test-acp', name: 'Test', args: [],
    resolveCommand: () => ({ command: process.execPath, args: ['-e', code] }) }).create();
  const events = [];
  const session = await adapter.open({ thread: { cwd: process.cwd() }, emit: e => events.push(e) });
  try {
    await adapter.send(session, 'read', { emit: e => events.push(e) });
    const tool = events.find(e => e.kind === 'tool');
    assert.equal(tool.input, '{"path":"x"}');
    assert.equal(tool.output, '{"value":42}');
  } finally { await adapter.close(session); }
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const child = new JsonlProcess(process.execPath, ['-e', `
    console.log(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'unhandled/tool' }));
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => console.log(JSON.stringify({ method: 'observed', params: JSON.parse(line) })));
  `], {}, { onEvent: resolveResponse });
  let timer;
  try {
    const observed = await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('reverse request timeout')), 5000); })]);
    assert.match(observed.params.error.message, /Unsupported native client request/);
    assert.equal(observed.params.result, undefined);
  } finally { clearTimeout(timer); child.stop(); }
}

async function main() {
  await checkTransport();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-tool-concurrency-'));
  const rt = new HostRuntime({ dataDirectory: directory });
  const notifications = [];
  const protocol = new NativeProtocol(rt, event => notifications.push(event));
  await rt.store.load();
  const emitters = new Map();
  const sent = [];
  for (const id of ['mock-claude', 'mock-acp']) {
    rt.adapters.set(id, { manifest: { id, name: id, capabilities: {} },
      async open({ thread, emit }) { emitters.set(thread.id, emit); return {}; },
      async send(session) { sent.push(session.threadId); }, async close() {} });
    rt.status[id] = { available: true };
  }
  try {
    const a = await rt.createThread({ harnessId: 'mock-claude', cwd: directory });
    const b = await rt.createThread({ harnessId: 'mock-acp', cwd: directory });
    assert.deepEqual(await protocol.request('thread/queue/list', { threadId: a.id }), { data: [], nextCursor: null });
    await protocol.request('thread/metadata/update', { threadId: a.id, gitInfo: { branch: 'main', sha: 'abc' } });
    const metadata = await protocol.request('thread/metadata/update', { threadId: a.id, gitInfo: { branch: null } });
    assert.deepEqual(metadata.thread.gitInfo, { sha: 'abc', branch: null, originUrl: null });
    assert.equal(b.gitInfo, undefined);
    assert.equal((await rt.store.load()).find(t => t.id === a.id).gitInfo.sha, 'abc');
    // Yield after opening, before turn creation; both tasks must still detect
    // concurrency when the history lookups complete at the same time.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    rt.history.context = async () => { await gate; return {}; };
    const prompt = '[context](harness-mix://session/example) run tools';
    const first = rt.send(a.id, prompt);
    const second = rt.send(b.id, prompt);
    await assert.rejects(rt.send(a.id, 'duplicate'), /任务正在执行/);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(new Set(sent), new Set([a.id, b.id]));
    assert.equal(sent.length, 2);
    assert.equal(a.messages.at(-1).concurrent, true);
    assert.equal(b.messages.at(-1).concurrent, true);
    const emitA = emitters.get(a.id);
    const emitB = emitters.get(b.id);
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'same-id', name: 'Read', input: { file_path: 'a.txt' } }] } };
    for (const event of projectEvent(call)) emitA(event);
    emitB({ kind: 'tool', toolCallId: 'same-id', title: 'Read', state: 'running', input: 'b.txt' });
    assert.equal(notifications.filter(n => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall').length, 0);
    for (const event of projectEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'same-id', content: [{ type: 'text', text: 'only A' }] }] } })) emitA(event);
    emitB({ kind: 'tool', toolCallId: 'same-id', state: 'error', output: 'only B failed' });
    const completed = notifications.filter(n => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall');
    assert.equal(completed.length, 2);
    assert.equal(completed.find(n => n.params.threadId === a.id).params.item.result.content[0].text, 'only A');
    assert.equal(completed.find(n => n.params.threadId === b.id).params.item.error.message, 'only B failed');
    assert.equal(a.tools[0].input, '{"file_path":"a.txt"}');
    assert.equal(a.tools[0].output, 'only A');
    assert.equal(b.tools[0].output, 'only B failed');
    emitB({ kind: 'tool', toolCallId: 'same-id', state: 'error', output: { error: 'late detail' } });
    const late = notifications.filter(n => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall').at(-1);
    assert.equal(late.params.threadId, b.id);
    assert.equal(late.params.item.result.content[0].text, '{"error":"late detail"}');
    emitA({ kind: 'completed', finalAnswer: true });
    assert.equal(rt.execution.isRunning(b.id), true);
    emitB({ kind: 'completed', finalAnswer: true });
    const failed = projectEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'native failure' }] } });
    assert.equal(failed[0].state, 'error');
    assert.equal(failed[0].output, 'native failure');
  } finally {
    protocol.close();
    await rt.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log('tool-concurrency: simultaneous mixed harness turns, duplicate submit, native tool results and notification isolation PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
