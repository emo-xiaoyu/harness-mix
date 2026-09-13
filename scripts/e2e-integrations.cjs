const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Integrations } = require('../src/main/host/integrations');
const { buildAdapters } = require('../src/main/adapters');

async function main() {
  const id = process.argv.find(a => a.startsWith('--harness='))?.split('=')[1] || 'claude';
  const root = path.resolve('output/integrations-e2e', `${id}-${Date.now()}`), cwd = path.join(root, 'project');
  await fs.mkdir(cwd, { recursive: true });
  const adapters = new Map(buildAdapters(() => {}).map(a => [a.manifest.id, a]));
  const adapter = adapters.get(id); assert.ok(adapter?.manifest.integrations?.mcp);
  const runtime = { adapters, status: {}, sessions: new Map(), store: { directory: path.join(root, 'data') }, resolveHarnessId: id => id };
  const manager = new Integrations(runtime), selected = { harnessId: id, scope: 'project', cwd };
  const log = path.join(root, 'mcp-methods.log');
  await manager.save({ ...selected, server: { name: 'acceptance', command: process.execPath, args: [path.resolve('scripts/support/integrations-mcp-fixture.cjs'), log], enabled: true } });
  if (adapter.manifest.integrations.skills) {
    const source = path.join(root, 'skill'); await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: hm-integration-acceptance\ndescription: Read-only Harness Mix integration acceptance fixture.\n---\nReturn HARNESS_MIX_SKILL_OK.\n');
    await manager.skillChange({ ...selected, name: 'hm-integration-acceptance', source, action: 'install' });
  }
  const thread = { id: randomUUID(), nativeSessionId: randomUUID(), cwd, title: 'Integration acceptance', options: {} };
  const injected = await manager.forSession(thread, adapter);
  let session;
  const deadline = setTimeout(() => { console.error('Native acceptance timed out'); process.exit(1); }, 55000);
  try {
    session = await adapter.open({ thread, managedMcp: injected.servers, emit: () => {}, diagnostic: () => {} });
    session.adapter = adapter; session.integrationServers = injected.records; session.integrationCwd = injected.cwd;
    runtime.sessions.set(thread.id, session);
    let native = [], methods = '';
    for (let attempt = 0; attempt < 15; attempt++) {
      native = adapter.inspectIntegrations ? await adapter.inspectIntegrations(session) : [];
      try { methods = await fs.readFile(log, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (native.some(s => s.name === 'hm-user-acceptance' && s.status === 'connected')) break;
      if (!adapter.inspectIntegrations && methods.includes('tools/list')) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (adapter.inspectIntegrations) assert.ok(native.some(s => s.name === 'hm-user-acceptance' && s.status === 'connected'), 'native Harness must report connected');
    methods = await fs.readFile(log, 'utf8'); assert.match(methods, /initialize/); assert.match(methods, /tools\/list/);
    let skillLoaded = null;
    if (session.query?.supportedCommands) {
      const commands = await session.query.supportedCommands();
      skillLoaded = commands.some(c => c.name === 'hm-integration-acceptance');
      assert.equal(skillLoaded, true, 'native Claude must discover the installed project skill');
    }
    const snapshot = await manager.list(selected); assert.equal(snapshot.servers[0].appliedSessions, 1);
    const report = { harness: id, nativeMcpConnected: native.some(s => s.name === 'hm-user-acceptance' && s.status === 'connected') || null, nativeToolDiscovery: true, skillLoaded, modelTurnExecuted: false, automaticApproval: false };
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, root }));
  } finally { clearTimeout(deadline); if (session) await adapter.close(session); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
