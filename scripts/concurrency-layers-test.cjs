const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { git } = require('../src/main/host/collaboration-worktree');

const until = async (predicate, timeoutMs = 4000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise(r => setTimeout(r, 20));
  }
};

(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-layers-test-'));
  const rt = new HostRuntime({ dataDirectory: path.join(tmpDir, 'data') });
  await rt.store.load();

  // -------------------------------------------------------------
  // Test 1: 第二层 —— 原生 Codex 协议直通 (Native Patch Passthrough)
  // -------------------------------------------------------------
  console.log('--- Testing Layer 2: Native Codex Protocol Passthrough ---');
  const sharedDir = path.join(tmpDir, 'shared-repo');
  await fs.mkdir(sharedDir);

  const codexEmits = new Map();
  const workerEmits = new Map();

  const codexAdapter = {
    manifest: {
      id: 'mock-codex',
      name: 'Mock Codex',
      capabilities: { nativeDiff: true, nativePatch: true },
    },
    async open({ thread, emit }) {
      codexEmits.set(thread.id, emit);
      return {};
    },
    async send() {},
    async close() {},
  };

  const workerAdapter = {
    manifest: {
      id: 'mock-worker',
      name: 'Mock Worker',
      capabilities: {},
    },
    async open({ thread, emit }) {
      workerEmits.set(thread.id, emit);
      return {};
    },
    async send() {},
    async close() {},
  };

  rt.adapters.set('mock-codex', codexAdapter);
  rt.status['mock-codex'] = { available: true };
  rt.adapters.set('mock-worker', workerAdapter);
  rt.status['mock-worker'] = { available: true };

  const codexThread = await rt.createThread({ harnessId: 'mock-codex', cwd: sharedDir });
  const workerThread = await rt.createThread({ harnessId: 'mock-worker', cwd: sharedDir });

  // 1.1 并发执行：Worker 修改 worker.txt，Codex 修改 codex.txt
  await rt.send(codexThread.id, 'codex edit turn');
  await rt.send(workerThread.id, 'worker edit turn');

  const codexMsg1 = codexThread.messages.at(-1);
  const workerMsg1 = workerThread.messages.at(-1);

  // Worker 在磁盘写入 worker.txt
  await fs.writeFile(path.join(sharedDir, 'worker.txt'), 'from worker\n');
  const workerEmit1 = workerEmits.get(workerThread.id);
  workerEmit1({ kind: 'text-delta', text: 'worker done' });
  workerEmit1({ kind: 'completed', finalAnswer: true });
  await until(() => workerThread.status === 'ready' && !workerThread.reviewPending);

  // Codex 原生通过 fileChange 汇报修改 codex.txt
  await fs.writeFile(path.join(sharedDir, 'codex.txt'), 'from codex\n');
  const codexEmit1 = codexEmits.get(codexThread.id);
  codexEmit1({
    kind: 'file-change',
    source: 'native',
    changes: [{
      path: path.join(sharedDir, 'codex.txt'),
      patch: '@@ -0,0 +1,1 @@\n+from codex',
      complete: true,
    }],
  });
  codexEmit1({ kind: 'text-delta', text: 'codex done' });
  codexEmit1({ kind: 'completed', finalAnswer: true });
  await until(() => codexThread.status === 'ready' && !codexThread.reviewPending);

  // 核心断言：由于原生协议直通生效，Codex 的审查记录中 ONLY 包含 codex.txt，绝不混入并发的 worker.txt！
  const codexReview1 = await rt.readReview(codexThread, codexMsg1);
  assert.equal(codexReview1.files.length, 1, 'Codex review should only contain its own file');
  assert.equal(codexReview1.files[0].path, 'codex.txt');
  assert.equal(codexReview1.files.some(f => f.path === 'worker.txt'), false, 'Worker file must NOT leak into Codex review');

  // 1.2 并发执行：Worker 修改其他文件，Codex 仅纯问答（0 原生变更）
  await rt.send(codexThread.id, 'codex question turn');
  await rt.send(workerThread.id, 'worker second turn');

  const codexMsg2 = codexThread.messages.at(-1);
  await fs.writeFile(path.join(sharedDir, 'worker2.txt'), 'another worker edit\n');
  const workerEmit2 = workerEmits.get(workerThread.id);
  workerEmit2({ kind: 'completed', finalAnswer: true });
  await until(() => workerThread.status === 'ready' && !workerThread.reviewPending);

  const codexEmit2 = codexEmits.get(codexThread.id);
  codexEmit2({ kind: 'text-delta', text: 'just an answer, no files modified' });
  codexEmit2({ kind: 'completed', finalAnswer: true });
  await until(() => codexThread.status === 'ready' && !codexThread.reviewPending);

  const codexReview2 = await rt.readReview(codexThread, codexMsg2);
  assert.equal(codexReview2.files.length, 0, 'Pure question in Codex must have exactly 0 files despite concurrent edits');

  console.log('Layer 2 (Native Codex Protocol Passthrough) passed successfully!');

  // -------------------------------------------------------------
  // Test 2: 第三层 —— 基于 Git Worktree 的物理隔离 (Worktree Isolation)
  // -------------------------------------------------------------
  console.log('--- Testing Layer 3: Git Worktree Physical Isolation ---');
  const gitRepo = path.join(tmpDir, 'git-project');
  await fs.mkdir(gitRepo);
  await git(gitRepo, ['init']);
  await git(gitRepo, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(gitRepo, 'main-code.txt'), 'initial main code\n');
  await git(gitRepo, ['add', '.']);
  await git(gitRepo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial commit']);

  // 新建启用 Worktree 隔离的任务
  const wtThread = await rt.createThread({
    harnessId: 'mock-worker',
    cwd: gitRepo,
    worktree: true,
  });

  assert.equal(wtThread.isolation, 'worktree', 'Thread should have worktree isolation');
  assert.ok(wtThread.workspace, 'Thread should hold a workspace object');
  assert.equal(wtThread.workspace.mode, 'worktree');
  assert.notEqual(wtThread.cwd, gitRepo, 'Worktree cwd must be physically different from gitRepo');
  assert.equal(wtThread.originalCwd, gitRepo);
  const [physicalSource, physicalWorktree] = await Promise.all([fs.realpath(gitRepo), fs.realpath(wtThread.cwd)]);
  assert.notEqual(physicalWorktree, physicalSource, 'Worktree cwd must resolve to a different physical directory');

  // 在主仓库和隔离分支同时并发写入同名或不同文件
  await fs.writeFile(path.join(gitRepo, 'main-code.txt'), 'main modified\n');
  await fs.writeFile(path.join(wtThread.cwd, 'worktree-feature.txt'), 'new feature in branch\n');

  // 物理隔离验证：主仓库绝对看不到工作树创建的文件
  await assert.rejects(fs.access(path.join(gitRepo, 'worktree-feature.txt')), 'Main repo must not see isolated worktree files');

  // 审查隔离工作区改动
  const wtReview = await rt.reviewThreadWorkspace(wtThread.id);
  assert.match(wtReview.patch, /worktree-feature\.txt/);

  // 将隔离分支改动合入主项目
  await rt.applyThreadWorkspace(wtThread.id, wtReview.digest);
  assert.equal(
    await fs.readFile(path.join(gitRepo, 'worktree-feature.txt'), 'utf8'),
    'new feature in branch\n',
    'Main repo should now have the applied file after applyThreadWorkspace'
  );

  // 删除线程时自动清理 Worktree 分支与临时目录
  const wtRoot = wtThread.workspace.root;
  await rt.removeThread(wtThread.id);
  await assert.rejects(fs.access(wtRoot), 'Worktree directory should be cleaned up on removeThread');

  console.log('Layer 3 (Git Worktree Physical Isolation) passed successfully!');

  await rt.close();
  console.log('ALL CONCURRENCY LAYERS TESTS PASSED!');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
