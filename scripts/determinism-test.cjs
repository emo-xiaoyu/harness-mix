const assert = require('node:assert/strict');
const { ProtocolCore } = require('../src/main/protocol-core');

// A captured CoreEvent stream must replay without pre-created objects or a clock.
const events = [
  { type: 'thread.created', payload: { workspaceId: '/fixture' } },
  { type: 'turn.started', turnId: 'native-turn' },
  { type: 'item.started', turnId: 'native-turn', itemId: 'answer', payload: { type: 'agent_message' } },
  { type: 'item.delta', turnId: 'native-turn', itemId: 'answer', payload: { text: 'hello' } },
  { type: 'usage.updated', turnId: 'native-turn', payload: { inputTokens: 12 } },
  { type: 'usage.updated', turnId: 'native-turn', payload: { outputTokens: 3 } },
  { type: 'turn.waiting', turnId: 'native-turn' },
  { type: 'turn.completed', turnId: 'native-turn' },
].map((e, index) => ({ ...e, threadId: 'thread', eventId: `e${index}`, timestamp: 1000 + index, sequence: index + 1 }));
function replay(clock) {
  const original = Date.now;
  Date.now = () => clock;
  try {
    const core = new ProtocolCore();
    for (const event of events) core.dispatch(structuredClone(event));
    return structuredClone(core.snapshot());
  } finally { Date.now = original; }
}
const first = replay(9000);
assert.deepEqual(first, replay(999999));
assert.equal(first.turns[0].id, 'native-turn');
assert.equal(first.turns[0].startedAt, 1001);
assert.equal(first.turns[0].completedAt, 1007);
assert.equal(first.items[0].content, 'hello');
assert.deepEqual(first.turns[0].itemIds, ['answer', 'usage_native-turn']);
const core = new ProtocolCore();
for (const event of events) core.dispatch(structuredClone(event));
const settled = structuredClone(core.snapshot());
core.dispatch({ threadId: 'thread', turnId: 'native-turn', itemId: 'answer', type: 'item.updated', payload: { content: 'late rewrite' } });
assert.deepEqual(core.snapshot().items, settled.items, 'terminal items cannot be rewritten');
console.log('determinism: exact snapshots and native turn identity passed');
