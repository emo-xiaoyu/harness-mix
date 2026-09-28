const assert = require('node:assert/strict');
const { spawnSession, nativeSubagentMessages } = require('../src/main/adapters/claude');

(async () => {
  let options;
  const events = [];
  const sdk = {
    query(args) { options = args.options; return { async *[Symbol.asyncIterator]() {} }; },
    async getSubagentMessages(parent, agent, readOptions) {
      assert.equal(parent, 'parent-1');
      assert.equal(agent, 'agent-1');
      assert.equal(readOptions.dir, process.cwd());
      return [
        { type: 'user', message: { content: [{ type: 'text', text: '检查实现' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '已检查' }] } },
      ];
    },
  };
  const session = spawnSession(sdk, { cwd: process.cwd(), emit: event => events.push(event) });
  await options.hooks.SubagentStart[0].hooks[0]({ session_id: 'parent-1', agent_id: 'agent-1', agent_type: 'reviewer' });
  await options.hooks.SubagentStop[0].hooks[0]({ session_id: 'parent-1', agent_id: 'agent-1', agent_type: 'reviewer' });
  await new Promise(resolve => setImmediate(resolve));
  clearInterval(session.childPoll);
  const child = events.filter(event => event.kind === 'native-subagent').at(-1);
  assert.equal(child.nativeSessionId, 'parent-1:agent:agent-1');
  assert.equal(child.status, 'success');
  assert.equal(child.messages[1].parts[0].text, '已检查');
  assert.equal(nativeSubagentMessages([]).length, 0);
  console.log('Claude native subagent transcript projection passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
