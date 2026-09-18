const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { projectEvent } = require('../src/main/adapters/claude');
const { canonicalChanges } = require('../src/main/workspace/file-changes');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-native-files-'));
  const root = path.join(directory, 'workspace'); await fs.mkdir(root);
  const rt = new HostRuntime({ dataDirectory: directory });
  await rt.store.load();
  let emit;
  const emitters = new Map();
  rt.adapters.set('test', { manifest: { id: 'test', name: 'Test', capabilities: {} },
    async open(input) { emit = input.emit; emitters.set(input.thread.id, input.emit); return {}; }, async send() {}, async close() {} });
  rt.status.test = { available: true };
  const apply = events => { for (const event of [events].flat().filter(Boolean)) emit(event); };
  try {
    const thread = await rt.createThread({ harnessId: 'test', cwd: root });
    await fs.writeFile(path.join(root, 'a.txt'), 'original\n');
    await rt.send(thread.id, 'edit');
    const message = thread.messages.at(-1);
    // DSH Web Remote 的 tool/result meta.diffs 为 hunk 级（非完整文件），原生 diff 路径
    // 由 Claude（tool_use_result 全量 before/after）与直接 emit 腿覆盖。
    const edit = async (before, after, id) => {
      await fs.writeFile(path.join(root, 'a.txt'), after);
      apply(projectEvent({ type: 'user', session_id: 'native-session',
        tool_use_result: { filePath: path.join(root, 'a.txt'), type: 'update', content: after, originalFile: before },
        message: { content: [{ type: 'tool_result', tool_use_id: id }] } }));
    };
    await edit('original\n', 'middle\n', 'edit-1');
    const preview = rt.reviews.preview.bind(rt.reviews);
    const stale = await preview(message.reviewId);
    let release;
    rt.reviews.preview = async id => {
      rt.reviews.preview = preview;
      await new Promise(resolve => { release = resolve; });
      return stale;
    };
    const reading = rt.readReview(thread, message);
    assert.equal(typeof release, 'function');
    await edit('middle\n', 'final\n', 'edit-2');
    release();
    let files = (await reading).files;
    assert.equal(files.length, 1);
    assert.equal(files[0].source, 'native');
    assert.equal(files[0].before, 'original\n');
    assert.equal(files[0].after, 'final\n');
    assert.equal(files[0].nativeRef.toolCallId, 'edit-2');
    assert.equal(files[0].patch.rows.find(row => row.kind === 'remove').text, 'original');
    await fs.writeFile(path.join(root, 'b.txt'), 'created\n');
    apply(projectEvent({ type: 'user', session_id: 'native-session',
      tool_use_result: { filePath: path.join(root, 'b.txt'), type: 'create', content: 'created\n' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'create-1' }] } }));
    files = (await rt.readReview(thread, message)).files;
    assert.equal(files.find(file => file.path === 'b.txt').source, 'native');
    // A later shell edit has no native patch: the complete snapshot must win.
    await fs.writeFile(path.join(root, 'a.txt'), 'shell edit\n');
    files = (await rt.readReview(thread, message)).files;
    assert.equal(files.find(file => file.path === 'a.txt').source, 'snapshot');
    assert.equal(files.find(file => file.path === 'a.txt').after, 'shell edit\n');
    assert.equal(files.find(file => file.path === 'a.txt').nativeRef.toolCallId, 'edit-2');
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'c.txt'), 'nested\n');
    emit({ kind: 'file-change', source: 'native', changes: [{ path: path.join(root, 'nested', 'c.txt'), before: '', after: 'nested\n', complete: true }] });
    files = (await rt.readReview(thread, message)).files;
    assert.equal(files.filter(file => file.path === 'nested/c.txt').length, 1);
    assert.equal(files.find(file => file.path === 'nested/c.txt').source, 'native');
    // Antigravity 式：原生事件只携带路径、不携带内容（complete: false，与 codex.js 同一约定），
    // 必须由工作区快照接管，否则回合结算后仍无增删统计（UI 显示 +0 -0）。
    await fs.writeFile(path.join(root, 'd.txt'), 'disk\n');
    emit({ kind: 'file-change', source: 'native', changes: [{ path: path.join(root, 'd.txt'), changeType: 'added', complete: false }] });
    files = (await rt.readReview(thread, message)).files;
    const incomplete = files.find(file => file.path === 'd.txt');
    assert.equal(incomplete.source, 'snapshot', 'contentless native hint must not block the workspace snapshot');
    assert.equal(incomplete.after, 'disk\n');
    // 工作区外改动（如 Claude 写入计划文件/全局配置/其他盘符）：保留展示并标记，
    // 绝不能使回合失败或原生会话崩溃（历史 bug：canonicalChanges 抛错沿 emit 同步
    // 回到 Adapter 事件泵 → 会话误判 crashed → 后续 send 全部“原生会话不可用”）。
    const outsidePath = path.join(directory, 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\n');
    emit({ kind: 'file-change', source: 'native', changes: [{ path: outsidePath, before: '', after: 'outside\n', complete: true }] });
    emit({ kind: 'file-change', source: 'native', changes: [{ before: 'x', after: 'y' }] }); // 无路径：静默丢弃
    assert.equal(thread.error, undefined);
    files = (await rt.readReview(thread, message)).files;
    const outside = files.find(file => file.outsideWorkspace);
    assert.equal(outside.path, outsidePath.replace(/\\/g, '/'));
    assert.equal(outside.after, 'outside\n');
    emit({ kind: 'completed', finalAnswer: true });
    for (let i = 0; i < 200 && thread.reviewPending; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(thread.reviewPending, false);
    await rt.undoFile(thread.id, message.id, 'nested/c.txt');
    await assert.rejects(fs.access(path.join(root, 'nested', 'c.txt')));
    await rt.undoFile(thread.id, message.id, 'b.txt');
    assert.equal(message.coreReview.files.find(file => file.path === 'b.txt').undone, true);
    await assert.rejects(fs.access(path.join(root, 'b.txt')));
    const beforeLate = structuredClone(message.coreItems);
    emit({ kind: 'file-change', changes: [{ path: 'late.txt', before: '', after: 'late' }] });
    assert.deepEqual(message.coreItems, beforeLate, 'late native diff cannot mutate a settled turn');
    const escaped = canonicalChanges(root, [{ path: '../escape.txt', before: '', after: 'x' }]);
    assert.equal(escaped.length, 1);
    assert.equal(escaped[0].outsideWorkspace, true, 'outside-workspace change is kept and flagged, not thrown');
    assert.equal(escaped[0].path, path.resolve(root, '../escape.txt').replace(/\\/g, '/'));
    assert.equal(canonicalChanges(root, [{ before: 'a' }]).length, 0, 'pathless change is dropped');
    await rt.undoFile(thread.id, message.id, 'a.txt');
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'original\n');
    // 会话未被上述异常事件破坏：同一会话可继续新回合并正常结算。
    await rt.send(thread.id, 'after outside change');
    emit({ kind: 'completed', finalAnswer: true });
    for (let i = 0; i < 200 && thread.reviewPending; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.notEqual(thread.status, 'error');
    assert.equal(thread.error, undefined);
    // 并发同目录、无原生 patch 的 Harness：各回合审查按工具触碰路径归属，
    // 另一个会话的改动不混入本回合卡片（原生 Codex 的每会话独立 diff 行为）。
    const w1 = await rt.createThread({ harnessId: 'test', cwd: root });
    const w2 = await rt.createThread({ harnessId: 'test', cwd: root });
    await rt.send(w1.id, 'task one');
    await rt.send(w2.id, 'task two');
    const m1 = w1.messages.at(-1), m2 = w2.messages.at(-1);
    assert.equal(m1.concurrent, true); assert.equal(m2.concurrent, true);
    emitters.get(w1.id)({ kind: 'tool', toolCallId: 'w1-edit', title: 'edit', state: 'done', path: path.join(root, 'w1.txt') });
    emitters.get(w2.id)({ kind: 'tool', toolCallId: 'w2-edit', title: 'edit', state: 'done', path: path.join(root, 'w2.txt') });
    await fs.writeFile(path.join(root, 'w1.txt'), 'one\n');
    await fs.writeFile(path.join(root, 'w2.txt'), 'two\n');
    emitters.get(w1.id)({ kind: 'completed', finalAnswer: true });
    emitters.get(w2.id)({ kind: 'completed', finalAnswer: true });
    for (let i = 0; i < 200 && (w1.reviewPending || w2.reviewPending); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(m1.review.files.map(file => file.path), ['w1.txt'], 'w1 只归属本轮触碰的文件');
    assert.deepEqual(m2.review.files.map(file => file.path), ['w2.txt'], 'w2 只归属本轮触碰的文件');
    console.log('native-file-change: native adapters -> Core -> review, repeated edits, snapshot fallback, undo, late events passed');
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
