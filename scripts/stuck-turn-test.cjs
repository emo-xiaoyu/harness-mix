const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(10); }
  throw new Error('timed out');
}

// 卡死回合看门狗：原生 Harness wedge（零事件）时回合必须按超时自动结算；
// 活跃回合与等待审批的合法静默回合不得被误杀。
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-stuck-turn-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);

  const rt = new HostRuntime({ dataDirectory: directory, stuckTurnMs: 300, stuckSweepMs: 50 });
  await rt.store.load();

  const emits = new Map();
  const cancels = new Map(); // threadId -> adapter.cancel 次数（看门狗级联取消断言）
  const adapter = {
    manifest: { id: 'test-harness', name: 'Test', capabilities: {} },
    async open(input) { emits.set(input.thread.id, input.emit); return {}; },
    async send(session) {},
    async cancel(session) { cancels.set(session.threadId, (cancels.get(session.threadId) ?? 0) + 1); },
    async close() {},
  };
  rt.adapters.set(adapter.manifest.id, adapter);
  rt.status[adapter.manifest.id] = { available: true };

  try {
    // 1. 持续有事件的活跃回合：看门狗不得误伤
    const active = await rt.createThread({ harnessId: 'test-harness', cwd: root });
    await rt.send(active.id, 'keep emitting');
    const emitActive = emits.get(active.id);
    for (let i = 0; i < 8; i++) { emitActive({ kind: 'text-delta', text: '.' }); await sleep(80); }
    assert.equal(rt.execution.isRunning(active.id), true, 'active turn must survive the watchdog');
    emitActive({ kind: 'completed', finalAnswer: true });
    await until(() => active.status === 'ready' && !active.reviewPending);

    // 2. 等待用户审批的回合是合法静默：超过阈值也不得结算
    const approval = await rt.createThread({ harnessId: 'test-harness', cwd: root });
    await rt.send(approval.id, 'needs approval');
    const emitApproval = emits.get(approval.id);
    emitApproval({ kind: 'approval', requestId: 'r1', method: 'confirm', title: 'Allow?' });
    await sleep(700);
    assert.equal(rt.execution.isRunning(approval.id), true, 'approval-waiting turn is legitimate silence and must survive');
    emitApproval({ kind: 'interaction-responded', requestId: 'r1' });
    emitApproval({ kind: 'completed', finalAnswer: true });
    await until(() => approval.status === 'ready' && !approval.reviewPending);

    // 3. 零事件 wedge 回合：超时后自动按错误结算，UI 不再永远转圈
    const stuck = await rt.createThread({ harnessId: 'test-harness', cwd: root });
    await rt.send(stuck.id, 'wedged session');
    await until(() => stuck.status === 'error');
    assert.match(stuck.error, /卡死/);
    // 结算的同时级联取消原生会话：否则僵尸进程常驻，下一回合撞上原生侧占用报错
    await until(() => (cancels.get(stuck.id) ?? 0) >= 1);
    const turn = rt.execution.lastTurn(stuck.id);
    assert.equal(turn.status, 'error');
    await until(() => !stuck.reviewPending);
    const open = rt.core.getItemsForTurn(turn.id).filter(item => !['completed', 'error', 'cancelled'].includes(item.status));
    assert.equal(open.length, 0, 'watchdog settlement finalizes every open item');
    assert.equal(cancels.get(active.id) ?? 0, 0, '正常完成的活跃回合不触发 adapter.cancel');
    assert.equal(cancels.get(approval.id) ?? 0, 0, '审批等待后正常完成的回合不触发 adapter.cancel');

    console.log('stuck-turn-test: active/approval-waiting turns survive; wedged zero-event turn auto-settles and finalizes items');
  } finally {
    await rt.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
