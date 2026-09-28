const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCodeBuddySubagentBridge } = require('../src/main/adapters/codebuddy-subagents');

const parent = 'parent-123', sibling = 'parent-456', child = 'child-123';
const row = value => JSON.stringify(value);

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-codebuddy-subagent-'));
  try {
    const cwd = path.join(home, 'workspace');
    const project = path.join(home, '.codebuddy', 'projects', 'workspace');
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(project, parent, 'subagents'), { recursive: true });
    await fs.mkdir(path.join(project, sibling, 'subagents'), { recursive: true });
    const parentFile = path.join(project, `${parent}.jsonl`);
    await fs.writeFile(parentFile, row({ id: 'p1', type: 'message', role: 'user', content: 'Parent',
      sessionId: parent, cwd }) + '\n');
    await fs.writeFile(path.join(project, parent, 'subagents', `agent-${child}.jsonl`), [
      row({ id: 'c1', type: 'message', role: 'user', content: 'Inspect code' }),
      row({ id: 'c2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Found it' }] }),
    ].join('\n') + '\n');
    await fs.writeFile(path.join(project, sibling, 'subagents', 'agent-foreign.jsonl'),
      row({ id: 'f1', type: 'message', role: 'user', content: 'Foreign' }) + '\n');
    const events = [];
    const bridge = createCodeBuddySubagentBridge({ cwd, parentId: parent, environment: { HOME: home },
      emit: event => events.push(event) });
    await bridge.scan();
    assert.equal(events.length, 1);
    assert.equal(events[0].nativeSessionId, `${parent}:codebuddy:${child}`);
    assert.equal(events[0].status, 'running');
    assert.deepEqual(events[0].messages.map(item => item.info.role), ['user', 'assistant']);
    await fs.appendFile(parentFile, row({ id: 'p2', type: 'function_call_result', sessionId: parent, cwd,
      subAgent: { descriptor: { sessionId: child, parentSessionId: parent, status: 'completed' } } }) + '\n');
    await bridge.scan();
    assert.equal(events.length, 2);
    assert.equal(events[1].status, 'success');
    bridge.close();
    console.log('codebuddy-subagent: documented child path, parent isolation, transcript and lifecycle passed');
  } finally {
    const target = path.resolve(home);
    if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
