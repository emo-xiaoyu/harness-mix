const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');

/**
 * 跨 Harness 原地切换（switchHarness）脚本级测试：
 * 双假 Adapter 注入 → A 会话产出历史 → /switch 到 B → 信封注入校验 →
 * 切回 A 的原生恢复校验 → 守卫边界 → 持久化校验。
 * 运行：npm run test:switch-harness
 */
const wait = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

function fakeHarness(id, name) {
  const state = { sent: [], opens: [], closed: 0, hold: null, withFileChange: false };
  const adapter = {
    manifest: { id, name, aliases: [id], capabilities: {} },
    async open(input) {
      state.opens.push({ restore: input.thread.restore === true, nativeSessionId: input.thread.nativeSessionId, nativeSessionFile: input.thread.nativeSessionFile });
      return { nativeSessionId: input.thread.nativeSessionId };
    },
    async send(session, text, hooks) {
      state.sent.push(text);
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
    assert.equal(thread.restore, false, '新 Harness 上是全新原生会话');
    assert.equal(rt.sessions.has(thread.id), false, '切换后旧原生会话已关闭');
    assert.equal(a.state.closed, 1);
    assert.equal(b.state.opens.length, 0, '目标 Harness 惰性拉起，切换瞬间不开进程');
    assert.equal(thread.messages.filter(m => m.role === 'user').length, 1, '/switch 指令本身不落在会话里');

    // 4) 切换后首轮：信封注入 prompt，可见消息保持干净，注入后清除标记
    await rt.send(thread.id, '继续');
    await settle(thread.id);
    assert.equal(b.state.opens.length, 1);
    assert.equal(b.state.opens[0].restore, false);
    assert.notEqual(thread.nativeSessionId, aNativeId);
    assert.match(b.state.sent[0], /\[Harness Mix handoff\]/);
    assert.match(b.state.sent[0], /untrusted historical data/);
    assert.match(b.state.sent[0], /帮我重构登录模块/);
    assert.match(b.state.sent[0], /Alpha 回复/);
    assert.match(b.state.sent[0], /added src\/login\.ts/);
    assert.match(b.state.sent[0], /优先把测试补完/);
    const visible = thread.messages.filter(m => m.role === 'user').at(-1);
    assert.equal(visible.text, '继续', '信封不进用户可见消息');
    assert.equal(thread.pendingHandoff, undefined, '信封发送成功后标记已清除');

    // 5) 第二轮起不再注入
    await rt.send(thread.id, '第二步');
    await settle(thread.id);
    assert.ok(!b.state.sent[1].includes('[Harness Mix handoff]'), '信封只注入一次');

    // 6) 切回 A：原生会话引用恢复（惰性 open 走 restore 路径），chain 压栈两条
    await rt.send(thread.id, '/switch a');
    assert.equal(thread.harnessId, 'a');
    assert.equal(thread.harnessChain.length, 2);
    assert.equal(thread.harnessChain[1].harnessId, 'b');
    assert.equal(thread.nativeSessionId, aNativeId, '切回恢复原原生会话标识');
    assert.equal(thread.restore, true);
    await rt.send(thread.id, '我回来了');
    await settle(thread.id);
    assert.equal(a.state.opens.length, 2);
    assert.equal(a.state.opens[1].restore, true, '切回走原生恢复路径');
    assert.equal(a.state.opens[1].nativeSessionId, aNativeId);
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
    const draft = await rt.createThread({ harnessId: 'a', cwd: root, ephemeral: true });
    await assert.rejects(rt.switchHarness(draft.id, 'b'), /草稿任务/);
    const child = await rt.createThread({ harnessId: 'a', cwd: root, parentThreadId: thread.id });
    await assert.rejects(rt.switchHarness(child.id, 'b'), /协作子任务/);

    // 8) 持久化：threads.json 里切换链完整（含原生会话引用，供重启后惰性恢复）
    await rt.store.save(rt.threads);
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'data', 'threads.json'), 'utf8')).find(t => t.id === thread.id);
    assert.equal(persisted.harnessId, 'a');
    assert.deepEqual(persisted.harnessChain.map(e => e.harnessId), ['a', 'b']);
    assert.equal(persisted.harnessChain[0].nativeSessionId, aNativeId);
    // restore 是 initialize() 按 nativeSessionId+messages 重新推导的瞬态标记，不持久化；
    // 重启恢复的真正契约是持久化的 harnessId + nativeSessionId（指向 A 的原生会话）。
    assert.equal(persisted.nativeSessionId, aNativeId);
    assert.equal(persisted.restore, undefined);

    console.log('PASS: in-place harness switch → one-shot context envelope → switch-back native resume, guards and persistence');
  } finally { await rt.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
