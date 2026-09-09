const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol, routeModel } = require('../src/main/native/protocol');
const wait = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out'); };

async function main() {
  const root = path.resolve('output/native-protocol', String(Date.now()));
  await fs.mkdir(root, { recursive: true });
  const runtime = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await runtime.store.load();
  let emit;
  const answers = [];
  const adapter = { manifest: { id: 'pi', name: 'Pi', capabilities: { streaming: true, models: true, approvals: true, questions: true, resume: true } },
    async open(input) { emit = input.emit; return {}; },
    async describe() { return { models: [{ id: 'demo', name: 'Demo', provider: 'test' }], thinkingLevels: [], permissionModes: [] }; },
    async send() {}, async cancel() {}, async close() {},
    async respond(session, id, answer) { answers.push({ id, answer }); } };
  runtime.adapters.set('pi', adapter); runtime.status.pi = { available: true };
  const events = [];
  const bridge = new NativeProtocol(runtime, event => events.push(event));
  try {
    const esbuild = require('esbuild');
    const schemaPath = path.join(root, 'schemas.cjs');
    await esbuild.build({ entryPoints: ['src/native-ui/shared-contracts/src/index.ts'], outfile: schemaPath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const schemas = require(schemaPath);
    schemas.harnessInspectionSchema.parse(await bridge.inspect('pi'));
    schemas.harnessPluginListResultSchema.parse(await bridge.request('codexhost/harness/plugins/list'));
    const started = await bridge.request('thread/start', { cwd: root, model: routeModel('pi') });
    const threadId = started.thread.id;
    schemas.threadInspectionSchema.parse(await bridge.request('codexhost/thread/inspect', { threadId }));
    const turn = await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'test' }] });
    assert.ok(runtime.core.getTurn(turn.turn.id), 'Native turn IDs come from the existing ProtocolCore');
    emit({ kind: 'thinking-delta', text: 'reason' });
    emit({ kind: 'text-delta', text: 'hello' });
    emit({ kind: 'text-delta', text: ' world' });
    emit({ kind: 'tool', toolCallId: 't', title: 'Read', state: 'running', input: '{}' });
    emit({ kind: 'tool', toolCallId: 't', title: 'Read', state: 'completed', output: 'done' });
    emit({ kind: 'approval', requestId: 'permission', method: 'confirm', title: 'Allow?' });
    const approval = events.find(e => e.id?.startsWith('harness-mix:approval:'));
    assert.equal(answers.length, 0, 'Approval is not fabricated');
    await bridge.respond({ id: approval.id, result: { decision: 'decline' } });
    assert.deepEqual(answers[0], { id: 'permission', answer: { confirmed: false } });
    emit({ kind: 'approval', requestId: 'question', method: 'input', title: 'Name?' });
    const question = events.find(e => e.method === 'item/tool/requestUserInput');
    await bridge.respond({ id: question.id, result: { answers: { question: { answers: ['Alice'] } } } });
    assert.equal(answers[1].answer.value, 'Alice');
    emit({ kind: 'file-change', changes: [{ path: 'a.txt', changeType: 'added', before: '', after: 'hello', complete: true }] });
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.threads[0].reviewPending);
    assert.equal(events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join(''), 'hello world');
    assert.ok(events.some(e => e.method === 'item/completed' && e.params.item.type === 'mcpToolCall'));
    assert.ok(events.some(e => e.method === 'turn/diff/updated' && e.params.diff.includes('a.txt')));
    assert.equal(events.filter(e => e.method === 'turn/completed').length, 1);
    const history = await bridge.request('thread/read', { threadId });
    assert.equal(history.thread.turns[0].status, 'completed');
    await bridge.request('thread/name/set', { threadId, name: 'Local Core' });
    await bridge.request('thread/archive', { threadId });
    assert.equal(runtime.threads[0].archived, true);
    await bridge.request('thread/unarchive', { threadId });
    await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'cancel' }] });
    await bridge.request('turn/interrupt', { threadId });
    await wait(() => !runtime.threads[0].reviewPending);
    assert.equal(events.filter(e => e.method === 'turn/completed').at(-1).params.turn.status, 'interrupted');
    await assert.rejects(bridge.request('turn/steer', { threadId }), /does not support/);
    assert.equal(await bridge.request('thread/start', { model: 'official-model' }), undefined, 'Official Codex requests pass through');
    console.log('PASS: local Core ownership, renderer schemas, streaming, tools, reject/input routing, diffs, history, rename/archive and cancellation');
  } finally { bridge.close(); await runtime.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
