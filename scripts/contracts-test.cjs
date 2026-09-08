// PR 1 验收：Shared Contracts schema 测试（无 Electron）。
const assert = require('node:assert');
const contracts = require('../src/main/shared-contracts');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok', name); }
  catch (error) { console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

/* ---------- Thread ---------- */
test('thread: create + validate', () => {
  const thread = contracts.createThread({ workspaceId: '/repo', harnessId: 'harness-x', nativeSessionRef: { sessionId: 's1' } });
  assert.deepStrictEqual(contracts.validateThread(thread), []);
  assert.strictEqual(thread.status, 'idle');
  assert.strictEqual(thread.activeTurnId, null);
  assert.deepStrictEqual(thread.nativeSessionRef, { sessionId: 's1' });
});

test('thread: rejects bad status', () => {
  const thread = contracts.createThread({ workspaceId: '/repo' });
  thread.status = 'bogus';
  assert.ok(contracts.validateThread(thread).some((e) => e.includes('status')));
});

/* ---------- Turn ---------- */
test('turn: create + validate', () => {
  const turn = contracts.createTurn({ threadId: 'thread_1', nativeTurnRef: { turnId: 'nt-1' } });
  assert.deepStrictEqual(contracts.validateTurn(turn), []);
  assert.strictEqual(turn.status, 'created');
  assert.deepStrictEqual(turn.itemIds, []);
});

test('turn: transition table rejects terminal → running', () => {
  assert.strictEqual(contracts.canTransition('running', 'completed'), true);
  assert.strictEqual(contracts.canTransition('completed', 'running'), false);
  assert.strictEqual(contracts.canTransition('cancelled', 'running'), false);
  assert.strictEqual(contracts.canTransition('waiting_interaction', 'running'), true);
  assert.strictEqual(contracts.canTransition('created', 'completed'), false);
});

/* ---------- Item ---------- */
test('item: create + validate (all phase-1 types)', () => {
  for (const type of contracts.ITEM_TYPES) {
    const item = contracts.createItem({ threadId: 'thread_1', turnId: 'turn_1', type });
    assert.deepStrictEqual(contracts.validateItem(item), [], `type ${type}`);
  }
});

test('item: rejects unknown type', () => {
  const item = contracts.createItem({ threadId: 'thread_1', type: 'nope' });
  assert.ok(contracts.validateItem(item).some((e) => e.includes('type')));
});

/* ---------- CoreEvent ---------- */
test('event: create fills eventId/timestamp/payload', () => {
  const event = contracts.createCoreEvent({ threadId: 'thread_1', type: 'turn.started' });
  assert.deepStrictEqual(contracts.validateCoreEvent(event), []);
  assert.ok(event.eventId.startsWith('evt_'));
  assert.strictEqual(typeof event.timestamp, 'number');
  assert.deepStrictEqual(event.payload, {});
});

test('event: rejects unknown type / missing threadId', () => {
  assert.ok(contracts.validateCoreEvent(contracts.createCoreEvent({ threadId: 't', type: 'bogus' })).length > 0);
  assert.ok(contracts.validateCoreEvent(contracts.createCoreEvent({ type: 'turn.started' })).some((e) => e.includes('threadId')));
});

/* ---------- NativeRef ---------- */
test('nativeRef: all fields optional, unknown keys rejected', () => {
  assert.deepStrictEqual(contracts.validateNativeRef(undefined), []);
  assert.deepStrictEqual(contracts.validateNativeRef({}), []);
  assert.deepStrictEqual(contracts.validateNativeRef({ sessionId: 's', toolCallId: 'tc' }), []);
  assert.ok(contracts.validateNativeRef({ whatever: 'x' }).some((e) => e.includes('whatever')));
});

/* ---------- Capability ---------- */
test('capability: defaults all false, overrides applied', () => {
  const caps = contracts.createCapabilities({ session: { fork: true }, usage: { tokens: true } });
  assert.deepStrictEqual(contracts.validateCapabilities(caps), []);
  assert.strictEqual(caps.session.fork, true);
  assert.strictEqual(caps.session.resume, false);
  assert.strictEqual(caps.usage.tokens, true);
  assert.strictEqual(caps.conversation.streaming, false);
  // 全组全覆盖
  for (const group of Object.keys(contracts.CAPABILITY_GROUPS)) assert.ok(caps[group]);
});

test('capability: rejects unknown group/key', () => {
  assert.ok(contracts.validateCapabilities({ nope: {} }).length > 0);
  assert.ok(contracts.validateCapabilities({ session: { teleport: true } }).length > 0);
});

/* ---------- Interaction ---------- */
test('interaction: create + validate', () => {
  const interaction = contracts.createInteraction({
    threadId: 'thread_1', turnId: 'turn_1', type: 'approval',
    title: '确认', options: [{ id: 'yes' }, 'no'], nativeRef: { interactionId: 'req-1' },
  });
  assert.deepStrictEqual(contracts.validateInteraction(interaction), []);
  assert.strictEqual(interaction.status, 'pending');
  assert.deepStrictEqual(interaction.options, [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }]);
});

console.log(`contracts: ${passed} passed`);
