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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-core-concurrency-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);

  const rt = new HostRuntime({ dataDirectory: directory });
  await rt.store.load();

  const emits = new Map();
  const adapter = {
    manifest: { id: 'test-harness', name: 'Test', capabilities: {} },
    async open(input) {
      emits.set(input.thread.id, input.emit);
      return {};
    },
    async send(session) {},
    async cancel(session) {},
    async close() {},
  };
  rt.adapters.set(adapter.manifest.id, adapter);
  rt.status[adapter.manifest.id] = { available: true };

  const thread1 = await rt.createThread({ harnessId: adapter.manifest.id, cwd: root });
  const thread2 = await rt.createThread({ harnessId: adapter.manifest.id, cwd: root });

  try {
    // 1. thread1 先完成一轮基础操作（生成 base.txt 与可撤回快照）
    await rt.send(thread1.id, 'task 1 initial turn');
    await fs.writeFile(path.join(root, 'base.txt'), 'initial content\n');
    const emit1_initial = emits.get(thread1.id);
    emit1_initial({ kind: 'text-delta', text: 'initial turn finished' });
    emit1_initial({ kind: 'completed', finalAnswer: true });
    await until(() => thread1.status === 'ready' && !thread1.reviewPending);
    const msg0 = thread1.messages.at(-1);
    assert.ok(msg0.review, 'msg0 should have review');

    // 2. 启动 thread1 的下一轮 turn
    await rt.send(thread1.id, 'task 1 running turn 2');
    assert.equal(rt.execution.isRunning(thread1.id), true, 'thread1 should be running');

    // 3. 在同一项目 (root) 下并发发送 thread2 的 turn（旧版本此处会硬性报错中断）
    await rt.send(thread2.id, 'task 2 concurrent question');
    assert.equal(rt.execution.isRunning(thread2.id), true, 'thread2 should also run concurrently');

    // 验证并发标记已被打上
    const msg1 = thread1.messages.at(-1);
    const msg2 = thread2.messages.at(-1);
    assert.equal(msg1.concurrent, true, 'thread1 turn should be marked concurrent');
    assert.equal(msg2.concurrent, true, 'thread2 turn should be marked concurrent');

    // 4. 并发期间撤回历史快照应当被安全拦截
    await assert.rejects(
      rt.undoFile(thread1.id, msg0.id, 'base.txt'),
      /项目任务执行或结算中，暂不能撤回/
    );

    // 5. thread2 为纯问答任务，先完成
    const emit2 = emits.get(thread2.id);
    emit2({ kind: 'text-delta', text: 'answer for task 2' });
    emit2({ kind: 'completed', finalAnswer: true });
    await until(() => thread2.status === 'ready' && !thread2.reviewPending);

    // thread2 无文件改动，结算正常
    const review2 = await rt.readReview(thread2, msg2);
    assert.equal(review2.files.length, 0, 'pure question should have 0 file changes');
    assert.equal(review2.concurrent, true, 'review2 should record concurrent execution');

    // 6. thread1 写文件后完成
    await fs.writeFile(path.join(root, 'task1-output.txt'), 'hello from task 1\n');
    const emit1 = emits.get(thread1.id);
    emit1({ kind: 'text-delta', text: 'finished task 1' });
    emit1({ kind: 'completed', finalAnswer: true });
    await until(() => thread1.status === 'ready' && !thread1.reviewPending);

    const review1 = await rt.readReview(thread1, msg1);
    assert.equal(review1.files.length, 1, 'thread1 should track its file change');
    assert.equal(review1.concurrent, true, 'review1 should record concurrent execution');
    assert.ok(review1.note.includes('并发任务'), 'review note should explain concurrency');

    // 7. 全部空闲后，安全撤回可以正常执行
    await rt.undoFile(thread1.id, msg0.id, 'base.txt');
    await assert.rejects(fs.access(path.join(root, 'base.txt')));

    console.log('core-concurrency-test: same-cwd concurrency, review degradation, and undo guard passed');
  } finally {
    await rt.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
