const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Integrations } = require('../src/main/host/integrations');
const { buildAdapters } = require('../src/main/adapters');
const { NativeProtocol } = require('../src/main/native/protocol');
const { acpServers, namedServers } = require('../src/main/adapters/managed-mcp');

async function main() {
  const root = path.resolve('output/integrations-test', `${Date.now()}`);
  const project = path.join(root, 'project'), home = path.join(root, 'home');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(home);
  const adapters = new Map(buildAdapters(() => {}).map(a => [a.manifest.id, a]));
  const runtime = { adapters, status: {}, sessions: new Map(), store: { directory: path.join(root, 'data') }, resolveHarnessId: id => id };
  const manager = runtime.integrations = new Integrations(runtime, { home, environment: {} });
  const global = { harnessId: 'claude', scope: 'global' }, local = { harnessId: 'claude', scope: 'project', cwd: project };
  const server = { name: 'probe', command: process.execPath, args: ['probe.cjs'], enabled: true };
  await Promise.all([manager.save({ ...global, server }), manager.save({ ...local, server: { ...server, enabled: false } })]);
  assert.equal((await manager.forSession({ cwd: project }, adapters.get('claude'))).servers.length, 0, 'project disabled entry masks global');
  let snapshot = await manager.list(local);
  assert.equal(snapshot.servers.length, 2); assert.equal(snapshot.servers.filter(s => s.effective).length, 1);
  await manager.remove({ ...local, id: snapshot.servers.find(s => s.scope === 'project').id });
  const selected = await manager.forSession({ cwd: project }, adapters.get('claude'));
  assert.equal(selected.servers[0].name, 'hm-user-probe');
  runtime.sessions.set('s', { adapter: adapters.get('claude'), nativeSessionId: 'native-test', integrationCwd: await fs.realpath(project), integrationServers: selected.records,
    query: { mcpServerStatus: async () => [{ name: 'hm-user-probe', status: 'connected', config: { token: 'DO_NOT_PROJECT' }, tools: [{ name: 'echo' }] }] } });
  snapshot = await manager.list(local);
  assert.equal(snapshot.servers[0].appliedSessions, 1); assert.equal(snapshot.native[0].status, 'connected'); assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_PROJECT'));
  await manager.save({ ...global, server: { ...server, args: ['changed.cjs'] } });
  assert.equal((await manager.list(global)).servers[0].appliedSessions, 0, 'changed config not claimed as applied');
  const reload = new Integrations(runtime, { home }); assert.equal((await reload.list(global)).servers.length, 1);
  const stdioExtended = { name: 'stdio-ext', command: process.execPath, args: ['probe.cjs'], env: { NODE_ENV: 'test' }, env_vars: ['PATH'], cwd: project, enabled: true };
  await manager.save({ ...local, server: stdioExtended });
  const stdioLoaded = (await manager.list(local)).servers.find(s => s.name === 'stdio-ext');
  assert.equal(stdioLoaded.transportType, 'stdio');
  assert.deepEqual(stdioLoaded.env, { NODE_ENV: 'test' });
  assert.deepEqual(stdioLoaded.env_vars, ['PATH']);
  assert.equal(stdioLoaded.cwd, project);

  const http = { name: 'http-probe', transportType: 'streamable_http', url: 'https://mcp.example.com/mcp', bearer_token_env_var: 'MCP_TOKEN', http_headers: { 'X-Custom': 'val' }, env_http_headers: { 'X-Auth': 'TOKEN_VAR' }, enabled: true };
  await manager.save({ ...global, server: http });
  const httpLoaded = (await manager.list(global)).servers.find(s => s.name === 'http-probe');
  assert.equal(httpLoaded.transportType, 'streamable_http');
  assert.equal(httpLoaded.url, 'https://mcp.example.com/mcp');
  assert.equal(httpLoaded.bearer_token_env_var, 'MCP_TOKEN');
  assert.deepEqual(httpLoaded.http_headers, { 'X-Custom': 'val' });
  assert.deepEqual(httpLoaded.env_http_headers, { 'X-Auth': 'TOKEN_VAR' });

  await assert.rejects(manager.save({ ...global, server: { ...server, invalidProp: 'never' } }));
  await assert.rejects(manager.save({ ...global, server: { ...server, args: ['--token', 'never'] } }));
  await assert.rejects(manager.save({ ...global, server: { name: 'bad-url', url: 'invalid-url', enabled: true } }));
  await assert.rejects(manager.save({ ...global, server: { name: 'bad-bearer', url: 'https://example.com', bearer_token_env_var: '123-bad', enabled: true } }));
  await assert.rejects(manager.save({ ...global, harnessId: 'pi', server }), /no supported/);
  await assert.rejects(manager.remove({ ...local, id: snapshot.servers[0].id }), /scope/);
  await assert.rejects(manager.list({ ...local, cwd: 'relative' }));
  const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: sample\ndescription: Sample skill\n---\n# Sample\n');
  await fs.writeFile(path.join(source, 'scripts', 'sample.txt'), 'unchanged');
  await manager.skillChange({ ...local, name: 'sample', source, action: 'install' });
  const nativeFile = path.join(project, '.claude/skills/sample/SKILL.md'); assert.match(await fs.readFile(nativeFile, 'utf8'), /Sample/);
  await assert.rejects(manager.skillChange({ ...local, name: 'sample', source, action: 'install' }), /already exists/);
  await manager.skillChange({ ...local, name: 'sample', action: 'disable' });
  await assert.rejects(fs.access(nativeFile)); assert.equal((await manager.list(local)).skills[0].enabled, false);
  await manager.skillChange({ ...local, name: 'sample', action: 'enable' });
  assert.equal(await fs.readFile(path.join(project, '.claude/skills/sample/scripts/sample.txt'), 'utf8'), 'unchanged');
  const droppedMarkdown = Buffer.from('---\nname: dropped\ndescription: Dropped skill\n---\n# Dropped\n').toString('base64');
  await manager.skillChange({ ...local, name: 'dropped', files: [{ path: 'SKILL.md', contentBase64: droppedMarkdown }], action: 'install' });
  assert.match(await fs.readFile(path.join(project, '.claude/skills/dropped/SKILL.md'), 'utf8'), /Dropped skill/);
  await assert.rejects(manager.skillChange({ ...local, name: 'escape', files: [{ path: '../SKILL.md', contentBase64: droppedMarkdown }], action: 'install' }), /invalid path/);
  await assert.rejects(manager.skillChange({ ...local, name: 'bad-data', files: [{ path: 'SKILL.md', contentBase64: '***' }], action: 'install' }), /invalid file data/);
  await assert.rejects(manager.skillChange({ ...local, name: '../escape', source, action: 'install' }));
  await assert.rejects(manager.skillChange({ ...local, name: 'sample', root, action: 'disable' }));
  const link = path.join(project, '.claude/skills/linked');
  await fs.symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await manager.list(local)).skills.find(s => s.name === 'linked').writable, false);
  await assert.rejects(manager.skillChange({ ...local, name: 'linked', action: 'disable' }), /read-only/);
  const collab = { command: 'native-node', args: ['bridge'], env: { LOCAL_BRIDGE: 'capability' } };
  const acp = acpServers(selected.servers, collab);
  assert.equal(acp.length, 2); assert.equal(acp[1].name, 'harness-mix'); assert.deepEqual(acp[0].env, []);
  assert.ok(namedServers(selected.servers, collab)['hm-user-probe']);
  const catalog = await manager.catalog(); assert.equal(catalog.harnesses.length, 16);
  for (const a of adapters.values()) {
    const entry = catalog.harnesses.find(h => h.id === a.manifest.id);
    assert.equal(entry.mcp, a.manifest.integrations?.mcp === true);
    assert.equal(entry.skills, true, `${a.manifest.id} must declare verified native skill roots`);
    const roots = await manager.ensureSkillRoots({ cwd: project }, a);
    assert.ok(roots.length > 0, `${a.manifest.id} must resolve at least one native skill root`);
    for (const skillRoot of roots) assert.equal((await fs.stat(skillRoot)).isDirectory(), true);
  }
  assert.deepEqual(manager.roots(adapters.get('antigravity'), { scope: 'global', cwd: null }), [path.join(home, '.gemini/config/skills')]);
  assert.deepEqual(manager.roots(adapters.get('dsh'), { scope: 'project', cwd: project }), [path.join(project, '.dsh/skills'), path.join(project, '.agents/skills')]);
  assert.deepEqual(manager.roots(adapters.get('zcode'), { scope: 'global', cwd: null }), [path.join(home, '.zcode/skills'), path.join(home, '.agents/skills')]);
  assert.deepEqual(manager.roots(adapters.get('zcode'), { scope: 'project', cwd: project }), [path.join(project, '.zcode/skills'), path.join(project, '.agents/skills')]);
  // Trae IDE (.trae) and TraeCode CLI (.traecli) share one managed root set.
  assert.deepEqual(manager.roots(adapters.get('trae'), { scope: 'project', cwd: project }), [path.join(project, '.trae/skills'), path.join(project, '.traecli/skills'), path.join(project, '.agents/skills')]);
  // Hermes documents no project-scope skills directory, so only its global root is managed.
  assert.deepEqual(manager.roots(adapters.get('hermes'), { scope: 'project', cwd: project }), []);
  assert.deepEqual(manager.roots(adapters.get('hermes'), { scope: 'global', cwd: null }), [path.join(home, '.hermes/skills')]);
  // Environment overrides relocate global roots; the deprecated-but-loaded $CODEX_HOME/skills stays discoverable.
  const codexHome = path.join(root, 'codex-home'), hermesHome = path.join(root, 'hermes-home');
  const overridden = new Integrations(runtime, { home, environment: { CODEX_HOME: codexHome, HERMES_HOME: hermesHome } });
  assert.deepEqual(overridden.roots(adapters.get('codex'), { scope: 'global', cwd: null }), [path.join(home, '.agents/skills'), path.join(codexHome, 'skills')]);
  assert.deepEqual(overridden.roots(adapters.get('hermes'), { scope: 'global', cwd: null }), [path.join(hermesHome, 'skills')]);
  // A root that cannot be created is reported and skipped, never fatal to opening a session.
  const blockedHome = path.join(root, 'blocked-home');
  await fs.mkdir(path.join(blockedHome, '.codex'), { recursive: true });
  await fs.writeFile(path.join(blockedHome, '.codex', 'skills'), 'not a directory');
  const blocked = new Integrations(runtime, { home: blockedHome, environment: {} });
  const reported = [];
  const ensured = await blocked.ensureSkillRoots({ cwd: project }, adapters.get('codex'), { onError: message => reported.push(message) });
  assert.ok(!ensured.some(value => value.endsWith(path.join('.codex', 'skills'))), 'uncreatable root is skipped');
  assert.equal(ensured.length, 2, 'the remaining global and project roots are still created');
  assert.equal(reported.length, 1, 'the skipped root is reported');
  assert.equal((await fs.stat(ensured[0])).isDirectory(), true);
  // An unusable project scope degrades to global roots instead of failing the launch.
  const globalOnly = await blocked.ensureSkillRoots({ cwd: 'relative-not-absolute' }, adapters.get('codex'), {});
  assert.equal(globalOnly.length, 1);
  // Exercise the real protocol dispatcher without starting native processes.
  assert.equal((await NativeProtocol.prototype.request.call({ runtime }, 'codexhost/integrations/catalog', {})).harnesses.length, 16);
  assert.equal((await NativeProtocol.prototype.request.call({ runtime }, 'codexhost/integrations/list', local)).skills.length, 3);
  console.log('integrations: scope precedence, persistence, native status projection, no credential fields, unsupported capabilities, skill install/disable/restore, links, and protocol PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
