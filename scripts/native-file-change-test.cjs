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
  rt.adapters.set('test', { manifest: { id: 'test', name: 'Test', capabilities: {} },
    async open(input) { emit = input.emit; return {}; }, async send() {}, async close() {} });
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
    assert.throws(() => canonicalChanges(root, [{ path: '../escape.txt' }]), /outside/);
    await rt.undoFile(thread.id, message.id, 'a.txt');
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'original\n');
    console.log('native-file-change: native adapters -> Core -> review, repeated edits, snapshot fallback, undo, late events passed');
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
