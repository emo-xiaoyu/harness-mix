const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime, isDefaultTitle, deriveThreadTitle } = require('../src/main/host/runtime');
const { NativeProtocol, routeModel } = require('../src/main/native/protocol');
const { projectEvent } = require('../src/main/adapters/claude');

async function run() {
  console.log('--- Unit tests: isDefaultTitle & deriveThreadTitle ---');
  assert.equal(isDefaultTitle('新任务'), true);
  assert.equal(isDefaultTitle('新任务 (隔离分支)'), true);
  assert.equal(isDefaultTitle('新任务 (自定义)'), true);
  assert.equal(isDefaultTitle(''), true);
  assert.equal(isDefaultTitle(null), true);
  assert.equal(isDefaultTitle('设计架构图'), false);
  assert.equal(isDefaultTitle('修复 bug'), false);

  assert.equal(deriveThreadTitle('优化一下这个'), '优化一下这个');
  assert.equal(deriveThreadTitle('# 需求分析\n具体内容在此'), '需求分析');
  assert.equal(deriveThreadTitle('1. 修复登录 bug\n2. 添加测试'), '修复登录 bug');
  assert.equal(deriveThreadTitle('> 这是引用\n修改这里'), '这是引用');
  assert.equal(deriveThreadTitle('这是一个超过三十个字符非常非常长的一句话用来测试截断逻辑是否正确生效'), '这是一个超过三十个字符非常非常长的一句话用来测试截断逻辑是否…');
  assert.equal(
    deriveThreadTitle('[System Instruction: test]\n[用户上传了图片附件]\n- a.png: /path\n## My request:\n为什么每个任务全是新任务'),
    '为什么每个任务全是新任务'
  );
  assert.equal(deriveThreadTitle('', [{ name: 'screenshot.png' }]), '附件: screenshot.png');
  assert.equal(deriveThreadTitle('', [], { isWorktree: true }), '新任务 (隔离分支)');
  assert.equal(deriveThreadTitle('修复登录问题', [], { isWorktree: true }), '修复登录问题 (隔离分支)');

  // Claude Code 的 summary 消息（auto-compact 生成）投影为原生标题事件
  // （projectEvent 统一附带 nativeRef 包装，标题分支不消费它）
  const claudeTitle = projectEvent({ type: 'summary', summary: ' 修复登录流程的会话摘要 ', leafUuid: 'u1' });
  assert.equal(claudeTitle.length, 1);
  assert.equal(claudeTitle[0].kind, 'title');
  assert.equal(claudeTitle[0].title, '修复登录流程的会话摘要');
  assert.deepEqual(projectEvent({ type: 'summary', summary: '   ' }), [], '空白 Claude summary 忽略');

  console.log('--- Integration tests: HostRuntime & NativeProtocol ---');
  const root = path.resolve('output/thread-title-test', String(Date.now()));
  await fs.mkdir(root, { recursive: true });
  const dataDir = path.join(root, 'data');
  const runtime = new HostRuntime({ dataDirectory: dataDir });
  await runtime.initialize();

  const events = [];
  const bridge = new NativeProtocol(runtime, event => events.push(event));

  const adapter = {
    manifest: { id: 'antigravity', name: 'Antigravity', capabilities: { streaming: true } },
    async open(input) { return {}; },
    async describe() { return { models: [{ id: 'gemini-flash', name: 'Gemini' }] }; },
    async send(session, text, hooks) { lastHooks = hooks; hooks.emit({ kind: 'completed', finalAnswer: true }); },
    async cancel() {},
    async close() {},
  };
  let lastHooks = null;
  runtime.adapters.set('antigravity', adapter);
  runtime.status.antigravity = { available: true };

  // 1. 创建普通线程，初始标题为“新任务”
  const thread = await runtime.createThread({ harnessId: 'antigravity', cwd: root });
  assert.equal(thread.title, '新任务');

  // 2. 发送首条消息，标题自动派生为用户指令，并通知 Desktop (thread/name/updated)
  await runtime.send(thread.id, '实现用户登录界面和样式');
  assert.equal(thread.title, '实现用户登录界面和样式');
  const updateEvent = events.find(e => e.method === 'thread/name/updated' && e.params?.threadId === thread.id);
  assert.ok(updateEvent, 'Desktop 收到 thread/name/updated 通知');
  assert.equal(updateEvent.params.threadName, '实现用户登录界面和样式');

  // 3. 发送第二条消息，已生成的标题保持不变，不被覆盖
  await runtime.send(thread.id, '再加一个重置密码功能');
  assert.equal(thread.title, '实现用户登录界面和样式');

  // 4. 手动重命名测试
  await runtime.renameThread(thread.id, '自定义登录任务');
  assert.equal(thread.title, '自定义登录任务');
  const renameEvent = events.filter(e => e.method === 'thread/name/updated' && e.params?.threadId === thread.id).at(-1);
  assert.equal(renameEvent.params.threadName, '自定义登录任务');

  // 5. 显式指定标题创建的任务不受自动命名影响
  const customThread = await runtime.createThread({ harnessId: 'antigravity', cwd: root, title: '保留显式标题' });
  await runtime.send(customThread.id, '这是一条测试消息');
  assert.equal(customThread.title, '保留显式标题');

  // 5.5 原生 harness 标题事件（DSH session/title / Claude summary → kind:'title'）：
  // 未锁定时采纳为标题并通知 Desktop；用户/Desktop 已命名（titleLocked）则忽略
  const nativeTitled = await runtime.createThread({ harnessId: 'antigravity', cwd: root });
  await runtime.send(nativeTitled.id, '逐行输出数字');
  lastHooks.emit({ kind: 'title', title: '逐行输出数字1至100000' });
  assert.equal(nativeTitled.title, '逐行输出数字1至100000', '原生标题事件被采纳为线程标题');
  const nativeTitleEvent = events.filter(e => e.method === 'thread/name/updated' && e.params?.threadId === nativeTitled.id).at(-1);
  assert.equal(nativeTitleEvent.params.threadName, '逐行输出数字1至100000', '原生标题采纳后通知 Desktop');
  lastHooks.emit({ kind: 'title', title: '更晚的原生标题' });
  assert.equal(nativeTitled.title, '更晚的原生标题', '更晚到达的原生标题可以替换更早的');
  await runtime.renameThread(nativeTitled.id, '用户命名');
  lastHooks.emit({ kind: 'title', title: '原生试图覆盖' });
  assert.equal(nativeTitled.title, '用户命名', '用户/Desktop 显式命名后原生标题不再覆盖');
  lastHooks.emit({ kind: 'title', title: '' });
  assert.equal(nativeTitled.title, '用户命名', '空原生标题被忽略');

  // 6. 历史任务重启回填测试 (Backfill on initialize)
  const legacyThread = await runtime.createThread({ harnessId: 'antigravity', cwd: root, title: '新任务' });
  legacyThread.messages.push({ role: 'user', text: '历史遗留会话提问', at: Date.now() });
  await runtime.store.save(runtime.threads);
  bridge.close();
  await runtime.close();

  const newRuntime = new HostRuntime({ dataDirectory: dataDir });
  try {
    await newRuntime.initialize();
    const loadedLegacy = newRuntime.threads.find(t => t.id === legacyThread.id);
    assert.equal(loadedLegacy.title, '历史遗留会话提问', '重启初始化时自动为历史“新任务”回填首轮语义标题');
    console.log('PASS: thread title auto-derivation, notification and persistence');
  } finally {
    await newRuntime.close();
  }
}

run().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
