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
    // createThread 的 options 白名单必须保留协作 worker 的免打扰权限键
    // （permissionMode 直连原生档位；workerPermissions 由 ACP 适配器动态解析；
    // turnPermissions 是 Codex worker 的 approvalPolicy+sandbox 组合）
    const permitted = await rt.createThread({ harnessId: adapter.manifest.id, cwd: root,
      options: { permissionMode: 'yolo', workerPermissions: 'full', turnPermissions: { approvalPolicy: 'never', sandboxPolicy: 'dangerFullAccess' } } });
    assert.equal(permitted.options.permissionMode, 'yolo');
    assert.equal(permitted.options.workerPermissions, 'full');
    assert.deepEqual(permitted.options.turnPermissions, { approvalPolicy: 'never', sandboxPolicy: 'dangerFullAccess' });
    await rt.removeThread(permitted.id);
    // 权限模式：空闲热应用失败 → 事务回滚不落账；回合运行中（等审批）→ 挂起，下轮投递前应用
    const modeLog = [];
    let failMode = false;
    const modeAdapter = {
      manifest: { id: 'mode-harness', name: 'Mode', capabilities: {} },
      async open(input) { emit = input.emit; return {}; },
      async send() {},
      async cancel() {}, async respond() {}, async close() {},
      async setPermissionMode(session, mode) { if (failMode) throw new Error('Native mode unavailable'); modeLog.push(mode); },
    };
    rt.adapters.set(modeAdapter.manifest.id, modeAdapter); rt.status[modeAdapter.manifest.id] = { available: true };
    const modeThread = await rt.createThread({ harnessId: modeAdapter.manifest.id, cwd: root });
    await rt.send(modeThread.id, 'warm up');
    emit({ kind: 'completed', finalAnswer: true });
    await until(() => modeThread.status === 'ready' && !modeThread.reviewPending);
    failMode = true;
    await assert.rejects(rt.setOptions(modeThread.id, { permissionMode: 'gone' }), /Native mode unavailable/);
    assert.equal(modeThread.options.permissionMode, undefined, '热应用失败不落账，保持旧值');
    failMode = false;
    await rt.setOptions(modeThread.id, { permissionMode: 'approve' });
    assert.equal(modeThread.options.permissionMode, 'approve');
    assert.deepEqual(modeLog, ['approve'], '空闲时热应用一次');
    await rt.send(modeThread.id, 'run');
    emit({ kind: 'approval', requestId: 'm', method: 'confirm', title: 'Allow?' });
    await until(() => rt.execution.lastTurn(modeThread.id).status === 'waiting_interaction');
    await rt.setOptions(modeThread.id, { permissionMode: 'bypassPermissions' });
    assert.equal(modeThread.options.permissionMode, 'bypassPermissions', '回合运行中选择被接受为挂起档位');
    assert.deepEqual(modeLog, ['approve'], '回合运行中不向原生会话热应用');
    await rt.respondApproval(modeThread.id, 'm', { confirmed: false });
    emit({ kind: 'completed', finalAnswer: true });
    await until(() => modeThread.status === 'ready' && !modeThread.reviewPending);
    await rt.send(modeThread.id, 'next turn');
    assert.deepEqual(modeLog, ['approve', 'bypassPermissions'], '挂起档位在下轮投递前应用');
    emit({ kind: 'completed', finalAnswer: true });
    await until(() => modeThread.status === 'ready' && !modeThread.reviewPending);
    await rt.send(modeThread.id, 'no repeat');
    assert.deepEqual(modeLog, ['approve', 'bypassPermissions'], '已应用档位不重复下发');
    emit({ kind: 'completed', finalAnswer: true });
    await until(() => modeThread.status === 'ready' && !modeThread.reviewPending);
    await rt.removeThread(modeThread.id);
    await rt.close();
    const saved = await rt.store.load();
    assert.equal(saved[0].coreState.turns.find(turn => turn.id === first).status, 'completed');
    const restored = new HostRuntime({ dataDirectory: directory });
    restored.threads = await restored.store.load();
    for (const record of restored.threads) restored.execution.threadCreated(record);
    assert.equal(restored.core.getTurn(first).status, 'completed');
    assert.ok(restored.core.getItemsForTurn(first).some(i => i.type === 'file_change' && i.undone));
    assert.equal(restored.shadowReport().enabled, false);
    await restored.close();
    const lazy = new HostRuntime({ dataDirectory: directory });
    lazy.threads = await lazy.store.loadIndex();
    assert.equal(lazy.threads[0]._storageStub, true, 'cold start reads only the thread index');
    assert.equal(lazy.core.getThread(lazy.threads[0].id), null, 'unopened transcript is absent from Core memory');
    const hydrated = lazy.getThread(lazy.threads[0].id);
    assert.equal(hydrated._storageStub, undefined);
    assert.equal(lazy.core.getTurn(first).status, 'completed', 'opening one task restores only its Core checkpoint');
    await lazy.close();
    console.log('core-runtime: independent turns, waiting/responses, failure, cancel races, persistence passed');
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
