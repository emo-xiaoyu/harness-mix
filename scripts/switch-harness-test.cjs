const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { CAP, buildHandoffContext, composeHandoffEnvelope } = require('../src/main/host/handoff');

/**
 * 跨 Harness 原地切换（switchHarness）脚本级测试：
 * 双假 Adapter 注入 → A 会话产出历史 → /switch 到 B → 信封注入校验 →
 * 切回 A 的原生恢复校验 → 守卫边界 → 持久化校验。
 * 运行：npm run test:switch-harness
 */
const wait = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

function fakeHarness(id, name) {
  const state = { sent: [], opens: [], closed: 0, hold: null, withFileChange: false, openError: null, openWait: null, sendError: null };
  const adapter = {
    manifest: { id, name, aliases: [id], capabilities: {} },
    async open(input) {
      state.opens.push({ restore: input.thread.restore === true, nativeSessionId: input.thread.nativeSessionId, nativeSessionFile: input.thread.nativeSessionFile });
      if (state.openWait) await state.openWait;
      if (state.openError) throw new Error(state.openError);
      return { nativeSessionId: input.thread.nativeSessionId };
    },
    async send(session, text, hooks) {
      state.sent.push(text);
      if (state.sendError) throw new Error(state.sendError);
      if (state.hold) { state.hold.hooks = hooks; return; } // 挂起：Turn 保持 running，等待测试手动 settle
      if (state.withFileChange) hooks.emit({ kind: 'file-change', changes: [{ path: 'src/login.ts', before: '', after: 'x', complete: true, changeType: 'added' }] });
      hooks.emit({ kind: 'text-delta', text: `${name} 回复` });
      hooks.emit({ kind: 'completed', finalAnswer: true });
    },
    async cancel() {},
    async close() { state.closed++; },
  };
  return { adapter, state };
}

async function main() {
  const longSolution = `方案开头-${'x'.repeat(5000)}-方案结尾`;
  const optimized = buildHandoffContext({
    cwd: 'E:/project', title: '登录重构', messages: [
      { role: 'user', text: '先分析问题' },
      { role: 'assistant', text: '初步判断' },
      { role: 'user', text: '给出完整方案' },
      { role: 'assistant', text: longSolution },
    ],
  });
  assert.deepEqual(optimized.conversationTail.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(optimized.conversationTail.at(-1).text, longSolution, '最新方案应获得更大的交接预算');
  assert.ok(optimized.conversationTail.reduce((sum, message) => sum + message.text.length, 0) <= CAP.totalChars);
  assert.match(composeHandoffEnvelope({ fromHarnessId: 'a', context: {}, intent: 'review' }), /Do not modify files/);
  assert.match(composeHandoffEnvelope({ fromHarnessId: 'a', context: {}, intent: 'reanalyze' }), /Reanalyze the task independently/);

  await fs.mkdir('output', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('output/switch-harness-'));
  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt.store.load();
  const a = fakeHarness('a', 'Alpha');
  const b = fakeHarness('b', 'Beta');
  rt.adapters.set('a', a.adapter); rt.status.a = { available: true };
  rt.adapters.set('b', b.adapter); rt.status.b = { available: true };
  const threadOf = id => rt.threads.find(t => t.id === id);
  const settle = async id => { await wait(() => !rt.execution.isRunning(id)); await wait(() => !threadOf(id).reviewPending); };

  try {
    // 1) 在 A 上产出会话历史（含一次文件变更）
    a.state.withFileChange = true;
    const thread = await rt.createThread({ harnessId: 'a', cwd: root });
    const aNativeId = thread.nativeSessionId;
    assert.equal(a.state.opens.length, 1);
    assert.equal(a.state.opens[0].restore, false);
    await rt.send(thread.id, '帮我重构登录模块');
    await settle(thread.id);
    assert.equal(a.state.sent.length, 1);
    assert.ok(!a.state.sent[0].includes('[Harness Mix handoff]'), '未切换时不得注入信封');
    assert.equal(thread.messages.find(m => m.role === 'assistant').text, 'Alpha 回复');

    // 2) 指令菜单含 /switch，且候选里排除当前 Harness
    const commands = await rt.listCommands({ threadId: thread.id });
    const entry = commands.find(c => c.id === 'switch');
    assert.ok(entry, '指令菜单应包含 /switch');
    assert.ok(entry.description.includes('Beta') && !entry.description.includes('Alpha'), '候选只列其他可用 Harness');

    // 3) /switch 到 B（带备注；按 Harness 名解析，大小写不敏感）
    await rt.send(thread.id, '/switch Beta 优先把测试补完');
    assert.equal(thread.harnessId, 'b');
    assert.equal(thread.harnessChain.length, 1);
    assert.equal(thread.harnessChain[0].harnessId, 'a');
    assert.equal(thread.harnessChain[0].nativeSessionId, aNativeId);
    assert.equal(thread.pendingHandoff.fromHarnessId, 'a');
    assert.equal(thread.pendingHandoff.note, '优先把测试补完');
    assert.match(thread.pendingHandoff.checkpointId, /^handoff_[a-f0-9]{24}$/);
    const firstCheckpointId = thread.pendingHandoff.checkpointId;
    const checkpointBeforeSend = rt.handoffs.get(thread.id, firstCheckpointId);
    assert.equal(checkpointBeforeSend.intent, 'continue');
    assert.equal(checkpointBeforeSend.fileState.files.some(file => file.path === 'src/login.ts' && file.changeType === 'added'), true);
    assert.equal(rt.handoffs.owned(thread.id, firstCheckpointId).status, 'ready');
    assert.equal(b.state.opens[0].restore, false, '新 Harness 上是全新原生会话');
    assert.equal(thread.restore, undefined, '目标 Session 打开后清理瞬态 restore 标记');
    assert.equal(thread.pendingHandoff.phase, 'ready');
    assert.equal(rt.sessions.has(thread.id), true, '目标 Harness 连接成功后才完成切换');
    assert.equal(a.state.closed, 1);
    assert.equal(b.state.opens.length, 1, '切换阶段预先连接目标 Harness');
    assert.equal(thread.messages.filter(m => m.role === 'user').length, 1, '/switch 指令本身不落在会话里');
    await assert.rejects(rt.switchHarness(thread.id, 'a'), /上一次 Harness 接力尚未完成/);
    assert.ok((await rt.listCommands({ threadId: thread.id })).some(command => command.id === 'switch-cancel'));

    // 4) 切换后首轮：信封注入 prompt，可见消息保持干净，注入后清除标记
    await rt.send(thread.id, '继续');
    await settle(thread.id);
    assert.equal(b.state.opens.length, 1, '首轮发送复用切换阶段已连接的目标 Session');
    assert.equal(b.state.opens[0].restore, false);
    assert.notEqual(thread.nativeSessionId, aNativeId);
    assert.match(b.state.sent[0], /\[Harness Mix handoff\]/);
    assert.match(b.state.sent[0], /untrusted historical data/);
    assert.match(b.state.sent[0], /帮我重构登录模块/);
    assert.match(b.state.sent[0], /Alpha 回复/);
    assert.match(b.state.sent[0], /"path":"src\/login\.ts","changeType":"added"/);
    assert.match(b.state.sent[0], /优先把测试补完/);
    const visible = thread.messages.filter(m => m.role === 'user').at(-1);
    assert.equal(visible.text, '继续', '信封不进用户可见消息');
    assert.equal(thread.pendingHandoff, undefined, '信封发送成功后标记已清除');
    assert.equal(rt.handoffs.owned(thread.id, firstCheckpointId).status, 'active');

    // 5) 第二轮起不再注入
    await rt.send(thread.id, '第二步');
    await settle(thread.id);
    assert.ok(!b.state.sent[1].includes('[Harness Mix handoff]'), '信封只注入一次');

    // 6) 切回 A：原生会话引用恢复并在提交切换前验证连接，chain 压栈两条
    await rt.send(thread.id, '/switch a');
    assert.equal(thread.harnessId, 'a');
    assert.equal(thread.harnessChain.length, 2);
    assert.equal(thread.harnessChain[1].harnessId, 'b');
    assert.equal(thread.nativeSessionId, aNativeId, '切回恢复原原生会话标识');
    assert.equal(thread.restore, undefined);
    assert.equal(a.state.opens.length, 2);
    assert.equal(a.state.opens[1].restore, true, '切回走原生恢复路径');
    assert.equal(a.state.opens[1].nativeSessionId, aNativeId);
    await rt.send(thread.id, '我回来了');
    await settle(thread.id);
    assert.match(a.state.sent[1], /\[Harness Mix handoff\]/, '切回首轮同样注入信封');

    // 7) 守卫：执行中 / 同 Harness / 未知 Harness / 草稿 / 协作子任务
    a.state.hold = {};
    await rt.send(thread.id, '会挂起的任务');
    await wait(() => rt.execution.isRunning(thread.id));
    await assert.rejects(rt.switchHarness(thread.id, 'b'), /正在执行/);
    await assert.rejects(rt.send(thread.id, '/switch b'), /正在执行/);
    a.state.hold.hooks.emit({ kind: 'completed', finalAnswer: true });
    a.state.hold = null;
    await settle(thread.id);
    await assert.rejects(rt.switchHarness(thread.id, 'a'), /已经在该 Harness/);
    await assert.rejects(rt.switchHarness(thread.id, 'Nope'), /未知 Harness/);
    rt.status.b = { available: false, detail: '测试连接不可用' };
    await assert.rejects(rt.switchHarness(thread.id, 'b'), /测试连接不可用/);
    rt.status.b = { available: true };
    const draft = await rt.createThread({ harnessId: 'a', cwd: root, ephemeral: true });
    await assert.rejects(rt.switchHarness(draft.id, 'b'), /草稿任务/);
    const child = await rt.createThread({ harnessId: 'a', cwd: root, parentThreadId: thread.id });
    await assert.rejects(rt.switchHarness(child.id, 'b'), /协作子任务/);

    // 8) 待投递接力可显式取消：关闭目标 Session，恢复源 Harness，不污染既有链
    const chainBeforeCancel = thread.harnessChain.length;
    const cancelCandidate = await rt.switchHarness(thread.id, 'b', { intent: 'review' });
    assert.equal(thread.pendingHandoff.phase, 'ready');
    await rt.send(thread.id, '/switch cancel');
    assert.equal(thread.harnessId, 'a');
    assert.equal(thread.pendingHandoff, undefined);
    assert.equal(thread.harnessChain.length, chainBeforeCancel);
    assert.equal(rt.handoffs.owned(thread.id, cancelCandidate.checkpointId).status, 'cancelled');
    assert.equal(rt.sessions.get(thread.id)?.adapter, a.adapter);

    // 9) 目标连接失败时事务回滚：线程归属、原生源 Session 与 chain 都恢复
    const c = fakeHarness('c', 'Gamma');
    c.state.openError = 'Gamma auth expired';
    rt.adapters.set('c', c.adapter); rt.status.c = { available: true };
    await assert.rejects(rt.switchHarness(thread.id, 'c'), /已恢复原 Harness.*Gamma auth expired/);
    assert.equal(thread.harnessId, 'a');
    assert.equal(thread.pendingHandoff, undefined);
    assert.equal(thread.harnessChain.length, chainBeforeCancel);
    assert.equal(rt.sessions.get(thread.id)?.adapter, a.adapter);
    const rolledBack = [...rt.handoffs.checkpoints.values()].find(row => row.targetHarnessId === 'c');
    assert.equal(rolledBack.status, 'rolled-back');

    // 10) 首轮投递失败保留检查点；下一次发送复用同一目标 Session 和同一检查点重试
    a.state.withFileChange = false;
    const retryThread = await rt.createThread({ harnessId: 'a', cwd: root });
    await rt.send(retryThread.id, '准备接力重试');
    await settle(retryThread.id);
    const retrySwitch = await rt.switchHarness(retryThread.id, 'b', { intent: 'review' });
    b.state.sendError = 'temporary transport failure';
    await rt.send(retryThread.id, '先审查');
    await settle(retryThread.id);
    assert.equal(retryThread.pendingHandoff.phase, 'failed');
    assert.equal(rt.handoffs.owned(retryThread.id, retrySwitch.checkpointId).status, 'failed');
    b.state.sendError = null;
    await rt.send(retryThread.id, '重试审查');
    await settle(retryThread.id);
    assert.equal(retryThread.pendingHandoff, undefined);
    assert.equal(rt.handoffs.owned(retryThread.id, retrySwitch.checkpointId).status, 'active');
    assert.match(b.state.sent.at(-1), /Handoff mode: review.*Do not modify files/s);

    // 11) 并发切换按 Thread 串行化：第二个 RPC 不得在第一个连接期间再创建检查点
    const concurrentThread = await rt.createThread({ harnessId: 'a', cwd: root });
    await rt.send(concurrentThread.id, '准备并发切换');
    await settle(concurrentThread.id);
    const d = fakeHarness('d', 'Delta');
    let releaseDelta;
    d.state.openWait = new Promise(resolve => { releaseDelta = resolve; });
    rt.adapters.set('d', d.adapter); rt.status.d = { available: true };
    const firstSwitch = rt.switchHarness(concurrentThread.id, 'd');
    await wait(() => rt.switching.has(concurrentThread.id));
    await assert.rejects(rt.switchHarness(concurrentThread.id, 'b'), /正在切换 Harness/);
    releaseDelta();
    await firstSwitch;
    assert.equal(concurrentThread.harnessId, 'd');
    await rt.cancelHarnessSwitch(concurrentThread.id);
    assert.equal(concurrentThread.harnessId, 'a');

    // 12) 持久化：threads.json 里切换链完整（含原生会话引用，供重启后惰性恢复）
    await rt.store.save(rt.threads);
    const persisted = (await rt.store.load()).find(t => t.id === thread.id);
    assert.equal(persisted.harnessId, 'a');
    assert.deepEqual(persisted.harnessChain.map(e => e.harnessId), ['a', 'b']);
    assert.equal(persisted.harnessChain[0].nativeSessionId, aNativeId);
    // restore 是 initialize() 按 nativeSessionId+messages 重新推导的瞬态标记，不持久化；
    // 重启恢复的真正契约是持久化的 harnessId + nativeSessionId（指向 A 的原生会话）。
    assert.equal(persisted.nativeSessionId, aNativeId);
    assert.equal(persisted.restore, undefined);
    const persistedCheckpoints = JSON.parse(await fs.readFile(path.join(root, 'data', 'handoff', 'checkpoints.json'), 'utf8'));
    assert.equal(persistedCheckpoints.some(row => row.checkpointId === firstCheckpointId && row.status === 'active'), true);

    console.log('PASS: in-place harness switch → one-shot context envelope → switch-back native resume, guards and persistence');
  } finally { await rt.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
