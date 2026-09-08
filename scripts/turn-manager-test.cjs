// PR 2 验收：TurnManager 生命周期测试（无 Electron）。
const assert = require('node:assert');
const { TurnManager } = require('../src/main/protocol-core/turn-manager');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok', name); }
  catch (error) { console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

test('turn lifecycle: created → running → completed', () => {
  const tm = new TurnManager();
  const turn = tm.create({ threadId: 'thread_1' });
  assert.strictEqual(turn.status, 'created');
  tm.start(turn.id);
  assert.strictEqual(turn.status, 'running');
  assert.strictEqual(typeof turn.startedAt, 'number');
  tm.complete(turn.id);
  assert.strictEqual(turn.status, 'completed');
  assert.strictEqual(typeof turn.completedAt, 'number');
});

test('illegal transition: completed → running rejected', () => {
  const tm = new TurnManager();
  const turn = tm.create({ threadId: 'thread_1' });
  tm.start(turn.id);
  tm.complete(turn.id);
  assert.throws(() => tm.start(turn.id), /illegal turn transition/);
  assert.strictEqual(turn.status, 'completed');
});

test('illegal transition: cancelled → completed rejected; error terminal', () => {
  const tm = new TurnManager();
  const a = tm.create({ threadId: 'thread_1' });
  tm.start(a.id);
  tm.cancel(a.id);
  assert.throws(() => tm.complete(a.id), /illegal turn transition/);
  const b = tm.create({ threadId: 'thread_1' });
  tm.start(b.id);
  tm.fail(b.id, 'boom');
  assert.strictEqual(b.status, 'error');
  assert.strictEqual(b.error, 'boom');
  assert.throws(() => tm.start(b.id), /illegal turn transition/);
});

test('waiting_interaction: wait → resume → complete（approval/question 等待路径）', () => {
  const tm = new TurnManager();
  const turn = tm.create({ threadId: 'thread_1' });
  tm.start(turn.id);
  tm.wait(turn.id);
  assert.strictEqual(turn.status, 'waiting_interaction');
  tm.resume(turn.id);
  assert.strictEqual(turn.status, 'running');
  tm.complete(turn.id);
  assert.strictEqual(turn.status, 'completed');
});

test('waiting → cancel allowed（审批等待中用户取消）', () => {
  const tm = new TurnManager();
  const turn = tm.create({ threadId: 'thread_1' });
  tm.start(turn.id);
  tm.wait(turn.id);
  tm.cancel(turn.id);
  assert.strictEqual(turn.status, 'cancelled');
  assert.strictEqual(typeof turn.completedAt, 'number');
});

test('created → completed 直接跳转被拒绝（必须经过 start）', () => {
  const tm = new TurnManager();
  const turn = tm.create({ threadId: 'thread_1' });
  assert.throws(() => tm.complete(turn.id), /illegal turn transition/);
});

test('idempotent settle: 重复 complete 不报错', () => {
  const tm = new TurnManager();
  const turn = tm.create({ threadId: 'thread_1' });
  tm.start(turn.id);
  tm.complete(turn.id);
  tm.complete(turn.id);
  assert.strictEqual(turn.status, 'completed');
});

test('turnsForThread + unknown turn throws', () => {
  const tm = new TurnManager();
  const a = tm.create({ threadId: 't1' });
  tm.create({ threadId: 't2' });
  assert.deepStrictEqual(tm.turnsForThread('t1').map((t) => t.id), [a.id]);
  assert.throws(() => tm.start('turn_missing'), /does not exist/);
});

console.log(`turn-manager: ${passed} passed`);
