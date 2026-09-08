// PR 2 验收：Projector 测试 — Event → State（无 Electron）。
const assert = require('node:assert');
const { ProtocolCore } = require('../src/main/protocol-core');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok', name); }
  catch (error) { console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

function coreWithThread() {
  const core = new ProtocolCore();
  const thread = core.createThread({ id: 'thread_1', workspaceId: '/repo', harnessId: 'harness-x' });
  return { core, thread };
}

test('agent_message streaming: started → delta × N → completed（§7 示例）', () => {
  const { core } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.started', payload: { type: 'agent_message' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.delta', payload: { text: '你好' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.delta', payload: { text: '，世界' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.completed' });
  const item = core.getItem('item_m1');
  assert.strictEqual(item.content, '你好，世界');
  assert.strictEqual(item.status, 'completed');
  assert.deepStrictEqual(turn.itemIds, ['item_m1']);
});

test('reasoning streaming 独立于 agent_message', () => {
  const { core } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_r1', type: 'item.started', payload: { type: 'reasoning' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_r1', type: 'item.delta', payload: { text: '思考一下' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_a1', type: 'item.started', payload: { type: 'agent_message' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_a1', type: 'item.delta', payload: { text: '回答' } });
  assert.strictEqual(core.getItem('item_r1').content, '思考一下');
  assert.strictEqual(core.getItem('item_a1').content, '回答');
});

test('tool lifecycle: started(running) → updated → completed(done/error)', () => {
  const { core } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_t1', type: 'item.started', payload: { type: 'tool_call', title: 'bash', state: 'running' }, nativeRef: { toolCallId: 'tc1' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_t1', type: 'item.updated', payload: { detail: 'ls', output: 'partial' } });
  let tool = core.getItem('item_t1');
  assert.strictEqual(tool.status, 'started');
  assert.strictEqual(tool.state, 'running');
  assert.strictEqual(tool.output, 'partial');
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_t1', type: 'item.completed', payload: { state: 'done', output: 'final' } });
  tool = core.getItem('item_t1');
  assert.strictEqual(tool.status, 'completed');
  assert.strictEqual(tool.state, 'done');
  // error 工具
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_t2', type: 'item.started', payload: { type: 'tool_call', title: 'bash', state: 'running' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_t2', type: 'item.completed', payload: { state: 'error' } });
  assert.strictEqual(core.getItem('item_t2').status, 'error');
});

test('duplicate eventId → ignore（§9）', () => {
  const { core } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.started', payload: { type: 'agent_message' } });
  const dup = { eventId: 'evt_dup', threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.delta', payload: { text: 'X' } };
  const first = core.dispatch(dup);
  const second = core.dispatch({ ...dup });
  assert.strictEqual(first.accepted, true);
  assert.strictEqual(second.ignored, true);
  assert.strictEqual(core.getItem('item_m1').content, 'X'); // 只投影一次
});

test('out-of-order event：默认拒绝并记录警告，状态不被破坏', () => {
  const { core } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' }); // seq 1
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.started', payload: { type: 'agent_message' } });
  const late = core.dispatch({ sequence: 1, threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.delta', payload: { text: '晚到' } });
  assert.strictEqual(late.ignored, true);
  assert.ok(late.warnings.some((w) => w.includes('sequence regression')));
  assert.strictEqual(core.getItem('item_m1').content, '');
});

test('turn completed：thread 回 idle，open items 收尾，running 工具 → interrupted', () => {
  const { core, thread } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  assert.strictEqual(thread.status, 'running');
  assert.strictEqual(thread.activeTurnId, turn.id);
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.started', payload: { type: 'agent_message' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_m1', type: 'item.delta', payload: { text: '答案' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, itemId: 'item_t1', type: 'item.started', payload: { type: 'tool_call', title: 'read', state: 'running' } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.completed' });
  assert.strictEqual(thread.status, 'idle');
  assert.strictEqual(thread.activeTurnId, null);
  assert.strictEqual(turn.status, 'completed');
  assert.strictEqual(core.getItem('item_m1').status, 'completed');
  const tool = core.getItem('item_t1');
  assert.strictEqual(tool.state, 'interrupted');
  assert.strictEqual(tool.status, 'cancelled');
});

test('turn cancel / failure：stopReason=cancelled 与 turn.failed', () => {
  const { core, thread } = coreWithThread();
  const t1 = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: t1.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: t1.id, type: 'turn.completed', payload: { stopReason: 'cancelled' } });
  assert.strictEqual(t1.status, 'cancelled');
  const t2 = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: t2.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: t2.id, type: 'turn.failed', payload: { message: '网络错误' } });
  assert.strictEqual(t2.status, 'error');
  assert.strictEqual(t2.error, '网络错误');
  assert.strictEqual(thread.status, 'error');
});

test('usage.updated：upsert usage item + thread.usage 合并', () => {
  const { core, thread } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'usage.updated', payload: { inputTokens: 10 } });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'usage.updated', payload: { outputTokens: 5 } });
  const usages = core.getItemsForTurn(turn.id).filter((i) => i.type === 'usage');
  assert.strictEqual(usages.length, 1);
  assert.deepStrictEqual(usages[0].usage, { inputTokens: 10, outputTokens: 5 });
  assert.deepStrictEqual(thread.usage, { inputTokens: 10, outputTokens: 5 });
});

test('snapshot / reset', () => {
  const { core } = coreWithThread();
  const turn = core.createTurn({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  const snap = core.snapshot();
  assert.strictEqual(snap.threads.length, 1);
  assert.strictEqual(snap.turns.length, 1);
  core.reset();
  assert.strictEqual(core.snapshot().threads.length, 0);
  assert.strictEqual(core.getTurn(turn.id), null);
});

console.log(`projector: ${passed} passed`);
