const assert = require('node:assert/strict');
const { projectEvent } = require('../src/main/adapters/opencode');

(async () => {
  const events = [];
  const session = {
    nativeSessionId: 'ses_parent', emit: event => events.push(event),
    state: { active: true, nativeChildren: new Map(), childSync: null },
    host: { async request(method, route) {
      assert.equal(method, 'GET');
      assert.equal(route, '/session/ses_child/message');
      return [
        { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '审查' }] },
        { info: { role: 'assistant', finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '通过' }] },
      ];
    } },
  };
  projectEvent(session, { type: 'session.created', properties: { sessionID: 'ses_child',
    info: { id: 'ses_child', parentID: 'ses_parent', title: '审查任务' } } }, session.emit);
  await new Promise(resolve => setImmediate(resolve));
  const child = events.filter(event => event.kind === 'native-subagent').at(-1);
  assert.equal(child?.nativeSessionId, 'ses_child');
  assert.equal(child?.status, 'success');
  assert.equal(child?.messages[1].parts[0].text, '通过');

  const before = events.length;
  projectEvent(session, { type: 'session.created', properties: { sessionID: 'ses_foreign',
    info: { id: 'ses_foreign', parentID: 'ses_other', title: '无关任务' } } }, session.emit);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, before, 'foreign child must not be projected');
  console.log('OpenCode native child session projection passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
