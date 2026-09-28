const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { projectWireEvent, flattenCatalog } = require('../src/main/adapters/dsh');
const { createDshSubagentBridge, messagesFromEvents, childStatus } = require('../src/main/adapters/dsh-subagents');

// DSH Web Remote 投影单元测试：session/follow 帧 + $events waterfall + 模型目录。
// 帧形状以 fixtures/dsh/*.jsonl（真实捕获）为准。

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'dsh', name), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
}

// 1. 真实 fixture：tool-call 全链路投影
const toolEvents = fixture('tool-call.jsonl').flatMap((frame) => projectWireEvent(frame).filter(Boolean));
assert.ok(toolEvents.some((e) => e.kind === 'tool' && e.state === 'running'), 'tool/call → running');
assert.ok(toolEvents.some((e) => e.kind === 'tool' && e.state === 'done' && /harness-mix-fixture/.test(e.output ?? '')), 'tool/result → done + 输出');
assert.ok(toolEvents.some((e) => e.kind === 'completed' && e.finalAnswer === true), 'turn/end → completed');
assert.ok(toolEvents.some((e) => e.kind === 'usage'), 'usage 事件');

// 2. text-delta 流式增量（真实 fixture 的 chunk 序列）
const deltas = fixture('simple-message.jsonl').flatMap((frame) => projectWireEvent(frame)).filter((e) => e.kind === 'text-delta');
assert.ok(deltas.length >= 1 && deltas.map((d) => d.text).join('').includes('收到'), 'assistant/chunk text-delta 流式投影');

// 3. assistant/message 只记检查点不重复投影文本（chunk 已覆盖）
const messageFrames = fixture('simple-message.jsonl').filter((f) => f.event?.type === 'assistant/message');
const session = { nativeSessionId: 'session-x', state: {} };
const fromMessage = messageFrames.flatMap((f) => projectWireEvent(f, session));
assert.ok(!fromMessage.some((e) => e.kind === 'text-delta'), 'assistant/message 不产生重复文本');
assert.equal(session.state.checkpointSeq, messageFrames.at(-1).event.seq, '检查点 seq 记录');
const fallbackSession = { nativeSessionId: 'session-fallback', state: { turn: { answer: '' } } };
const fallback = messageFrames.flatMap((f) => projectWireEvent(f, fallbackSession));
assert.equal(fallback.filter(e => e.kind === 'text-delta').map(e => e.text).join(''), '收到', '缺失 chunk 时从 committed assistant/message 补齐文本');
const end = fixture('simple-message.jsonl').filter((f) => f.event?.type === 'turn/end').flatMap((f) => projectWireEvent(f, session));
assert.equal(end.find((e) => e.kind === 'completed').nativeRef.checkpointId, String(session.state.checkpointSeq), 'completed 携带 fork 边界');

// 4. request/context 更新上下文窗口与模型
const ctx = projectWireEvent({ type: 'event', event: { type: 'request/context', seq: 9, time: 0, data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000000 } } }, session);
assert.equal(session.state.contextWindow, 1000000);
assert.ok(ctx.some((e) => e.kind === 'session' && e.model?.id === 'deepseek-v4-flash'), 'request/context → 模型更新');

// 5. usage chunk → contextPercent 计算
const withUsage = projectWireEvent({ type: 'event', event: { type: 'assistant/chunk', seq: 10, time: 0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50000, outputTokens: 100, totalTokens: 50100, cacheReadTokens: 0, reasoningTokens: 0 } } } } }, session);
const usage = withUsage.find((e) => e.kind === 'usage').usage;
assert.equal(usage.tokens, 50000);
assert.equal(usage.contextWindow, 1000000);
assert.ok(Math.abs(usage.contextPercent - 5) < 0.01, 'contextPercent 由原生窗口计算');

// 6. 审批 waterfall → approval 卡片；应答 → allowed-once / rejected / cancelled
(async () => {
const childEvents = [
  { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '检查项目' }] } },
  { type: 'tool/call', seq: 1, time: 2, data: { callId: 'tool-1', name: 'read', arguments: '{}' } },
  { type: 'tool/result', seq: 2, time: 3, data: { message: { content: [{ type: 'tool-result', toolCallId: 'tool-1', content: [{ type: 'text', text: '文件内容' }] }] } } },
  { type: 'assistant/message', seq: 3, time: 4, data: { message: { content: [{ type: 'text', text: '已检查' }] } } },
  { type: 'turn/end', seq: 4, time: 5, data: { reason: { kind: 'completed' } } },
];
assert.equal(messagesFromEvents(childEvents).length, 2);
assert.equal(messagesFromEvents(childEvents)[1].parts[0].state.status, 'completed');
assert.equal(childStatus({ activity: 'inactive' }, childEvents), 'success');
assert.equal(childStatus({ activity: 'running' }, childEvents), 'success', '驻留状态不等于任务进行中');
assert.equal(childStatus({ activity: 'running' }, [...childEvents, { type: 'turn/start', seq: 5 }]), 'running');
const projected = [];
const childHost = {
  async call(method, args) {
    if (method === 'subagents/list') {
      assert.equal(args.parentSessionId, 'parent-1');
      return { entries: [{ kind: 'diagnostic', id: 'bad' }, { kind: 'child', id: 'child-1', activity: 'inactive', mode: 'one-shot', label: '检查项目' }] };
    }
    if (method === 'session/page') {
      assert.deepEqual(args.request.address, { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' });
      return { records: childEvents.slice(0, 2).map(event => ({ type: 'event', event })), hasMore: false };
    }
    throw new Error(`unexpected ${method}`);
  },
  openStream(method, args, handlers) {
    assert.equal(method, 'session/follow');
    assert.deepEqual(args.request.address, { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' });
    queueMicrotask(() => handlers.onItem({ type: 'snapshot', cursor: 4, hasMore: true,
      records: childEvents.slice(2).map(event => ({ type: 'event', event })) }));
    return () => {};
  },
};
const bridge = createDshSubagentBridge(childHost, 'parent-1', event => projected.push(event));
await bridge.scan();
await bridge.scan();
bridge.close();
assert.equal(projected.length, 1, '同一原生子会话不重复投影');
assert.equal(projected[0].nativeSessionId, 'child-1');
assert.equal(projected[0].status, 'success');
assert.equal(projected[0].messages[1].parts.at(-1).text, '已检查');
const { manifest, create } = require('../src/main/adapters/dsh');
assert.equal(manifest.capabilities.approvals, true);
assert.equal(manifest.capabilities.fork, true);
assert.equal(manifest.capabilities.questions, true);
const adapter = create();
const answered = [];
const fakeSession = {
  nativeSessionId: 'session-1',
  pendingApprovals: new Map(),
  host: { answerWaterfall: async (eventId, outcome) => answered.push({ eventId, outcome }) },
};
fakeSession.pendingApprovals.set('dsh-evt-1', { eventId: 'evt-1', isQuestion: false });
await adapter.respond(fakeSession, 'dsh-evt-1', { optionId: 'allowed-once' });
assert.deepEqual(answered.at(-1), { eventId: 'evt-1', outcome: { kind: 'result', value: 'allowed-once' } }, '允许 → allowed-once');
fakeSession.pendingApprovals.set('dsh-evt-2', { eventId: 'evt-2', isQuestion: false });
await adapter.respond(fakeSession, 'dsh-evt-2', { cancelled: true });
assert.deepEqual(answered.at(-1), { eventId: 'evt-2', outcome: { kind: 'result', value: 'cancelled' } }, '取消 → cancelled');

// 7. 提问 waterfall（无选项 → 自由文本 custom；有选项 → selected）
fakeSession.pendingApprovals.set('dsh-evt-3', { eventId: 'evt-3', isQuestion: true, question: { id: 'q1' } });
await adapter.respond(fakeSession, 'dsh-evt-3', { value: '自由回答' });
assert.deepEqual(answered.at(-1).outcome.value, { answers: [{ id: 'q1', selected: [], custom: '自由回答' }] }, '自由文本提问 → custom');
fakeSession.pendingApprovals.set('dsh-evt-4', { eventId: 'evt-4', isQuestion: true, question: { id: 'q2', options: [{ label: '红色' }] } });
await adapter.respond(fakeSession, 'dsh-evt-4', { optionId: '红色' });
assert.deepEqual(answered.at(-1).outcome.value, { answers: [{ id: 'q2', selected: ['红色'] }] }, '选项提问 → selected');

// 8. 模型目录展平（provider 分组 + reasoning efforts）
const models = flattenCatalog({
  default: { provider: 'p1', model: 'm1' },
  groups: [{ id: 'p1', name: 'P1', models: [
    { id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } },
    { id: 'm2', name: 'M2' },
  ] }],
});
assert.equal(models.length, 2);
assert.deepEqual(models[0], { id: 'm1', name: 'M1', provider: 'p1', description: undefined, efforts: [{ id: 'low', label: 'low', hint: undefined }, { id: 'high', label: 'high', hint: undefined }], defaultEffort: 'low' });
assert.equal(models[1].efforts, undefined);

// 6. session/title：provider 源（LLM 生成的语义标题）转发为 kind:'title'；
// fallback 源只是首条消息截取（与 Host 本地派生等价），不转发避免抖动
const titleFrame = (kind) => ({ type: 'event', event: { type: 'session/title', seq: 20, time: 0, data: { title: '运行shell命令并回显输出', messageSeqs: [7], source: { kind } } } });
const providerTitle = projectWireEvent(titleFrame('provider'), session);
assert.equal(providerTitle.length, 1, 'session/title provider 源 → 原生标题事件');
assert.equal(providerTitle[0].kind, 'title');
assert.equal(providerTitle[0].title, '运行shell命令并回显输出');
assert.deepEqual(projectWireEvent(titleFrame('fallback'), session), [], 'session/title fallback 源不转发');
// 真实 fixture 中存在 provider 与 fallback 两种来源（simple-message 为 fallback）
const fixtureTitles = fixture('simple-message.jsonl').filter((f) => f.event?.type === 'session/title');
assert.ok(fixtureTitles.length >= 1, 'fixture 捕获了 session/title 事件');

console.log('dsh-adapter: Web Remote 工具/diff 边界/用量/审批/提问/目录投影 passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
