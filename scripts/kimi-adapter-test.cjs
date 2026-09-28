const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const kimi = require('../src/main/adapters/kimi');
const { catalog } = require('../src/main/adapters/native-acp');
const { createKimiSubagentBridge, kimiAgentMessages } = require('../src/main/adapters/kimi-subagents');
const { workerSessionOptions } = require('../src/main/host/collaboration');
const { getHarnessSvg } = require('../src/main/native/icons');

(async () => {
  assert.equal(kimi.manifest.id, 'kimi-code');
  assert.equal(kimi.manifest.capabilities.resume, true);
  assert.equal(kimi.manifest.capabilities.fork, false);
  assert.equal(kimi.manifest.integrations.mcp, true);
  assert.equal(kimi.manifest.icon, 'kimi-code-moonshot.svg');
  assert.match(getHarnessSvg('kimi-code'), /<title>MoonshotAI<\/title>/);
  assert.deepEqual(workerSessionOptions('kimi-code', true), { workerPermissions: 'full-required' });
  const state = { configOptions: [
    { id: 'model', category: 'model', currentValue: 'kimi-code/k3', options: [{ value: 'kimi-code/k3', name: 'K3' }] },
    { id: 'thinking', category: 'thought_level', currentValue: 'on', options: [{ value: 'on', name: 'Thinking On' }] },
    { id: 'mode', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'yolo', name: 'YOLO' }] },
  ] };
  assert.deepEqual(catalog({ vendor: 'kimi-code', state }).thinkingLevels.map(x => x.id), ['on']);
  assert.deepEqual(catalog({ vendor: 'kimi-code', state }).permissionModes.map(x => x.id), ['default', 'yolo']);
  const rows = [
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'Investigate' }] } },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'Reasoning' } } },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Done' } } },
    { type: 'context.append_loop_event', event: { type: 'step.end' } },
  ];
  assert.deepEqual(kimiAgentMessages(rows).map(m => m.info.role), ['user', 'assistant']);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-bridge-'));
  const parentId = 'session_test-native';
  const file = path.join(root, 'sessions', 'wd_test', parentId, 'agents', 'worker-1', 'wire.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const events = [];
  const bridge = createKimiSubagentBridge({ parentId, environment: { KIMI_CODE_HOME: root }, emit: event => events.push(event) });
  try {
    bridge.resume();
    await bridge.scan();
    assert.equal(events[0].kind, 'native-subagent');
    assert.equal(events[0].nativeSessionId, `${parentId}:kimi:worker-1`);
    assert.equal(events[0].status, 'running');
    assert.equal(events[0].task, 'Investigate');
    const partial = { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Part one' } } };
    await fs.writeFile(file, [...rows, partial].map(row => JSON.stringify(row)).join('\n') + '\n');
    await bridge.scan();
    assert.equal(events.length, 1, 'an unfinished step must not advance the Host message cursor');
    const continued = [
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Part two' } } },
      { type: 'context.append_loop_event', event: { type: 'step.end' } },
    ];
    await fs.writeFile(file, [...rows, partial, ...continued].map(row => JSON.stringify(row)).join('\n') + '\n');
    await bridge.scan();
    assert.equal(events.at(-1).messages.length, 3);
    assert.deepEqual(events.at(-1).messages.at(-1).parts.map(part => part.text), ['Part one', 'Part two']);
    await bridge.scan();
    assert.equal(events.length, 2, 'unchanged native messages must not replay');
    await bridge.settle();
    assert.equal(events.at(-1).status, 'success');
  } finally { bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
  if (process.argv.includes('--native')) {
    const adapter = kimi.create();
    const inspection = await adapter.inspect();
    assert.equal(inspection.available, true, inspection.detail);
    const cwd = path.resolve('output', 'kimi-native-probe');
    await fs.mkdir(cwd, { recursive: true });
    let session;
    let stage = 'open';
    try {
      session = await adapter.open({ thread: { cwd }, emit: () => {} });
      assert.equal(session.state.agentCapabilities.promptCapabilities?.image, true);
      const nativeId = session.nativeSessionId;
      stage = 'thinking';
      await adapter.setThinkingLevel(session, 'on');
      stage = 'permission';
      await adapter.setPermissionMode(session, 'plan');
      assert.equal((await adapter.describeFor(session)).permissionModes.find(mode => mode.default)?.id, 'plan');
      await adapter.close(session);
      stage = 'resume';
      session = await adapter.open({ thread: { cwd, restore: true, nativeSessionId: nativeId }, emit: () => {} });
      assert.equal(session.nativeSessionId, nativeId);
    } catch (error) { throw new Error(`${stage}: ${error.message}`, { cause: error }); }
    finally { await adapter.close(session); }
  }
  console.log('kimi-adapter: native catalog, worker mode and clickable subagent projection PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
