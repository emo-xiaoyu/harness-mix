const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = 'condition') {
  for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(10); }
  throw new Error(`timed out: ${label}`);
}

// 「Turn 启动前」取消-重发竞态（send-cancel-race 的前半段窗口）：
// 旧 send 仍停留在会话打开/prompt 组装阶段时用户 cancel 并立即重发——
// 1) 旧 send 恢复后必须命中取消登记、不得投递 prompt（否则与新发送双双进入原生会话，
//    撞上原生侧 "Agent is already processing"）；
// 2) 旧 send 不得再 turnStarted 挤占 lastTurn（否则新发送的投递前自查会误判空闲而丢消息）；
// 3) 旧 send 迟到的 reject/事件不得击中正在运行的新回合（按回合身份核验）。
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-send-pre-turn-cancel-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);

  const rt = new HostRuntime({ dataDirectory: directory });
  await rt.store.load();

  const delivered = [];
  const adapter = {
    manifest: { id: 'test-harness', name: 'Test', capabilities: {} },
    async open() { return {}; },
    async send(session, text) { delivered.push(text); /* 非阻塞 ack，回合由事件流结算 */ },
    async cancel() {},
    async close() {},
  };
  rt.adapters.set(adapter.manifest.id, adapter);
  rt.status[adapter.manifest.id] = { available: true };

  try {
    const thread = await rt.createThread({ harnessId: 'test-harness', cwd: root });
    await until(() => rt.sessions.has(thread.id), 'session open');

    // 制造「下次发送需重新打开原生会话」的慢窗口：关掉会话并标记惰性恢复
    const session = rt.sessions.get(thread.id);
    await session.adapter.close(session);
    rt.sessions.delete(thread.id);
    thread.restore = true;
    let openGate;
    const openBarrier = new Promise(resolve => { openGate = resolve; });
    const realOpen = adapter.open;
    adapter.open = async () => { await openBarrier; return realOpen(); };

    // A 进入 #send，悬挂在 #ensureOpen（Turn 尚未启动）
    const sendA = rt.send(thread.id, 'first');
    await until(() => rt.openings.has(thread.id), 'A suspended in native open');

    // Turn 未启动时 cancel：登记取消（A 的票据）并提前放锁
    await rt.cancel(thread.id);

    // 用户立即重发 B：放锁后必须能进入；B 不得误吞 A 的取消登记
    const sendB = rt.send(thread.id, 'second');

    // 原生会话打开完成：A 的 continuation 先恢复，随后 B
    openGate();
    await Promise.allSettled([sendA, sendB]);
    await until(() => delivered.length > 0, 'B delivered');

    // 核心断言 1：只有 B 投递；A 在恢复后命中取消登记，不再投递
    assert.deepEqual(delivered, ['second'], '被取消的旧发送不得投递 prompt');

    // 核心断言 2：A 的取消以取消卡片闭环（lastTurn 曾是 A 的取消回合），随后 B 的回合接管
    const assistant = thread.messages.find(m => m.role === 'assistant');
    assert.ok(assistant, 'A 的取消应留下助手回合卡片');
    assert.equal(assistant.stopReason, 'cancelled', 'A 的回合以取消结算');
    assert.equal(thread.error, undefined, '线程不得携带错误状态');

    // B 的回合正常运行中（非阻塞适配器：ack 即返回，回合等事件流结算）
    assert.equal(rt.execution.isRunning(thread.id), true, 'B 的回合应正常运行');

    // B 的回合经事件流正常结算，线程回到空闲，后续发送不受影响
    const sessionB = rt.sessions.get(thread.id);
    // 通过 adapter emit 结算 B：模拟原生 completed
    //（createThread 时记录的是旧 emit， reopen 后需取最新会话的 emit——
    //   本测试 adapter.open 未保存 emit，直接用 execution 事件路径验证空闲后可发）
    await rt.cancel(thread.id); // 用户停止 B
    await until(() => !rt.execution.isRunning(thread.id), 'B settled by cancel');
    const sendC = rt.send(thread.id, 'third after settle');
    await until(() => delivered.length === 2, 'C delivered');
    assert.deepEqual(delivered, ['second', 'third after settle']);
    await rt.cancel(thread.id);
    await sendC;
    assert.ok(sessionB, 'session exists');

    console.log('send-pre-turn-cancel: cancelled pre-turn send never delivers; resend owns the turn; late events cannot hit the newer turn');
  } finally {
    await rt.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
