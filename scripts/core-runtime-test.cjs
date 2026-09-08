const { ParityObserver } = require('./support/parity-observer.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); }
  throw new Error('timed out');
}
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-core-runtime-'));
  const root = path.join(directory, 'workspace'); await fs.mkdir(root);
  const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: directory });
  await rt.store.load();
  let emit, sent = 0, mode = 'hold', rejectResponse = false;
  const adapter = {
    manifest: { id: 'test-harness', name: 'Test', capabilities: {} },
    async open(input) { emit = input.emit; return {}; },
    async send() {
      sent++;
      const turn = rt.execution.lastTurn(thread.id);
      assert.equal(turn.status, 'running', 'Core Turn exists before native send');
      if (mode === 'failure') throw new Error('native failure');
    },
    async cancel() { emit({ kind: 'completed', finalAnswer: true }); emit({ kind: 'text-delta', text: 'LATE' }); },
    async respond() { if (rejectResponse) throw new Error('response failed'); },
    async close() {},
  };
  rt.adapters.set(adapter.manifest.id, adapter); rt.status[adapter.manifest.id] = { available: true };
  const thread = await rt.createThread({ harnessId: adapter.manifest.id, cwd: root });
  try {
    await rt.send(thread.id, 'hello');
    const first = thread.messages.at(-1).coreTurnId;
    const notices = []; const unsubscribe = rt.subscribe(event => notices.push(event));
    emit({ kind: 'status', text: 'native progress' });
    assert.ok(notices.some(event => event.type === 'toast' && event.threadId === thread.id));
    unsubscribe();
    emit({ kind: 'approval', requestId: 'a', method: 'confirm', title: 'Allow?' });
    emit({ kind: 'approval', requestId: 'q', method: 'input', title: 'Name?' });
    assert.equal(rt.execution.lastTurn(thread.id).status, 'waiting_interaction');
    rejectResponse = true;
    await assert.rejects(rt.respondApproval(thread.id, 'a', {}), /response failed/);
    assert.equal(rt.execution.lastTurn(thread.id).status, 'waiting_interaction');
    rejectResponse = false;
    await rt.respondApproval(thread.id, 'a', { confirmed: true });
    assert.equal(rt.execution.lastTurn(thread.id).status, 'waiting_interaction');
    await rt.respondApproval(thread.id, 'q', { value: 'test' });
    assert.equal(rt.execution.lastTurn(thread.id).status, 'running');
    emit({ kind: 'thinking-delta', text: 'think' });
    emit({ kind: 'text-delta', text: 'answer' });
    emit({ kind: 'usage', usage: { inputTokens: 10 } });
    await fs.writeFile(path.join(root, 'change.txt'), 'Core review content');
    emit({ kind: 'completed', finalAnswer: true });
    await until(() => (thread.status === 'ready' && !thread.reviewPending));
    assert.equal(thread.messages.at(-1).coreTurn.status, 'completed');
    const completedMessage = thread.messages.at(-1);
    const review = await rt.readReview(thread, completedMessage);
    assert.equal(review.files[0].type, 'file_change');
    assert.equal(review.files[0].source, 'snapshot');
    assert.equal((await rt.readReview(thread, completedMessage, 'change.txt')).rows[0].kind, 'add');
    await rt.undoFile(thread.id, completedMessage.id, 'change.txt');
    assert.equal(completedMessage.coreReview.files[0].undone, true);
    await assert.rejects(fs.access(path.join(root, 'change.txt')));
    assert.ok(thread.messages.at(-1).coreItems.some(i => i.phase === 'final' && i.content === 'answer'));
    assert.deepEqual(rt.shadowReport().mismatches, []);
    await rt.send(thread.id, 'cancel');
    assert.notEqual(thread.messages.at(-1).coreTurnId, first);
    await rt.cancel(thread.id);
    await until(() => (thread.status === 'ready' && !thread.reviewPending));
    assert.equal(thread.messages.at(-1).coreTurn.status, 'cancelled');
    assert.equal(thread.messages.at(-1).text, '');
    mode = 'failure';
    await rt.send(thread.id, 'fail');
    await until(() => thread.status === 'error' && !thread.reviewPending);
    assert.equal(thread.messages.at(-1).coreTurn.status, 'error');
    mode = 'hold';
    let release;
    const begin = rt.reviews.begin.bind(rt.reviews);
    rt.reviews.begin = () => new Promise(resolve => { release = resolve; });
    const before = sent;
    const pending = rt.send(thread.id, 'cancel during preparation');
    await until(() => release);
    await rt.cancel(thread.id);
    release(undefined); await pending;
    await until(() => (thread.status === 'ready' && !thread.reviewPending));
    assert.equal(sent, before);
    assert.equal(thread.messages.at(-1).coreTurn.status, 'cancelled');
    rt.reviews.begin = begin;
    assert.deepEqual(rt.shadowReport().errors, []);
    await rt.close();
    const saved = await rt.store.load();
    assert.equal(saved[0].messages.find(m => m.coreTurnId === first).coreTurn.status, 'completed');
    const restored = new HostRuntime({ dataDirectory: directory });
    restored.threads = await restored.store.load();
    for (const record of restored.threads) restored.execution.threadCreated(record);
    assert.equal(restored.core.getTurn(first).status, 'completed');
    assert.ok(restored.core.getItemsForTurn(first).some(i => i.type === 'file_change' && i.undone));
    assert.equal(restored.shadowReport().enabled, false);
    await restored.close();
    console.log('core-runtime: independent turns, waiting/responses, failure, cancel races, persistence passed');
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
