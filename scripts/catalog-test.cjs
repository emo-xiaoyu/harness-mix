const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-catalog-'));
  const rt = new HostRuntime({ dataDirectory: dir });
  try {
    await rt.initialize();
    for (const harnessId of ['pi', 'dsh']) {
      const thread = await rt.createThread({ harnessId, cwd: dir });
      const session = rt.sessions.get(thread.id);
      const catalog = await rt.describe(harnessId);
      assert.ok(catalog.models.length, harnessId + ' live model catalog');
      assert.equal(rt.sessions.get(thread.id), session);
      assert.equal(await rt.describe(harnessId), catalog, 'cached catalog reused');
      await session.adapter.close(session); rt.sessions.delete(thread.id);
      const commands = await rt.listCommands({ threadId: thread.id });
      assert.equal(rt.sessions.has(thread.id), false, 'menu never restores session');
      if (harnessId === 'pi') assert.ok(commands.some(c => c.id === 'compact'));
    }
    console.log('native Pi/DSH catalogs reused; command menu does not restore sessions');
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
