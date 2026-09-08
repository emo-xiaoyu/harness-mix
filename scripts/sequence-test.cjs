// PR 2 验收：Sequence Validator 测试（无 Electron）。
const assert = require('node:assert');
const { SequenceValidator } = require('../src/main/protocol-core/sequence-validator');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok', name); }
  catch (error) { console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

test('正常递增 15 → 16 接受', () => {
  const v = new SequenceValidator();
  assert.strictEqual(v.check({ eventId: 'e1', threadId: 't', sequence: 15 }).action, 'accept');
  const r = v.check({ eventId: 'e2', threadId: 't', sequence: 16 });
  assert.strictEqual(r.action, 'accept');
  assert.deepStrictEqual(r.warnings, []);
});

test('重复 eventId → ignore', () => {
  const v = new SequenceValidator();
  v.check({ eventId: 'e1', threadId: 't', sequence: 1 });
  const r = v.check({ eventId: 'e1', threadId: 't', sequence: 2 });
  assert.strictEqual(r.action, 'ignore');
  assert.ok(r.warnings.some((w) => w.includes('duplicate')));
});

test('sequence 回退：非严格模式 warn 但接受，不破坏状态', () => {
  const v = new SequenceValidator();
  v.check({ eventId: 'e1', threadId: 't', sequence: 15 });
  const r = v.check({ eventId: 'e2', threadId: 't', sequence: 14 });
  assert.strictEqual(r.action, 'accept');
  assert.ok(r.warnings.some((w) => w.includes('regression')));
  // 回退后 lastSequence 不被拉低，后续 16 仍正常接受
  assert.strictEqual(v.check({ eventId: 'e3', threadId: 't', sequence: 16 }).action, 'accept');
});

test('strict 模式：回退直接 ignore', () => {
  const v = new SequenceValidator({ strict: true });
  v.check({ eventId: 'e1', threadId: 't', sequence: 15 });
  assert.strictEqual(v.check({ eventId: 'e2', threadId: 't', sequence: 14 }).action, 'ignore');
});

test('sequence 按 thread 隔离', () => {
  const v = new SequenceValidator();
  v.check({ eventId: 'a1', threadId: 'ta', sequence: 5 });
  const r = v.check({ eventId: 'b1', threadId: 'tb', sequence: 1 });
  assert.strictEqual(r.action, 'accept');
  assert.deepStrictEqual(r.warnings, []);
});

test('无 sequence 的事件仅做去重', () => {
  const v = new SequenceValidator();
  assert.strictEqual(v.check({ eventId: 'e1', threadId: 't' }).action, 'accept');
  assert.strictEqual(v.check({ eventId: 'e1', threadId: 't' }).action, 'ignore');
});

console.log(`sequence: ${passed} passed`);
