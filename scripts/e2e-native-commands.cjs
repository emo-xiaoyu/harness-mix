const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const hid = process.argv[2] || 'claude';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-commands-'));
  const cwd = path.join(dir, 'project'); await fs.mkdir(cwd);
  if (hid === 'pi') {
    await fs.mkdir(path.join(cwd, '.pi'));
    await fs.writeFile(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1000, reserveTokens: 1000 } }));
  }
  const rt = new HostRuntime({ dataDirectory: dir });
  async function settle(t) {
    for (let i = 0; i < 900 && (t.status === 'working' || t.reviewPending); i++) await sleep(200);
    assert.equal(t.status, 'ready', t.error);
  }
  async function send(t, text) { await rt.send(t.id, text); await settle(t); }
  try {
    await rt.initialize();
    const source = await rt.createThread({ harnessId: hid, cwd, options: hid === 'pi' ? { permissionMode: 'approve' } : {} });
    await send(source, 'Remember FIRST-5921. Reply OK. Do not use tools.');
    const boundary = source.messages.at(-1);
    let target = source;
    if (hid === 'claude') {
      assert.ok(boundary.coreTurn.nativeTurnRef.checkpointId);
      await send(source, 'Remember LATER-9386. Reply OK. Do not use tools.');
      target = await rt.forkThread(source.id, boundary.id);
      const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
      const history = await getSessionMessages(target.nativeSessionId, { dir: cwd });
      assert.ok(JSON.stringify(history).includes('FIRST-5921'));
      assert.ok(!JSON.stringify(history).includes('LATER-9386'));
      assert.equal(target.messages.length, 2);
      // A branch of a branch must retain remapped native checkpoints.
      const second = await rt.forkThread(target.id, target.messages.at(-1).id);
      assert.notEqual(second.nativeSessionId, target.nativeSessionId);
      await send(target, 'Which token did I ask you to remember? Reply only the token. Do not use tools.');
      assert.ok(target.messages.at(-1).text.includes('FIRST-5921'));
      assert.ok(!target.messages.at(-1).text.includes('LATER-9386'));
      assert.equal(source.messages.length, 4);
    }
    const commands = await rt.listCommands({ threadId: target.id });
    assert.ok(commands.some(c => c.id === 'compact'));
    if (hid === 'pi') await send(target, 'Keep FIRST-5921 as the important token. The following is disposable test data. Reply OK without tools.\n' + Array.from({ length: 500 }, (_, i) => `Test record ${i}: alpha beta gamma delta epsilon zeta eta theta.`).join('\n'));
    await rt.executeCommand(target.id, 'compact'); await settle(target);
    await send(target, 'Which token did I first ask you to remember? Reply only the token. Do not use tools.');
    assert.ok(target.messages.at(-1).text.includes('FIRST-5921'));
    await fs.mkdir('output/verification', { recursive: true });
    await fs.writeFile(`output/verification/commands-${hid}.json`, JSON.stringify({ at: new Date().toISOString(), hid, nativeCompact: true, retainedContext: true, replyFork: hid === 'claude', sourceId: source.nativeSessionId, targetId: target.nativeSessionId }, null, 2));
    console.log(hid + ': native commands, retained context and fork boundaries passed');
  } finally { await rt.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
