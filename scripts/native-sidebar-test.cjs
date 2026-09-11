const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { includesThread, mergeThreadPage } = require('../src/main/native/thread-list');
const { cacheCodexRuntime } = require('../src/main/native/launcher');

const thread = { id: 'external', title: 'Pi session', cwd: 'E:/project', createdAt: 10 };
for (const query of [
  { sectionId: 'pinned' }, { ancestorThreadId: 'external' }, { parentThreadId: 'external' },
  { sourceKinds: ['subAgentThreadSpawn'] }, { modelProviders: ['openai'] },
  { cwd: ['E:/other'] }, { archived: true }, { searchTerm: 'missing' }, { projectId: 'other' },
]) assert.equal(includesThread(thread, query), false, JSON.stringify(query));
for (const query of [{}, { sectionId: null }, { cwd: ['E:/project'] }, { searchTerm: 'PI' }, { modelProviders: [] }]) {
  assert.equal(includesThread(thread, query), true, JSON.stringify(query));
}
assert.equal(includesThread({ ...thread, ephemeral: true }, {}), false);
assert.equal(includesThread({ ...thread, section: { id: 'pinned' } }, { sectionId: 'pinned' }), true);
const page = { data: [{ id: 'official', createdAt: 20 }, thread], nextCursor: 'next' };
const merged = mergeThreadPage(page, [thread], {}, t => t);
assert.deepEqual(merged.data.map(t => t.id), ['official', 'external']);
assert.equal(merged.nextCursor, 'next');
assert.equal(mergeThreadPage(page, [thread], { cursor: 'next' }, t => t), page);

const root = fs.mkdtempSync(path.resolve('output/native-runtime-cache-test-'));
const resources = path.join(root, 'resources');
const cache = path.join(root, 'cache');
fs.mkdirSync(resources); fs.mkdirSync(cache);
for (const name of ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe', 'rg.exe']) {
  fs.writeFileSync(path.join(resources, name), `fixture:${name}`);
}
fs.writeFileSync(path.join(resources, 'unrelated.exe'), 'unrelated');
fs.copyFileSync(path.join(resources, 'codex.exe'), path.join(cache, 'codex.exe'));
cacheCodexRuntime(resources, cache);
assert.equal(fs.existsSync(path.join(cache, 'unrelated.exe')), false);
assert.equal(fs.readFileSync(path.join(cache, 'codex-code-mode-host.exe'), 'utf8'), 'fixture:codex-code-mode-host.exe');
fs.truncateSync(path.join(cache, 'codex-code-mode-host.exe'), 0);
cacheCodexRuntime(resources, cache);
assert.ok(fs.statSync(path.join(cache, 'codex-code-mode-host.exe')).size > 0);
console.log('PASS: section/tree filters, deduplication, and incomplete Codex runtime cache repair');

async function testPrewarm() {
  const file = path.join(root, 'prewarm.cjs');
  await require('esbuild').build({ entryPoints: ['src/native-ui/desktop-control/src/renderer-draft-prewarm-runtime.ts'], outfile: file, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { installDraftPrewarmPolicyBridge } = require(file);
  const sent = [];
  const prewarmed = [];
  const bridge = { sendRequest: (method, params) => sent.push({ method, params }), prewarmThreadStart: params => prewarmed.push(params) };
  const manager = { onNotification() {}, onRequest() {}, dispatchAppServerResponse() {} };
  const target = {};
  installDraftPrewarmPolicyBridge(manager, bridge, 'local', target, { discardAllPrewarmedThreads() {} });
  const policy = target.__codexhostDraftPrewarmPolicyV1;
  for (const harness of ['pi', 'claude-code', 'deepseek-harness', 'antigravity']) {
    policy.select(`codexhost/${harness}-native`);
    bridge.prewarmThreadStart({ cwd: 'E:/project', model: 'gpt-test' });
    bridge.sendRequest('thread/start', { cwd: 'E:/project', model: 'gpt-test' });
    assert.equal(prewarmed.at(-1).ephemeral, true);
    assert.equal(prewarmed.at(-1).model, `codexhost/${harness}-native`);
    assert.equal(sent.at(-1).params.ephemeral, undefined);
  }
  bridge.prewarmThreadStart({ ephemeral: true, model: 'gpt-title' });
  assert.equal(prewarmed.at(-1).model, 'gpt-title', 'Internal ephemeral Codex tasks retain their own model');
  policy.select(null);
  bridge.prewarmThreadStart({ model: 'gpt-test' });
  assert.deepEqual(prewarmed.at(-1), { model: 'gpt-test' });
  policy.dispose();
  console.log('PASS: all four external prewarm routes stay ephemeral; actual starts and Codex internal tasks are preserved');
  const sidebarFile = path.join(root, 'sidebar.cjs');
  await require('esbuild').build({ entryPoints: ['src/native-ui/renderer-extension/src/renderer-sidebar-agent-icons.ts'], outfile: sidebarFile, bundle: true, platform: 'node', format: 'cjs', alias: { '@codexhost/shared-contracts': path.resolve('src/native-ui/shared-contracts/src/index.ts') }, loader: { '.png': 'dataurl', '.svg': 'dataurl' }, logLevel: 'silent' });
  const { installRendererSidebarAgentIcons } = require(sidebarFile);
  let cleared = 0;
  let agent = null;
  let resolveOwnership;
  const row = { isConnected: () => true, hostId: () => 'local', threadId: () => 'test', draftId: () => null, render: value => { agent = value; }, clear: () => { agent = null; cleared++; } };
  const control = installRendererSidebarAgentIcons({ dom: { rows: () => [row], observe: () => () => {}, clear() {} }, getClient: () => ({ listThreadOwnership: () => new Promise(resolve => { resolveOwnership = resolve; }) }) });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle(); resolveOwnership({ threads: [{ threadId: 'test', owner: 'codex' }] }); await settle();
  assert.equal(agent, 'codex');
  const clearsBeforeRefresh = cleared;
  control.refresh(); await settle();
  assert.equal(agent, 'codex');
  assert.equal(cleared, clearsBeforeRefresh, 'Retain the visible icon while background ownership is unresolved');
  resolveOwnership({ threads: [{ threadId: 'test', owner: 'external', harnessId: 'pi' }] }); await settle();
  assert.equal(agent, 'pi');
  assert.equal(cleared, clearsBeforeRefresh, 'Replace identity without an empty frame');
  control.dispose();
  console.log('PASS: sidebar revalidation preserves icons until authoritative ownership arrives');
}
testPrewarm().catch(error => { console.error(error); process.exitCode = 1; });
