const assert = require('node:assert/strict');
const { projectNotification, queueRequest, usageView, modelView } = require('../src/main/adapters/codex');

function fakeSession() {
  return {
    nativeSessionId: 'thread-native',
    pendingApprovals: new Map(),
    state: {
      turn: null, compaction: null, nativeTurnId: null, usage: undefined,
      itemText: new Map(), reasoningItems: new Set(), toolOutput: new Map(),
    },
  };
}

(async () => {
  const session = fakeSession();
  const events = [];
  const emit = event => events.push(event);
  projectNotification({ method: 'turn/started', params: { threadId: 'thread-native', turn: { id: 'turn-1' } } }, session, emit);
  projectNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-native', turnId: 'turn-1', itemId: 'answer-1', delta: '你好' } }, session, emit);
  projectNotification({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-native', turnId: 'turn-1', itemId: 'reason-1', delta: '分析' } }, session, emit);
  projectNotification({ method: 'item/started', params: { threadId: 'thread-native', turnId: 'turn-1', item: { type: 'commandExecution', id: 'tool-1', command: 'git status', status: 'inProgress' } } }, session, emit);
  projectNotification({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-native', turnId: 'turn-1', itemId: 'tool-1', delta: 'clean' } }, session, emit);
  projectNotification({ method: 'item/completed', params: { threadId: 'thread-native', turnId: 'turn-1', item: { type: 'commandExecution', id: 'tool-1', command: 'git status', status: 'completed', aggregatedOutput: 'clean' } } }, session, emit);
  projectNotification({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-native', turnId: 'turn-1', tokenUsage: { last: { totalTokens: 250 }, total: { inputTokens: 200, outputTokens: 50, cachedInputTokens: 25 }, modelContextWindow: 1000 } } }, session, emit);
  projectNotification({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'turn-1', status: 'completed' } } }, session, emit);

  assert.ok(events.some(event => event.kind === 'text-delta' && event.text === '你好'));
  assert.ok(events.some(event => event.kind === 'thinking-delta' && event.text === '分析'));
  assert.ok(events.some(event => event.kind === 'tool' && event.toolCallId === 'tool-1' && event.state === 'done' && event.title === 'exec_command' && event.input === 'git status'));
  assert.ok(events.some(event => event.kind === 'usage' && event.usage.contextPercent === 25));
  assert.ok(events.some(event => event.kind === 'completed' && event.nativeRef.checkpointId === 'turn-1'));

  const questionSession = fakeSession();
  const questions = [];
  const answer = queueRequest({ id: 7, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-native', turnId: 'turn-1', itemId: 'question-1', isBlocking: true,
    questions: [
      { id: 'framework', header: '框架', question: '选择框架', options: [{ label: 'React' }, { label: 'Vue' }] },
      { id: 'name', header: '名称', question: '输入名称', options: null },
    ],
  } }, questionSession, event => questions.push(event));
  assert.equal(questions.length, 2);
  const adapter = require('../src/main/adapters/codex').create();
  await adapter.respond(questionSession, 'codex-7-framework', { optionId: 'React' });
  await adapter.respond(questionSession, 'codex-7-name', { value: 'Harness Mix' });
  assert.deepEqual(await answer, { answers: { framework: { answers: ['React'] }, name: { answers: ['Harness Mix'] } } });

  const approvalSession = fakeSession();
  const approval = queueRequest({ id: 8, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-native', turnId: 'turn-1', itemId: 'tool-2', command: 'npm test', availableDecisions: ['accept', 'decline'],
  } }, approvalSession, () => {});
  await adapter.respond(approvalSession, 'codex-8', { optionId: 'accept' });
  assert.deepEqual(await approval, { decision: 'accept' });
  const mcpSession = fakeSession();
  const mcpEvents = [];
  const mcpApproval = queueRequest({ id: 9, method: 'mcpServer/elicitation/request', params: {
    threadId: 'thread-native', serverName: 'harness-mix', mode: 'form', message: 'Allow tool?',
    requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
  } }, mcpSession, event => mcpEvents.push(event));
  assert.equal(mcpEvents[0].kind, 'approval');
  assert.equal(mcpSession.pendingApprovals.size, 1, 'MCP requests await a native user response');
  await adapter.respond(mcpSession, 'codex-9', { optionId: 'decline' });
  assert.deepEqual(await mcpApproval, { action: 'decline', content: null });

  const compactSession = fakeSession();
  const compactEvents = [];
  compactSession.host = { async request(method) {
    assert.equal(method, 'thread/compact/start');
    projectNotification({ method: 'turn/started', params: { threadId: 'thread-native', turn: { id: 'compact-turn' } } }, compactSession, event => compactEvents.push(event));
    projectNotification({ method: 'item/completed', params: { threadId: 'thread-native', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'compact-item' } } }, compactSession, event => compactEvents.push(event));
    projectNotification({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'compact-turn', status: 'completed' } } }, compactSession, event => compactEvents.push(event));
    return {};
  } };
  await adapter.executeCommand(compactSession, 'compact', { emit: event => compactEvents.push(event) });
  const compactDone = compactEvents.find(event => event.kind === 'completed');
  assert.equal(compactDone.nativeRef.checkpointId, 'compact-turn');
  assert.ok(compactEvents.some(event => event.kind === 'text-delta' && /Codex 压缩/.test(event.text)));

  assert.equal(usageView({ last: { totalTokens: 50 }, total: {}, modelContextWindow: 200 }).contextPercent, 25);
  assert.deepEqual(modelView({ model: 'gpt-x', displayName: 'GPT X', supportedReasoningEfforts: [], isDefault: true }).id, 'gpt-x');

  // 权限透传：Desktop 选择（回合级）优先，缺失时回退线程级设置，均转发到原生 turn/start
  const sendSession = fakeSession();
  sendSession.model = { id: 'gpt-x' };
  sendSession.turnPermissions = { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } };
  const sentRequests = [];
  sendSession.host = { async request(method, params) { sentRequests.push({ method, params }); return { turn: { id: `turn-${sentRequests.length}` } }; } };
  const first = adapter.send(sendSession, '第一轮', {}, { images: [], turnPermissions: { approvalPolicy: 'never', approvalsReviewer: 'guardian', sandboxPolicy: { type: 'dangerFullAccess' } } });
  const turnStart = sentRequests.find(r => r.method === 'turn/start');
  assert.equal(turnStart.params.approvalPolicy, 'never', '回合级权限覆盖优先转发');
  assert.equal(turnStart.params.approvalsReviewer, 'guardian_subagent', 'Desktop 的 guardian 归一化为原生枚举');
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'dangerFullAccess' });
  projectNotification({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'turn-1', status: 'completed' } } }, sendSession, () => {});
  await first;
  sentRequests.length = 0;
  const second = adapter.send(sendSession, '第二轮', {}, { images: [] });
  const fallbackStart = sentRequests.find(r => r.method === 'turn/start');
  assert.equal(fallbackStart.params.approvalPolicy, 'on-request', '无线索级覆盖时回退线程级设置');
  assert.deepEqual(fallbackStart.params.sandboxPolicy, { type: 'readOnly' });
  projectNotification({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'turn-1', status: 'completed' } } }, sendSession, () => {});
  await second;

  // Queue resume can race app-server's active-turn cleanup. Retry only that transient
  // without surfacing a failed Core turn or duplicating unrelated failures.
  const retrySession = fakeSession();
  let startAttempts = 0;
  retrySession.host = { async request(method) {
    assert.equal(method, 'turn/start');
    startAttempts++;
    if (startAttempts < 3) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    return { turn: { id: 'turn-after-settlement' } };
  } };
  const retried = adapter.send(retrySession, '编辑后的排队消息', {}, { images: [] });
  while (startAttempts < 3) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(retrySession.state.nativeTurnId, 'turn-after-settlement');
  projectNotification({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'turn-after-settlement', status: 'completed' } } }, retrySession, () => {});
  await retried;
  assert.equal(startAttempts, 3, 'Only the transient app-server busy race is retried');

  const fatalSession = fakeSession();
  let fatalAttempts = 0;
  fatalSession.host = { async request() { fatalAttempts++; throw new Error('Authentication required'); } };
  await assert.rejects(adapter.send(fatalSession, '不可重试的错误', {}, { images: [] }), /Authentication required/);
  assert.equal(fatalAttempts, 1, 'Unrelated app-server errors are never retried or hidden');

  // cancel() 必须能结算每种挂起的原生请求形状：requestUserInput 的条目经由 group
  // 结算（条目本身没有 resolve，直接调用会 TypeError 并吞掉后续 interrupt）。
  const cancelSession = fakeSession();
  const cancelledAnswer = queueRequest({ id: 21, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-native', turnId: 'turn-c', itemId: 'q-c', isBlocking: true,
    questions: [{ id: 'pick', header: '选择', question: '选择一项', options: [{ label: 'A' }, { label: 'B' }] }],
  } }, cancelSession, () => {});
  const cancelledApproval = queueRequest({ id: 22, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-native', turnId: 'turn-c', itemId: 't-c', command: 'npm test', availableDecisions: ['accept', 'decline'],
  } }, cancelSession, () => {});
  const cancelledElicitation = queueRequest({ id: 23, method: 'mcpServer/elicitation/request', params: {
    threadId: 'thread-native', serverName: 'harness-mix', mode: 'select', message: 'Allow?',
  } }, cancelSession, () => {});
  const cancelRequests = [];
  cancelSession.host = { request: (method) => { cancelRequests.push(method); return Promise.resolve({}); } };
  cancelSession.state.turn = { resolve() {}, reject() {} };
  await adapter.cancel(cancelSession);
  assert.equal(cancelSession.pendingApprovals.size, 0);
  assert.deepEqual(await cancelledAnswer, { answers: {} }, 'group 条目以空答案结算');
  assert.deepEqual(await cancelledApproval, { decision: 'decline' });
  assert.deepEqual(await cancelledElicitation, { action: 'cancel', content: null });
  assert.equal(cancelRequests.length, 0, 'turn/start 尚在途（无 nativeTurnId）时不发 interrupt');
  assert.equal(cancelSession.state.turn, null, '本地回合被释放，线程不会卡在「当前回合尚未结束」');

  // nativeTurnId 已知时：interrupt 发出后释放本地回合。
  const interruptSession = fakeSession();
  const interrupts = [];
  interruptSession.host = { request: (method) => { interrupts.push(method); return Promise.resolve({}); } };
  interruptSession.state.nativeTurnId = 'turn-live';
  interruptSession.state.turn = { resolve() {}, reject() {} };
  await adapter.cancel(interruptSession);
  assert.deepEqual(interrupts, ['turn/interrupt']);
  assert.equal(interruptSession.state.turn, null);

  console.log('codex adapter: native notifications, usage, multi-question, approvals and cancel shapes passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
