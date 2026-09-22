const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { promises: fs } = require('node:fs');
const { Store } = require('../src/main/host/store');
const { compactThread, hydrateThread, storageProjection } = require('../src/main/host/thread-storage');
const { VerificationGates, normalizePolicy } = require('../src/main/host/verification-gates');
const { ThreadStore } = require('../src/main/host/thread-store');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-storage-'));
  try {
    const turn = { id: 'turn-1', threadId: 'thread-1', status: 'completed', itemIds: ['answer-1'], createdAt: 1, updatedAt: 2, startedAt: 1, completedAt: 2, lastSequence: 2, nativeTurnRef: {} };
    const item = { id: 'answer-1', threadId: 'thread-1', turnId: 'turn-1', type: 'agent_message', status: 'completed', content: 'large answer '.repeat(1000), createdAt: 1, updatedAt: 2, nativeRef: {} };
    const coreThread = { id: 'thread-1', workspaceId: root, harnessId: 'fixture', status: 'idle', activeTurnId: null, nativeSessionRef: {}, metadata: {}, usage: {}, createdAt: 1, updatedAt: 2 };
    const thread = { id: 'thread-1', title: 'fixture', cwd: root, harnessId: 'fixture', nativeSessionId: 'native-1', status: 'ready', connectionStatus: 'ready', createdAt: 1,
      messages: [{ id: 'user-1', role: 'user', text: 'hello', at: 1 }, { id: 'turn-1', role: 'assistant', coreTurnId: 'turn-1', coreTurn: turn, coreItems: [item], text: item.content, thinking: '', at: 1, endedAt: 2, stopReason: 'completed' }],
      tools: [], pendingApprovals: [], coreThread, currentTurn: turn, coreState: { version: 1, thread: coreThread, turns: [turn], items: [item] } };
    await fs.writeFile(path.join(root, 'threads.json'), JSON.stringify([thread]));
    const store = new Store(root, 'threads.json', { schemaVersion: 2, serialize: compactThread, deserialize: hydrateThread, backup: true });
    const loaded = await store.load();
    assert.equal(loaded[0].messages[1].text, item.content, 'legacy array remains readable');
    await store.save(loaded);
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'threads.json'), 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.threads[0].messages[1].text, undefined, 'derived assistant text is not duplicated');
    assert.equal(persisted.threads[0].coreState.items[0].content, item.content, 'authoritative Core content is preserved');
    assert.ok((await fs.stat(path.join(root, 'threads.json.bak'))).size > 0, 'legacy store is backed up during migration');
    const projection = storageProjection(loaded);
    assert.ok(projection.savedBytes > 0);
    const shardedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-sharded-'));
    await fs.writeFile(path.join(shardedRoot, 'threads.json'), JSON.stringify({ schemaVersion: 2, threads: [compactThread(thread)] }));
    const sharded = new ThreadStore(shardedRoot);
    const migration = await sharded.loadIndex();
    assert.equal(migration[0]._storageStub, undefined, 'legacy records load fully for one-time migration');
    migration[0].status = 'working';
    migration[0].connectionStatus = 'busy';
    await sharded.save(migration);
    const stubs = await sharded.loadIndex();
    assert.equal(stubs[0]._storageStub, true);
    assert.equal(stubs[0].status, 'interrupted', 'cold startup never presents a stale running task');
    assert.equal(stubs[0].connectionStatus, 'ready');
    assert.equal(stubs[0].messages.length, 0, 'cold index does not load transcript bodies');
    sharded.hydrateInto(stubs[0]);
    assert.equal(stubs[0].coreState.items[0].content, item.content);
    assert.equal((await sharded.inspectFiles()).recordCount, 1);
    assert.ok((await fs.stat(path.join(shardedRoot, 'threads.json.bak'))).size > 0, 'monolithic source remains recoverable');
    await fs.rm(shardedRoot, { recursive: true, force: true });
    const unsupportedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-storage-schema-'));
    await fs.writeFile(path.join(unsupportedRoot, 'threads.json'), JSON.stringify({ schemaVersion: 99, threads: [] }));
    await assert.rejects(new Store(unsupportedRoot, 'threads.json', { schemaVersion: 2 }).load(), /Unsupported thread store schema/);
    await fs.rm(unsupportedRoot, { recursive: true, force: true });

    const fakeRuntime = {
      core: { getTurn: () => turn, getItemsForTurn: () => [item], dispatch: () => {} },
      execution: { lastTurn: () => turn, sync: () => {} },
    };
    const gates = new VerificationGates(fakeRuntime);
    gates.configure(thread, { mode: 'required', checks: { cleanWorkingTree: false }, commands: [{ id: 'node', command: `"${process.execPath}" -e "process.exit(0)"`, timeoutMs: 10_000 }] });
    assert.throws(() => gates.assertSatisfied(thread, '交付'), /未通过/);
    const passed = await gates.run(thread);
    assert.equal(passed.status, 'passed');
    assert.match(passed.contentDigest, /^[a-f0-9]{64}$/);
    assert.equal(gates.inspect(thread).satisfied, true);
    const stale = gates.invalidate(thread, 'test state changed');
    assert.equal(stale.status, 'stale');
    assert.equal(gates.inspect(thread).satisfied, false, 'required reports become stale after task state changes');
    gates.configure(thread, { mode: 'advisory', commands: [`"${process.execPath}" -e "process.exit(3)"`] });
    const failed = await gates.run(thread);
    assert.equal(failed.status, 'failed');
    assert.equal(gates.inspect(thread).satisfied, true, 'advisory failures do not block delivery');
    // advisory()：off 策略的 apply 零配置安全网——跑内建检查，不跑用户命令、
    // 不写 latestReport、不改线程策略；显式策略下不附加
    gates.configure(thread, { mode: 'off', commands: [`"${process.execPath}" -e "process.exit(3)"`] });
    const advisory = await gates.advisory(thread);
    assert.equal(advisory.mode, 'advisory');
    assert.deepEqual(advisory.commands, [], 'advisory 不跑用户命令');
    assert.ok(advisory.checks.some(check => check.id === 'turnCompleted'), '内建检查在列');
    assert.equal(gates.inspect(thread).policy.mode, 'off', '线程策略保持 off');
    assert.equal(gates.inspect(thread).report, null, 'advisory 不写 latestReport');
    gates.configure(thread, { mode: 'advisory' });
    assert.equal(await gates.advisory(thread), null, '显式策略下不附加安全网');
    assert.throws(() => normalizePolicy({ commands: [{ command: '' }] }), /Invalid verification command/);
    assert.throws(() => normalizePolicy({ commands: [{ command: 'tool --token sk-1234567890abcdef' }] }), /credential-like data/);
    console.log('PASS: schema v2 compact migration, backup, storage metrics and configurable verification gates');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
