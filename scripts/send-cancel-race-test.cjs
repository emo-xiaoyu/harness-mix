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

// 取消-重发竞态（票据所有制发送锁）：
// 流式进行中 cancel 会提前放锁让新发送进入（设计如此，避免卡死的 adapter.send 永久锁线程），
// 但旧 send 退出时的 finally 不得误删新发送的锁——否则第三个发送会与在途发送并发，
// 撞上原生侧 "Agent is already processing"。cancelRequests  likewise 按票据隔离，
// 上一代发送遗留的取消登记不得被新发送的消费点误吞。
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-send-cancel-race-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);

  const rt = new HostRuntime({ dataDirectory: directory });
  await rt.store.load();

  const emits = new Map();
  const pendingSends = new Map(); // threadId -> resolve：adapter.send 阻塞至 cancel（模拟原生 abort 才结算）
  const adapter = {
    manifest: { id: 'test-harness', name: 'Test', capabilities: {} },
    async open(input) { emits.set(input.thread.id, input.emit); return {}; },
    async send(session) { await new Promise(resolve => pendingSends.set(session.threadId, resolve)); },
    async cancel(session) { pendingSends.get(session.threadId)?.(); pendingSends.delete(session.threadId); },
    async close() {},
  };
  rt.adapters.set(adapter.manifest.id, adapter);
  rt.status[adapter.manifest.id] = { available: true };

  try {
    const thread = await rt.createThread({ harnessId: 'test-harness', cwd: root });

    // A 进入流式（adapter.send 阻塞中）
    const sendA = rt.send(thread.id, 'first');
    await until(() => pendingSends.has(thread.id));

    // 流式中 cancel：立即放锁 + 作废旧票据；adapter.cancel 让 A 的 send 返回
    await rt.cancel(thread.id);
    await sendA; // A 的 finally 在此执行——票据已作废，不得触碰锁

    // 立即重发 B：cancel 已放锁，必须能进入
    const sendB = rt.send(thread.id, 'second');
    await until(() => pendingSends.has(thread.id));

    // 关键回归断言 1：B 在途时第三个发送必须被拒（若 A 的 finally 误删锁，这里会漏成并发）
    await assert.rejects(rt.send(thread.id, 'third'), /正在执行/);

    // 关键回归断言 2：B 的回合仍在运行——A 遗留的取消登记不得被 B 的消费点误吞
    await sleep(50);
    assert.equal(rt.execution.isRunning(thread.id), true, 'B 的回合不得被上一代取消登记误结算');
    assert.equal(thread.error, undefined, 'B 不得携带取消/错误状态');

    // 收尾：取消 B，B 的 send 返回；锁由 B 自己的 finally（或 cancel）正常回收
    await rt.cancel(thread.id);
    await sendB;
    await until(() => !rt.sending.has(thread.id));

    // 完整结算后新发送 C 可用：线程没有因竞态永久锁定
    const sendC = rt.send(thread.id, 'third after settle');
    await until(() => pendingSends.has(thread.id));
    await rt.cancel(thread.id);
    await sendC;
    await until(() => !rt.sending.has(thread.id));

    console.log('send-cancel-race-test: stale send finally cannot clobber the newer send lock; stale cancel requests are ticket-scoped');
  } finally {
    await rt.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
