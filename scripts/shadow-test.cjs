// PR 3 基础验收：Shadow Mode —— legacy 统一事件经 Normalizer → Core 投影，
// 并用 ShadowComparator 验证与 legacy transcript 语义一致（无 Electron、无真实 Harness）。
const assert = require('node:assert');
const { ProtocolCore } = require('../src/main/protocol-core');
const { ShadowMirror } = require('./support/shadow.cjs');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok', name); }
  catch (error) { console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

/** 模拟 Runtime legacy 侧的最终 thread 形态（#applyEvent 投影完成后的样子） */
function legacyThreadAfterTurn() {
  return {
    id: 'thread_1', harnessId: 'harness-x', cwd: '/repo',
    messages: [
      { id: 'm0', role: 'user', text: '帮我列目录', at: 1 },
      {
        id: 'm1', role: 'assistant', text: '我先看一下。目录里有 a.js', thinking: '需要先列目录',
        at: 2, endedAt: 3, stopReason: 'completed',
        items: [
          { id: 'i1', kind: 'thinking', text: '需要先列目录', at: 2, endedAt: 3 },
          { id: 'i2', kind: 'text', text: '我先看一下。', at: 2, endedAt: 3 },
          { id: 'i3', kind: 'tool', toolId: 'tc1', at: 2, endedAt: 3 },
          { id: 'i4', kind: 'text', text: '目录里有 a.js', at: 2, endedAt: 3 },
        ],
      },
    ],
    tools: [{ id: 'tc1', messageId: 'm1', title: 'bash', state: 'done', at: 2, endedAt: 3 }],
    usage: { inputTokens: 100, outputTokens: 20 },
    status: 'ready',
  };
}

/** 模拟一轮真实 legacy 事件流（与 Pi/Claude/DSH Adapter 输出同形状） */
function runShadowTurn(shadow, thread) {
  shadow.threadCreated(thread);
  shadow.turnStarted(thread, '帮我列目录');
  const emit = (event) => shadow.applyLegacyEvent(thread, event);
  emit({ kind: 'thinking-delta', text: '需要先' });
  emit({ kind: 'thinking-delta', text: '列目录' });
  emit({ kind: 'text-delta', text: '我先看一下。' });
  emit({ kind: 'tool', toolCallId: 'tc1', title: 'bash', state: 'running', detail: 'ls', input: 'ls' });
  emit({ kind: 'tool', toolCallId: 'tc1', title: 'bash', state: 'done', detail: 'a.js', output: 'a.js' });
  emit({ kind: 'text-delta', text: '目录里有 a.js' });
  emit({ kind: 'usage', usage: { inputTokens: 100, outputTokens: 20 } });
  emit({ kind: 'completed', finalAnswer: true });
}

test('shadow：一轮完整 turn 投影出 §64 要求的 Core Snapshot', () => {
  const core = new ProtocolCore();
  const shadow = new ShadowMirror({ core });
  const thread = legacyThreadAfterTurn();
  runShadowTurn(shadow, thread);

  const snap = shadow.snapshot();
  assert.strictEqual(snap.threads.length, 1);
  assert.strictEqual(snap.turns.length, 1);

  const turn = snap.turns[0];
  assert.strictEqual(turn.status, 'completed');
  assert.strictEqual(typeof turn.startedAt, 'number');
  assert.strictEqual(typeof turn.completedAt, 'number');

  const items = core.getItemsForTurn(turn.id);
  const byType = (type) => items.filter((i) => i.type === type);
  // UserMessage / Reasoning / ToolCall / AgentMessage / Usage 全部齐备
  assert.strictEqual(byType('user_message').length, 1);
  assert.strictEqual(byType('user_message')[0].content, '帮我列目录');
  assert.strictEqual(byType('user_message')[0].status, 'completed');
  assert.strictEqual(byType('reasoning').map((i) => i.content).join(''), '需要先列目录');
  const tools = byType('tool_call');
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].state, 'done');
  assert.strictEqual(tools[0].status, 'completed');
  assert.deepStrictEqual(tools[0].nativeRef, { toolCallId: 'tc1' });
  assert.strictEqual(byType('agent_message').map((i) => i.content).join(''), '我先看一下。目录里有 a.js');
  assert.strictEqual(byType('usage').length, 1);
  assert.deepStrictEqual(byType('usage')[0].usage, { inputTokens: 100, outputTokens: 20 });
});

test('shadow comparator：与 legacy transcript 语义一致 → 零 mismatch', () => {
  const core = new ProtocolCore();
  const shadow = new ShadowMirror({ core });
  const thread = legacyThreadAfterTurn();
  runShadowTurn(shadow, thread);
  assert.deepStrictEqual(shadow.report().mismatches, []);
  assert.deepStrictEqual(shadow.report().errors, []);
});

test('shadow comparator：legacy 与 core 不一致时记录差异，不影响投影', () => {
  const core = new ProtocolCore();
  const shadow = new ShadowMirror({ core });
  const thread = legacyThreadAfterTurn();
  runShadowTurn(shadow, thread);
  // legacy 侧文本被改动（模拟不一致），再触发一次 completed 比较
  thread.messages.push({ id: 'm2', role: 'assistant', text: '被改过的答案', at: 4, endedAt: 5, stopReason: 'completed' });
  shadow.turnStarted(thread, '再来一次');
  shadow.applyLegacyEvent(thread, { kind: 'text-delta', text: '不一样的答案' });
  shadow.applyLegacyEvent(thread, { kind: 'completed', finalAnswer: true });
  const { mismatches } = shadow.report();
  assert.strictEqual(mismatches.length, 1);
  assert.ok(mismatches[0].mismatches.some((m) => m.includes('final answer')));
});

test('shadow：cancel 与 error 路径', () => {
  const core = new ProtocolCore();
  const shadow = new ShadowMirror({ core });
  const base = legacyThreadAfterTurn();
  // cancel
  const t1 = { ...base, id: 'thread_c', messages: [base.messages[0], { ...base.messages[1], text: '', thinking: undefined, stopReason: 'cancelled' }], tools: [{ ...base.tools[0], state: 'interrupted' }], usage: {} };
  shadow.threadCreated(t1);
  shadow.turnStarted(t1, '帮我列目录');
  shadow.applyLegacyEvent(t1, { kind: 'tool', toolCallId: 'tc1', title: 'bash', state: 'running' });
  shadow.applyLegacyEvent(t1, { kind: 'completed', stopReason: 'cancelled' });
  const cancelledTurn = core.turns.turnsForThread('thread_c')[0];
  assert.strictEqual(cancelledTurn.status, 'cancelled');
  // error
  const t2 = { ...base, id: 'thread_e', error: '原生进程崩溃', messages: [base.messages[0], { ...base.messages[1], text: '', thinking: undefined, stopReason: 'error' }], tools: [], usage: {} };
  shadow.threadCreated(t2);
  shadow.turnStarted(t2, '帮我列目录');
  shadow.applyLegacyEvent(t2, { kind: 'error', message: '原生进程崩溃' });
  const failedTurn = core.turns.turnsForThread('thread_e')[0];
  assert.strictEqual(failedTurn.status, 'error');
  assert.strictEqual(failedTurn.error, '原生进程崩溃');
  assert.strictEqual(core.getThread('thread_e').status, 'error');
});

test('shadow：approval → question/approval item 带 interactionId，turn 结算时收尾', () => {
  const core = new ProtocolCore();
  const shadow = new ShadowMirror({ core });
  const thread = { ...legacyThreadAfterTurn(), id: 'thread_a', pendingApprovals: [] };
  shadow.threadCreated(thread);
  shadow.turnStarted(thread, '改文件');
  shadow.applyLegacyEvent(thread, { kind: 'approval', requestId: 'req-1', method: 'confirm', title: '允许写入？' });
  shadow.applyLegacyEvent(thread, { kind: 'text-delta', text: '完成' });
  shadow.applyLegacyEvent(thread, { kind: 'completed', finalAnswer: true });
  const turn = core.turns.turnsForThread('thread_a')[0];
  const approvals = core.getItemsForTurn(turn.id).filter((i) => i.type === 'approval');
  assert.strictEqual(approvals.length, 1);
  assert.deepStrictEqual(approvals[0].nativeRef, { interactionId: 'req-1' });
  assert.strictEqual(approvals[0].status, 'completed');
});

test('shadow：自身异常被吞掉并记录（绝不影响 legacy）', () => {
  const core = new ProtocolCore();
  const shadow = new ShadowMirror({ core });
  shadow.threadCreated(null); // 触发内部异常
  assert.strictEqual(shadow.report().errors.length, 1);
  assert.strictEqual(shadow.report().errors[0].phase, 'threadCreated');
});

console.log(`shadow: ${passed} passed`);
