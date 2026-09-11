const assert = require('node:assert/strict');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol } = require('../src/main/native/protocol');
const wait = async fn => { for (let n = 0; n < 400; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out'); };

(async () => {
  const root = path.resolve('output/rollback-test', String(Date.now()));
  await require('node:fs/promises').mkdir(root, { recursive: true });
  const runtime = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await runtime.store.load();
  let forks = 0;
  const adapter = {
    manifest: { id: 'pi', name: 'Pi', capabilities: { fork: true, forkFromMessage: true } },
    async open({ thread }) { return { nativeSessionId: thread.nativeSessionId }; },
    async close() {}, async describe() { return { models: [] }; },
    async send(_session, text, hooks) { hooks.emit({ kind: 'text-delta', text }); hooks.emit({ kind: 'completed', finalAnswer: true }); },
    async fork(_thread, { message }) { assert.equal(message.text, 'kept'); forks++; return { session: { nativeSessionId: 'forked-native' } }; },
  };
  runtime.adapters.set('pi', adapter); runtime.status.pi = { available: true };
  const bridge = new NativeProtocol(runtime, () => {});
  try {
    const { thread } = await bridge.request('thread/start', { cwd: root, model: 'codexhost/pi-native' });
    for (const text of ['kept', 'removed']) {
      await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
      await wait(() => !runtime.execution.isRunning(thread.id) && !runtime.threads[0].reviewPending);
    }
    await assert.rejects(bridge.request('thread/rollback', { threadId: thread.id, numTurns: 3 }), /回退轮数/);
    const rollback = await bridge.request('thread/rollback', { threadId: thread.id, numTurns: 1 });
    assert.equal(forks, 1);
    assert.equal(rollback.thread.turns.length, 1);
    assert.equal(runtime.threads[0].nativeSessionId, 'forked-native');
    assert.equal(runtime.threads[0].messages.length, 2);
    assert.ok(!rollback.thread.turns.flatMap(t => t.items).some(i => i.type === 'agentMessage' && i.text === 'removed'));
    const empty = await bridge.request('thread/rollback', { threadId: thread.id, numTurns: 1 });
    assert.equal(empty.thread.turns.length, 0);
    assert.notEqual(runtime.threads[0].nativeSessionId, 'forked-native');
    await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'replacement' }] });
    await wait(() => !runtime.execution.isRunning(thread.id) && !runtime.threads[0].reviewPending);
    assert.equal(bridge.projectThread(runtime.threads[0]).turns.length, 1);
    const stored = await runtime.store.load();
    assert.equal(stored[0].coreState.turns.length, 1);
    assert.equal(stored[0].rewindHistory.length, 2);
    console.log('PASS: native fork boundary, empty-session rewind, resend, persistence and invalid counts');
  } finally { bridge.close(); await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
