const { ParityObserver } = require('./support/parity-observer.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-core-fork-'));
  const root = path.join(directory, 'project'); await fs.mkdir(root);
  const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: directory });
  async function send(thread, text) {
    await rt.send(thread.id, text);
    for (let i = 0; i < 600 && (thread.status === 'working' || thread.reviewPending); i++) await sleep(200);
    assert.equal(thread.status, 'ready', thread.error);
    assert.equal(thread.messages.at(-1).coreTurn.status, 'completed');
  }
  try {
    await rt.initialize();
    const source = await rt.createThread({ harnessId: 'pi', cwd: root });
    const models = await rt.listModels(source.id);
    assert.ok(models.length);
    await send(source, 'Remember FORK-5921. Reply OK. Do not use tools.');
    const boundary = source.messages.at(-1);
    assert.ok(boundary.coreTurn.nativeTurnRef.checkpointId, 'native checkpoint captured');
    await send(source, 'Remember LATER-9386 too. Reply OK. Do not use tools.');
    const fork = await rt.forkThread(source.id, boundary.id);
    assert.ok(fork.nativeSessionId);
    assert.notEqual(fork.nativeSessionId, source.nativeSessionId);
    assert.equal(fork.messages.length, 2, 'UI history ends at the selected reply');
    const nativeHistory = await rt.sessions.get(fork.id).process.command({ type: 'get_messages' });
    assert.ok(JSON.stringify(nativeHistory).includes('FORK-5921'));
    assert.ok(!JSON.stringify(nativeHistory).includes('LATER-9386'), 'native history excludes later turns');
    await send(fork, 'What token did I ask you to remember? Reply only that token. Do not use tools.');
    assert.ok(fork.messages.at(-1).text.includes('FORK-5921'));
    assert.equal(source.messages.length, 4);
    const usage = await rt.refreshUsage(fork.id);
    const stats = await rt.sessions.get(fork.id).process.command({ type: 'get_session_stats' });
    assert.equal(usage.tokens, stats.contextUsage.tokens);
    assert.equal(usage.contextWindow, stats.contextUsage.contextWindow);
    assert.ok(Math.abs(usage.contextPercent - 100 * stats.contextUsage.tokens / stats.contextUsage.contextWindow) < 0.00001);
    assert.deepEqual(rt.shadowReport().errors, []);
    assert.deepEqual(rt.shadowReport().mismatches, []);
    await fs.mkdir('output/verification', { recursive: true });
    await fs.writeFile('output/verification/core-fork-pi.json', JSON.stringify({ at: new Date().toISOString(), models: models.length,
      replyBoundaryVerified: true, laterTurnsExcluded: true, contextUsage: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.contextPercent }, report: rt.shadowReport() }, null, 2));
    console.log('pi: real model listing, fork identity, inherited history, fork event routing and shadow parity passed');
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
