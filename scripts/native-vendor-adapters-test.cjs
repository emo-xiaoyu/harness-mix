const assert = require('node:assert/strict');
const oc = require('../src/main/adapters/opencode');
const grok = require('../src/main/adapters/grok');
const pi = require('../src/main/adapters/pi');
(async () => {
  const events = [], calls = [];
  const session = { nativeSessionId: 's', emit: e => events.push(e), state: { active: true, userMessages: new Set(), parts: new Map(), text: new Map(), permissions: new Map(), questions: new Map() } };
  const event = (type, properties) => oc.projectEvent(session, { type, properties: { sessionID: 's', ...properties } }, session.emit);
  event('message.updated', { info: { role: 'user', id: 'u' } });
  event('message.part.updated', { part: { id: 'up', messageID: 'u', type: 'text', text: 'do not echo' } });
  event('message.part.updated', { part: { id: 'p', messageID: 'a', type: 'text', text: 'A' } });
  event('message.part.delta', { partID: 'p', field: 'text', delta: 'B' });
  oc.projectPart(session, { id: 'p', messageID: 'a', type: 'text', text: 'AB' }, session.emit);
  assert.equal(events.filter(e => e.kind === 'text-delta').map(e => e.text).join(''), 'AB');
  event('question.asked', { id: 'q', questions: [{ question: 'Choose', options: [{ label: 'yes' }] }] });
  assert.equal(events.at(-1).kind, 'approval');
  let fail = true;
  session.host = { request: async (...args) => { if (fail) throw new Error('network'); calls.push(args); } };
  const adapter = oc.create();
  await assert.rejects(adapter.respond(session, 'q:0', { value: 'yes' }));
  assert.equal(session.state.questions.get('q').index, 0);
  fail = false;
  await adapter.respond(session, 'q:0', { value: 'yes' });
  assert.deepEqual(calls.at(-1)[2], { answers: [['yes']] });
  event('permission.asked', { id: 'perm', permission: 'shell', patterns: ['test'] });
  await assert.rejects(adapter.respond(session, 'perm', { value: 'invented' }));
  await adapter.respond(session, 'perm', { optionId: 'always' });
  assert.deepEqual(calls.at(-1)[2], { reply: 'always' });
  assert.deepEqual(grok.projectUsage({ input_tokens: 12, outputTokens: 3, signature: 'private', costUsdTicks: 5 }), { inputTokens: 12, outputTokens: 3 });
  const piFailure = pi.project({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'native quota exhausted' }] });
  assert.equal(piFailure.kind, 'error'); assert.match(piFailure.message, /quota exhausted/);
  let answer;
  const gs = { pendingApprovals: new Map([['r', { options: [{ optionId: 'native-always', kind: 'allow_always' }], resolve: v => { answer = v; } }]]) };
  await assert.rejects(grok.create().respond(gs, 'r', { optionId: 'fake' }));
  await grok.create().respond(gs, 'r', { optionId: 'native-always' });
  assert.equal(grok.manifest.capabilities.attachments, true);
  const grokCalls = [];
  const grokSession = { nativeSessionId: 'grok-1', state: { agentCapabilities: {} }, process: { request: async (method, params) => { grokCalls.push({ method, params }); return { stopReason: 'end_turn', _meta: { promptId: 'p1' } }; } } };
  await grok.create().send(grokSession, 'hi', { emit: () => {} }, { images: [{ data: 'AA==', mime: 'image/png' }] });
  assert.equal(grokCalls[0].method, 'session/prompt');
  assert.deepEqual(grokCalls[0].params.prompt, [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }]);

  // Grok auto-compaction update parsing
  const updateStarted = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_started', tokens_used: 400000, context_window: 500000 });
  assert.deepEqual(updateStarted, { type: 'started', tokensUsed: 400000, contextWindowTokens: 500000 });
  const updateCompleted = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_completed', tokens_before: 400000, tokens_after: 12000, context_window: 500000 });
  assert.deepEqual(updateCompleted, { type: 'completed', outcome: 'succeeded', tokensBefore: 400000, tokensAfter: 12000, contextWindowTokens: 500000 });
  const updateFailed = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_failed', error_message: 'compaction error' });
  assert.deepEqual(updateFailed, { type: 'completed', outcome: 'failed', errorMessage: 'compaction error' });
  const updateCancelled = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_cancelled' });
  assert.deepEqual(updateCancelled, { type: 'completed', outcome: 'cancelled' });

  // Grok commands & manual compact
  const grokAdapterInst = grok.create();
  const grokCmds = await grokAdapterInst.listCommands(grokSession);
  assert.ok(grokCmds.some(c => c.id === 'compact' && c.action === 'execute'));

  // Test /compact interception in send()
  const grokCompactEmits = [];
  grokCalls.length = 0;
  grokSession.process.request = async (method, params) => {
    grokCalls.push({ method, params });
    return { outcome: 'succeeded', tokensBefore: 50000, tokensAfter: 5000 };
  };
  await grokAdapterInst.send(grokSession, '/compact keep recent tests', { emit: e => grokCompactEmits.push(e) });
  assert.equal(grokCalls[0].method, 'x.ai/compact_conversation');
  assert.deepEqual(grokCalls[0].params, { sessionId: 'grok-1', userContext: 'keep recent tests' });
  assert.ok(grokCompactEmits.some(e => e.kind === 'compaction' && e.state === 'completed' && e.outcome === 'succeeded'));
  assert.ok(grokCompactEmits.some(e => e.kind === 'usage' && e.usage.tokens === 5000));

  // Test EventNormalizer compaction mapping
  const { EventNormalizer } = require('../src/main/harness-adapter/event-normalizer');
  const normalizer = new EventNormalizer({ threadId: 't-comp' });
  normalizer.beginTurn('turn-c', 'test compact');
  const normEvents = normalizer.normalize({ kind: 'compaction', tokensBefore: 50000, tokensAfter: 5000 });
  assert.equal(normEvents.length, 2);
  assert.equal(normEvents[0].type, 'item.started');
  assert.equal(normEvents[0].payload.type, 'context_compaction');
  assert.equal(normEvents[0].payload.tokensBefore, 50000);
  assert.equal(normEvents[1].type, 'item.completed');

  // Test projectItem mapping
  const { projectItem } = require('../src/main/native/protocol');
  const projected = projectItem({ id: 'norm-item-1', type: 'context_compaction' });
  assert.deepEqual(projected, { id: 'norm-item-1', type: 'contextCompaction' });

  console.log('Native adapters: streaming deduplication, user suppression, question retry, exact native approvals, sanitized usage, grok images, grok compaction & UI projection PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
