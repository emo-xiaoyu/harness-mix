const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = 'condition') {
  for (let i = 0; i < 500; i++) { if (fn()) return; await sleep(10); }
  throw new Error(`timed out: ${label}`);
}

// /delegate 委派等待链（#awaitDelegation）：
// 非阻塞适配器（Pi 家族收到 prompt ack 即返回）的回合由异步事件流结算，
// 旧实现只兜底 30 秒——子任务超过 30 秒父线程就被误判成功且丢失结果。
// 修复后：等待至子任务真正结算（上限 delegationTimeoutMs，对齐协作编排 30 分钟），
// 超时主动取消子任务并向父线程回报错误。
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-delegation-await-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);

  const rt = new HostRuntime({ dataDirectory: directory, delegationTimeoutMs: 600 });
  await rt.store.load();

  const emits = new Map();
  const cancels = new Map();
  const adapter = {
    manifest: { id: 'test-harness', name: 'Test', capabilities: {} },
    async open(input) { emits.set(input.thread.id, input.emit); return {}; },
    // 非阻塞：ack 即返回，Turn 结算完全由后续 emit 驱动（Pi 家族形态）
    async send(session) {},
    async cancel(session) { cancels.set(session.threadId, (cancels.get(session.threadId) ?? 0) + 1); },
    async close() {},
  };
  rt.adapters.set(adapter.manifest.id, adapter);
  rt.status[adapter.manifest.id] = { available: true };

  try {
    // 1. 正常路径：adapter.send 早已返回，子任务经异步事件结算后答案回投父线程
    const parent = await rt.createThread({ harnessId: 'test-harness', cwd: root });
    const { child, turn } = await rt.delegateTask({ fromThreadId: parent.id, harnessId: 'test-harness', task: '干活' });
    assert.equal(rt.execution.isRunning(parent.id), true, '父线程协作 Turn 运行中');
    await sleep(150); // adapter.send 已返回而子任务未结算：父线程必须继续等待
    assert.equal(rt.execution.isRunning(parent.id), true, '子任务未结算时父线程不得提前收尾');
    emits.get(child.id)({ kind: 'text-delta', text: '子任务结论' });
    emits.get(child.id)({ kind: 'completed', finalAnswer: true });
    await until(() => !rt.execution.isRunning(parent.id), 'parent settles after child completes');
    const doneItem = rt.core.getItemsForTurn(turn.id).find(i => i.type === 'tool_call');
    assert.equal(doneItem.status, 'completed', '子任务成功后父线程协作工具项结算为完成');
    assert.match(JSON.stringify(doneItem), /子任务结论/, '子任务最终文本回投到父线程');
    assert.equal(cancels.get(child.id) ?? 0, 0, '正常结算不触发取消');

    // 2. 超时路径：子任务永不结算且持续有事件（看门狗管不到），超过 delegationTimeoutMs
    //    父线程报错收尾且子任务被主动取消（旧实现 30s 后误判成功、子任务成孤儿）
    const parent2 = await rt.createThread({ harnessId: 'test-harness', cwd: root });
    const d2 = await rt.delegateTask({ fromThreadId: parent2.id, harnessId: 'test-harness', task: '长跑任务' });
    const heartbeat = setInterval(() => emits.get(d2.child.id)?.({ kind: 'text-delta', text: '.' }), 100);
    try {
      await until(() => !rt.execution.isRunning(parent2.id), 'parent settles on delegation timeout');
    } finally {
      clearInterval(heartbeat);
    }
    const failItem = rt.core.getItemsForTurn(d2.turn.id).find(i => i.type === 'tool_call');
    assert.equal(failItem.status, 'error', '超时后父线程协作工具项结算为错误');
    assert.match(JSON.stringify(failItem), /超时|未结算/, '错误说明包含超时原因');
    assert.ok((cancels.get(d2.child.id) ?? 0) >= 1, '超时主动取消子任务，不留孤儿进程');

    console.log('delegation-await-test: parent awaits async child settlement; timeout cancels the child and reports an error');
  } finally {
    await rt.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
