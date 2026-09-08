const { ParityObserver } = require('./support/parity-observer.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const harnessId = process.argv[2];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('native request timeout')), 120000); timer.unref();
})]);
(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), `hm-core-resume-${harnessId}-`));
  const root = path.join(data, 'workspace'); await fs.mkdir(root);
  let rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: data });
  const reports = [];
  async function send(id, prompt) {
    await timeout(rt.send(id, prompt));
    const thread = rt.threads.find(t => t.id === id);
    for (let i = 0; i < 600 && (thread.status === 'working' || thread.reviewPending); i++) await sleep(200);
    assert.equal(thread.status, 'ready', thread.error);
    const message = thread.messages.at(-1);
    assert.equal(message.coreTurn.status, 'completed');
    assert.ok(message.coreItems.some(i => i.phase === 'final' && i.content));
    assert.deepEqual(rt.shadowReport().errors, []);
    assert.deepEqual(rt.shadowReport().mismatches, []);
    reports.push({ turnId: message.coreTurnId, status: message.coreTurn.status, report: structuredClone(rt.shadowReport()) });
    return message;
  }
  try {
    await rt.initialize();
    const thread = await rt.createThread({ harnessId, cwd: root, title: 'Core resume acceptance' });
    await send(thread.id, 'Remember the token HM-4827. Reply only OK. Do not use tools.');
    const nativeSessionId = thread.nativeSessionId;
    await rt.close();
    rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: data });
    await rt.initialize();
    const restored = rt.threads.find(t => t.id === thread.id);
    assert.equal(restored.restore, true);
    assert.equal(restored.messages.at(-1).coreTurn.status, 'completed');
    const reply = await send(thread.id, 'What token did I ask you to remember? Reply only with the token. Do not use tools.');
    assert.ok(reply.coreItems.some(i => i.phase === 'final' && i.content.includes('HM-4827')), 'native history was not restored');
    assert.equal(restored.nativeSessionId, nativeSessionId);
    assert.notEqual(reports[0].turnId, reports[1].turnId);
    await fs.mkdir('output/verification', { recursive: true });
    await fs.writeFile(`output/verification/core-resume-${harnessId}.json`, JSON.stringify({ harnessId, at: new Date().toISOString(), reports }, null, 2));
    console.log(`${harnessId}: native reopen + memory recall + Core final + zero shadow mismatch PASSED`);
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
