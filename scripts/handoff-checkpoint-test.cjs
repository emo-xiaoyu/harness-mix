const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HandoffCheckpoints } = require('../src/main/host/handoff-checkpoints');
const { HandoffAccess } = require('../src/main/host/handoff-access');
const { dispatch } = require('../src/main/host/handoff-mcp.cjs');

async function main() {
  await fs.mkdir('output', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('output/handoff-checkpoint-'));
  const runtime = {
    store: { directory: path.join(root, 'data') },
    adapters: new Map([['target', { manifest: { integrations: { mcp: true } } }]]),
  };
  runtime.handoffs = new HandoffCheckpoints(runtime);
  await runtime.handoffs.initialize();

  const thread = {
    id: 'thread-a',
    harnessId: 'source',
    title: '修复登录模块',
    cwd: process.cwd(),
    messages: [
      { id: 'user-1', role: 'user', text: '继续实现，api_key=supersecretvalue123' },
      {
        id: 'assistant-1', role: 'assistant', text: '先跑测试再修复', coreItems: [
          { type: 'plan', entries: [{ text: '定位失败', status: 'completed' }, { text: '实现修复', status: 'in_progress' }] },
          { type: 'tool_call', toolCallId: 'native-replay-id', title: 'npm test', state: 'error', input: 'token=anothersecretvalue', output: 'authorization: Bearer abcdefghijklmnop\n1 test failed' },
          { type: 'file_change', path: 'src/login.js', changeType: 'modified', before: 'a', after: 'b' },
        ],
      },
    ],
  };

  const checkpoint = await runtime.handoffs.create(thread, 'target', { intent: 'execute-plan' });
  assert.match(checkpoint.checkpointId, /^handoff_[a-f0-9]{24}$/);
  assert.equal(checkpoint.onDemandAccess, 'mcp');
  assert.equal(checkpoint.intent, 'execute-plan');
  assert.equal(checkpoint.plan.inProgress[0], '实现修复');
  assert.equal(checkpoint.fileState.files[0].path, 'src/login.js');
  assert.match(checkpoint.fileState.diffDigest, /^[a-f0-9]{64}$/);
  assert.ok(checkpoint.fileState.gitHead === null || /^[a-f0-9]{40,64}$/.test(checkpoint.fileState.gitHead));
  const serialized = JSON.stringify(checkpoint);
  assert.doesNotMatch(serialized, /supersecretvalue123|anothersecretvalue|abcdefghijklmnop|native-replay-id/);
  assert.match(serialized, /\[redacted\]/);

  thread.messages[0].text = 'mutated after handoff';
  assert.doesNotMatch(JSON.stringify(runtime.handoffs.owned(thread.id, checkpoint.checkpointId)), /mutated after handoff/);

  const access = new HandoffAccess(runtime);
  const connection = await access.connection({ ...thread, harnessId: 'target', pendingHandoff: { checkpointId: checkpoint.checkpointId } });
  assert.ok(connection);
  const oldUrl = process.env.HARNESS_MIX_HANDOFF_URL;
  const oldKey = process.env.HARNESS_MIX_HANDOFF_KEY;
  process.env.HARNESS_MIX_HANDOFF_URL = connection.env.HARNESS_MIX_HANDOFF_URL;
  process.env.HARNESS_MIX_HANDOFF_KEY = connection.env.HARNESS_MIX_HANDOFF_KEY;
  try {
    const catalog = await dispatch({ id: 1, method: 'tools/list' });
    assert.deepEqual(catalog.tools.map(tool => tool.name), [
      'get_handoff_checkpoint', 'list_handoff_conversation', 'list_handoff_evidence',
      'read_handoff_evidence', 'list_handoff_files', 'read_handoff_plan',
    ]);
    const result = await dispatch({ id: 2, method: 'tools/call', params: { name: 'get_handoff_checkpoint', arguments: { checkpoint_id: checkpoint.checkpointId } } });
    const summary = JSON.parse(result.content[0].text);
    assert.equal(summary.checkpointId, checkpoint.checkpointId);
    assert.equal(summary.status, 'checkpoint-created');
    const denied = await dispatch({ id: 3, method: 'tools/call', params: { name: 'get_handoff_checkpoint', arguments: { checkpoint_id: 'handoff_outside_scope' } } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /outside this native session scope/);
  } finally {
    if (oldUrl === undefined) delete process.env.HARNESS_MIX_HANDOFF_URL; else process.env.HARNESS_MIX_HANDOFF_URL = oldUrl;
    if (oldKey === undefined) delete process.env.HARNESS_MIX_HANDOFF_KEY; else process.env.HARNESS_MIX_HANDOFF_KEY = oldKey;
    await access.close();
  }

  const reloaded = new HandoffCheckpoints(runtime);
  await reloaded.initialize();
  assert.equal(reloaded.get(thread.id, checkpoint.checkpointId).contentDigest, checkpoint.contentDigest);
  await reloaded.close();
  console.log('PASS: immutable handoff checkpoint, redaction, persistence and scoped read-only MCP access');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
