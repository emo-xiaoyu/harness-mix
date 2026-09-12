const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');

(async () => {
  const directory = await fs.mkdtemp(path.resolve('output/dsh-collaboration-acp-'));
  const rt = new HostRuntime({ dataDirectory: path.join(directory, 'data') });
  try {
    await rt.initialize();
    const thread = await rt.createThread({ harnessId: 'dsh', cwd: directory, title: 'DSH ACP lead probe' });
    const session = rt.sessions.get(thread.id);
    assert.equal(session.dshAcpLead, true);
    assert.equal(session.collaborationEnabled, true);
    assert.ok(session.mcpServers.some(server => server.name === 'harness-mix'));
    assert.ok(session.nativeSessionId);
    console.log('DSH lead: official ACP session accepted the session-scoped Harness Mix MCP server PASS');
  } finally { await rt.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
