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
  console.log('codex adapter: native notifications, usage, multi-question and approvals passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
