const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAntigravitySubagentBridge, transcriptMessages } = require('../src/main/adapters/antigravity-subagents');

const parent = '11111111-1111-4111-8111-111111111111';
const sibling = '22222222-2222-4222-8222-222222222222';
const child = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const row = (index, type, content) => JSON.stringify({ step_index: index, type, status: 'DONE',
  created_at: '2026-01-01T00:00:00Z', content });

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-agy-subagent-'));
  try {
    const brain = path.join(home, '.gemini', 'antigravity-cli', 'brain');
    const metadata = async (owner, id, state) => {
      const dir = path.join(brain, owner, '.system_generated', 'subagents');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ conversationId: id,
        subagentDescriptor: { role: 'Reviewer' }, state }));
    };
    const transcript = async (id, rows) => {
      const dir = path.join(brain, id, '.system_generated', 'logs');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'transcript_full.jsonl'), rows.join('\n') + '\n');
    };
    await metadata(parent, child, 'SUBAGENT_STATE_ALIVE');
    await metadata(sibling, other, 'SUBAGENT_STATE_KILLED');
    await transcript(child, [row(0, 'USER_INPUT', 'Check this'), row(1, 'PLANNER_RESPONSE', 'Working')]);
    await transcript(other, [row(0, 'USER_INPUT', 'Unrelated')]);
    const events = [];
    const bridge = createAntigravitySubagentBridge({ parentId: parent, home, emit: event => events.push(event) });
    await bridge.scan();
    assert.equal(events.length, 1);
    assert.equal(events[0].nativeSessionId, child);
    assert.equal(events[0].status, 'running');
    assert.deepEqual(events[0].messages.map(item => item.info.role), ['user', 'assistant']);
    await bridge.scan();
    assert.equal(events.length, 1, 'unchanged child must not replay');
    await transcript(child, [row(0, 'USER_INPUT', 'Check this'), row(1, 'PLANNER_RESPONSE', 'Working'),
      row(2, 'GENERIC', 'Tool output'), row(3, 'PLANNER_RESPONSE', 'Finished')]);
    await metadata(parent, child, 'SUBAGENT_STATE_KILLED');
    await bridge.scan();
    assert.equal(events.length, 2);
    assert.equal(events[1].status, 'failed');
    assert.equal(events[1].messages.length, 4);
    bridge.close();
    assert.equal(transcriptMessages(row(0, 'USER_INPUT', 'ok') + '\n{incomplete').length, 1);
    console.log('antigravity-subagent: parent isolation, native transcript, append, terminal state and partial JSONL passed');
  } finally {
    const target = path.resolve(home);
    if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
