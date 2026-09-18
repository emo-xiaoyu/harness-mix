const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { projectReview } = require('../src/main/workspace/core-review');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(10); }
  throw new Error('timed out');
}

// 审查归属（core-review foreignPaths）：foreign 集合扫描同目录其他会话的历史全部轮次，
// 旧会话碰过的路径会永久滞留其中。本轮工具已明确触碰的文件属本会话自身的正向事实，
// 不得被 foreign 误剔——否则本轮编辑从审查卡片与撤回列表中消失。
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-core-review-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);

  const rt = new HostRuntime({ dataDirectory: directory });
  await rt.store.load();

  const emitters = new Map();
  rt.adapters.set('test', {
    manifest: { id: 'test', name: 'Test', capabilities: {} },
    async open(input) { emitters.set(input.thread.id, input.emit); return {}; },
    async send() {}, async cancel() {}, async close() {},
  });
  rt.status.test = { available: true };

  try {
    // 线程 B（同目录旧会话）：历史上编辑过 src/index.js 与 other.js
    const threadB = await rt.createThread({ harnessId: 'test', cwd: root });
    await rt.send(threadB.id, 'B 的历史编辑');
    emitters.get(threadB.id)({ kind: 'tool', toolCallId: 'b1', title: 'Edit', state: 'completed', path: 'src/index.js', input: '{}' });
    emitters.get(threadB.id)({ kind: 'tool', toolCallId: 'b2', title: 'Edit', state: 'completed', path: 'other.js', input: '{}' });
    emitters.get(threadB.id)({ kind: 'completed', finalAnswer: true });
    await until(() => !rt.execution.isRunning(threadB.id));

    // 线程 A：本轮自己用工具编辑了 src/index.js（正向触碰证据），未碰 other.js
    const threadA = await rt.createThread({ harnessId: 'test', cwd: root });
    await rt.send(threadA.id, 'A 的本轮编辑');
    const messageA = threadA.messages.at(-1);
    assert.ok(messageA.coreTurnId, '本轮消息携带 Core Turn');
    emitters.get(threadA.id)({ kind: 'tool', toolCallId: 'a1', title: 'Edit', state: 'completed', path: 'src/index.js', input: '{}' });
    emitters.get(threadA.id)({ kind: 'completed', finalAnswer: true });
    await until(() => !rt.execution.isRunning(threadA.id));

    // 目录级快照同时捕到两个文件的变化（含 B 的历史编辑残留）
    const record = { id: 'synthetic', at: Date.now(), endedAt: Date.now(), skipped: 0, concurrent: false, changes: [
      { path: 'src/index.js', before: { text: 'old index\n' }, after: { text: 'new index\n' }, added: 1, removed: 1 },
      { path: 'other.js', before: { text: 'old other\n' }, after: { text: 'new other\n' }, added: 1, removed: 1 },
    ] };
    const summary = await projectReview(rt, threadA, messageA, record);
    const paths = summary.files.map(f => f.path);
    assert.ok(paths.includes('src/index.js'), '本轮触碰的文件不被 foreign 历史归属误剔');
    assert.ok(!paths.includes('other.js'), '本轮未触碰的 foreign 文件仍被剔除');

    console.log('core-review-test: this-turn touched paths win over historical foreign attribution; untouched foreign paths stay excluded');
  } finally {
    await rt.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
