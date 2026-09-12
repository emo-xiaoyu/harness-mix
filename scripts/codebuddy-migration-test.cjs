const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const registry = require('../src/main/adapters');
const codebuddy = require('../src/main/adapters/codebuddy');
const savedBuilder = registry.buildAdapters;
registry.buildAdapters = () => [{ manifest: codebuddy.manifest, inspect: async () => ({ available: true }) }];
const { HostRuntime } = require('../src/main/host/runtime');
registry.buildAdapters = savedBuilder;

(async () => {
  const directory = path.resolve('output', 'codebuddy-migration-' + Date.now());
  await fs.mkdir(directory, { recursive: true });
  const thread = { id: 'old-thread', harnessId: 'workbuddy', nativeSessionId: 'native-unchanged', cwd: directory, title: 'Keep my title',
    messages: [], tools: [], status: 'ready', createdAt: 1,
    harnessChain: [{ harnessId: 'workbuddy', nativeSessionId: 'previous-native', options: { model: { id: 'native-model' } } }],
    pendingHandoff: { fromHarnessId: 'workbuddy' } };
  await fs.writeFile(path.join(directory, 'threads.json'), JSON.stringify([thread]));
  const runtime = new HostRuntime({ dataDirectory: directory });
  await runtime.initialize();
  const restored = runtime.threads[0];
  assert.equal(restored.harnessId, 'codebuddy');
  assert.equal(restored.nativeSessionId, 'native-unchanged');
  assert.equal(restored.title, thread.title);
  assert.equal(restored.harnessChain[0].harnessId, 'codebuddy');
  assert.equal(restored.harnessChain[0].nativeSessionId, 'previous-native');
  assert.equal(restored.pendingHandoff.fromHarnessId, 'codebuddy');
  assert.equal(runtime.resolveHarnessId('Workbuddy'), 'codebuddy');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'threads.json'), 'utf8'))[0].harnessId, 'codebuddy');
  const history = require('../src/main/adapters/codebuddy-history');
  const savedRoot = process.env.CODEBUDDY_CONFIG_DIR;
  process.env.CODEBUDDY_CONFIG_DIR = path.join(directory, 'native-config');
  try {
    const projects = path.join(process.env.CODEBUDDY_CONFIG_DIR, 'projects', 'workspace');
    await fs.mkdir(projects, { recursive: true });
    const file = path.join(projects, 'session.jsonl');
    const rows = [{ type: 'message', id: 'u', role: 'user', content: 'Hello', cwd: directory, sessionId: 'session' },
      { type: 'message', id: 'a', parentId: 'u', role: 'assistant', content: 'Reply', cwd: directory, sessionId: 'session' }];
    await fs.writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(history.messages(await history.readCodeBuddyHistory(directory, 'session')).length, 2);
    await assert.rejects(history.readCodeBuddyHistory(process.cwd(), 'session'), /another workspace/);
    await assert.rejects(history.readCodeBuddyHistory(directory, '../escape'), /Invalid/);
    await fs.appendFile(file, '{broken');
    await assert.rejects(history.readCodeBuddyHistory(directory, 'session'));
  } finally { if (savedRoot === undefined) delete process.env.CODEBUDDY_CONFIG_DIR; else process.env.CODEBUDDY_CONFIG_DIR = savedRoot; }
  console.log('CodeBuddy migration: old name, persisted identity, switch history and title preserved PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
