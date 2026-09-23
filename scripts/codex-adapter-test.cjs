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

  // listCommands：无会话返回静态目录；skills/list → 插入型命令（slug 化、与 compact 去重、
  // enabled!==false 过滤、id 满足 UI 契约字符集）；旧版 app-server 无该 RPC 时回落静态目录
  const staticList = await adapter.listCommands(null);
  assert.deepEqual(staticList, [{ id: 'compact', label: '压缩上下文', description: '由 Codex 原生 app-server 压缩当前 Thread', action: 'execute' }]);

  const skillsSession = fakeSession();
  skillsSession.cwd = 'E:\\harness-mix';
  const skillsRequests = [];
  skillsSession.host = { async request(method, params) {
    skillsRequests.push({ method, params });
    return { data: [{ skills: [
      { name: 'Agent Browser', description: 'Drive a real browser end to end.', shortDescription: '浏览器自动化', enabled: true, scope: 'user', interface: { displayName: 'Agent Browser', defaultPrompt: 'Browse' } },
      { name: 'commit', description: 'Create a git commit', enabled: true, scope: 'repo' },
      { name: 'Compact', description: 'should dedupe against compact', enabled: true, scope: 'user' },
      { name: 'turned-off', description: 'disabled by config', enabled: false, scope: 'user' },
      { name: '重复技能', description: 'slug 与重复技能相同', enabled: true, scope: 'system' },
    ] }], nextCursor: null };
  } };
  const listed = await adapter.listCommands(skillsSession);
  assert.deepEqual(skillsRequests, [{ method: 'skills/list', params: { cwds: ['E:\\harness-mix'] } }]);
  assert.equal(listed[0].id, 'compact');
  assert.equal(listed[0].action, 'execute', 'compact execute 条目保持首位');
  const browser = listed.find(c => c.id === 'agent-browser');
  assert.ok(browser, '"Agent Browser" slug 化为 agent-browser');
  assert.equal(browser.label, '/Agent Browser', 'label 优先 interface.displayName');
  assert.equal(browser.text, '/agent-browser ', '插入文本用 slug 触发原生技能');
  assert.equal(browser.action, 'insert');
  assert.ok(browser.description.includes('浏览器自动化') && browser.description.includes('Codex 技能·user'), '描述含短述与来源标注');
  const commit = listed.find(c => c.id === 'commit');
  assert.ok(commit.description.includes('Codex 技能·repo'), 'scope 标注随条目');
  assert.ok(!commit.description.includes('displayName'), '无 shortDescription 时回落 description');
  assert.equal(listed.filter(c => c.id === 'compact').length, 1, 'slug 化的 Compact 与静态 compact 去重');
  assert.deepEqual(listed.map(c => c.id), ['compact', 'agent-browser', 'commit'], 'enabled:false 过滤；非 ASCII name slug 化为空即跳过');
  assert.ok(listed.every(c => /^[A-Za-z0-9._:-]+$/.test(c.id)), 'id 满足 UI 契约字符集');

  const legacySession = fakeSession();
  legacySession.cwd = 'E:\\harness-mix';
  legacySession.host = { async request(method) { throw new Error(`unknown method ${method}`); } };
  assert.deepEqual(await adapter.listCommands(legacySession), staticList, '旧版 app-server 缺 skills/list 时回落静态目录');

  assert.equal(usageView({ last: { totalTokens: 50 }, total: {}, modelContextWindow: 200 }).contextPercent, 25);
  assert.deepEqual(modelView({ model: 'gpt-x', displayName: 'GPT X', supportedReasoningEfforts: [], isDefault: true }).id, 'gpt-x');

  // Codex 26.917 的 permissionProfile id 带 ':' 前缀（':read-only' 等），必须映射为
  // UI 契约的 [A-Za-z0-9._~-] 安全 id，且发往原生前无损还原。
  const { permissionModeTransportId, permissionModeNativeId } = require('../src/main/adapters/codex');
  const SAFE_ID = /^[A-Za-z0-9._~-]+$/;
  for (const nativeId of [':read-only', ':workspace', ':danger-full-access']) {
    const transportId = permissionModeTransportId(nativeId);
    assert.ok(SAFE_ID.test(transportId), `${nativeId} 映射后的 id 必须满足 UI 契约字符集`);
    assert.notEqual(transportId, nativeId);
    assert.equal(permissionModeNativeId(transportId), nativeId, '往返解码必须无损');
  }
  assert.equal(permissionModeTransportId('read-only'), 'read-only', '旧版安全 id 原样透传');
  assert.equal(permissionModeNativeId('read-only'), 'read-only');
  const markerNative = 'b64u-collision';
  assert.notEqual(permissionModeTransportId(markerNative), markerNative, '以编码前缀开头的原生 id 也要编码，解码才无歧义');
  assert.equal(permissionModeNativeId(permissionModeTransportId(markerNative)), markerNative);
  // 与保留名 'default' 同名的原生档案必须编码，避免与内置默认档位冲突（PR #5 用例）
  const reservedTransport = permissionModeTransportId('default');
  assert.notEqual(reservedTransport, 'default', "原生 'default' 档案不得与保留默认档位同名");
  assert.equal(permissionModeNativeId(reservedTransport), 'default');
  // 病态超长 id：base64url 编码仍超 128 上限时退化为 sha256 摘要 id，且可回查（PR #5 用例）
  const longNative = 'x'.repeat(129);
  const longTransport = permissionModeTransportId(longNative);
  assert.ok(SAFE_ID.test(longTransport) && longTransport.length <= 128, '超长档案 id 的传输形态必须满足契约上限');
  assert.equal(permissionModeNativeId(longTransport), longNative, '摘要 id 经进程内索引无损还原');

  const catalogSession = fakeSession();
  catalogSession.host = { async request(method) {
    if (method === 'model/list') return { data: [{ model: 'gpt-x', displayName: 'GPT X', supportedReasoningEfforts: [], isDefault: true }], nextCursor: null };
    if (method === 'permissionProfile/list') return { data: [
      { id: ':read-only', description: null, allowed: true },
      { id: ':danger-full-access', description: '全权访问', allowed: true },
      { id: ':blocked-profile', description: null, allowed: false },
    ], nextCursor: null };
    throw new Error(`unexpected ${method}`);
  } };
  const catalog = await adapter.describeFor(catalogSession);
  const modeIds = catalog.permissionModes.map((mode) => mode.id);
  assert.deepEqual(catalog.permissionModes[0], { id: 'default', label: '原生默认', description: '使用 Codex 当前配置的权限策略' });
  assert.ok(modeIds.every((id) => SAFE_ID.test(id)), '目录中的 permission mode id 全部满足 UI 契约');
  assert.ok(catalog.permissionModes.some((mode) => mode.label === 'Read only'), "':read-only' 映射为渲染层本地化表认识的显示名");
  assert.ok(catalog.permissionModes.some((mode) => mode.label === 'Full access (dangerous)'), "':danger-full-access' 映射为危险全权访问显示名");
  assert.ok(!catalog.permissionModes.some((mode) => mode.label === ':blocked-profile'), 'allowed:false 档案被过滤');

  const permissionSession = fakeSession();
  const permissionRequests = [];
  permissionSession.host = { async request(method, params) { permissionRequests.push({ method, params }); return {}; } };
  const encodedReadOnly = permissionModeTransportId(':read-only');
  await adapter.setPermissionMode(permissionSession, encodedReadOnly);
  assert.deepEqual(permissionRequests, [{ method: 'thread/settings/update', params: { threadId: 'thread-native', permissions: ':read-only' } }], '设置权限档位时解码回原生 id');
  await adapter.setPermissionMode(permissionSession, 'default');
  assert.deepEqual(permissionRequests.at(-1), { method: 'thread/settings/update', params: { threadId: 'thread-native', permissions: null } });

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

  // startTurnAfterNativeSettlement：busy 瞬时占用按指数退避重试；其他错误必须立刻可见
  {
    const { startTurnAfterNativeSettlement } = require('../src/main/adapters/codex');
    let busyCalls = 0;
    const busyHost = { request: async () => { if (++busyCalls <= 2) throw new Error('Agent is already processing.'); return { turn: { id: 'turn-ok' } }; } };
    assert.deepEqual(await startTurnAfterNativeSettlement(busyHost, { threadId: 't' }), { turn: { id: 'turn-ok' } });
    assert.equal(busyCalls, 3);
    let strictCalls = 0;
    const strictHost = { request: async () => { strictCalls++; throw new Error('model not found'); } };
    await assert.rejects(() => startTurnAfterNativeSettlement(strictHost, { threadId: 't' }), /model not found/);
    assert.equal(strictCalls, 1, '非 busy 错误不得重试');
  }

  // 握手超时：app-server 拉起后永不应答 initialize 时，acquire 必须限时终止并报错，
  // 而不是让 thread/start 永久 pending（Desktop 端表现为新对话一直"在执行"、无会话产生）。
  // Windows 夹具：cmd.exe 无 /c 时进入交互态等待 stdin，永不输出 JSON-RPC。
  if (process.platform === 'win32') {
    const { CodexAppServer } = require('../src/main/adapters/codex-app-server');
    const previousExecutable = process.env.HARNESS_MIX_CODEX_EXECUTABLE;
    const previousStock = process.env.HARNESSMIX_STOCK_CODEX_PATH;
    const previousTimeout = process.env.HARNESS_MIX_CODEX_HANDSHAKE_TIMEOUT_MS;
    process.env.HARNESS_MIX_CODEX_EXECUTABLE = process.env.ComSpec || 'cmd.exe';
    process.env.HARNESS_MIX_CODEX_HANDSHAKE_TIMEOUT_MS = '600';
    delete process.env.HARNESSMIX_STOCK_CODEX_PATH;
    try {
      const startedAt = Date.now();
      await assert.rejects(() => CodexAppServer.acquire(), /完成初始化握手/);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= 500 && elapsed < 5_000, `握手超时应接近配置窗口（实际 ${elapsed}ms）`);
    } finally {
      if (previousExecutable) process.env.HARNESS_MIX_CODEX_EXECUTABLE = previousExecutable; else delete process.env.HARNESS_MIX_CODEX_EXECUTABLE;
      if (previousStock) process.env.HARNESSMIX_STOCK_CODEX_PATH = previousStock; else delete process.env.HARNESSMIX_STOCK_CODEX_PATH;
      if (previousTimeout) process.env.HARNESS_MIX_CODEX_HANDSHAKE_TIMEOUT_MS = previousTimeout; else delete process.env.HARNESS_MIX_CODEX_HANDSHAKE_TIMEOUT_MS;
    }
  }

  console.log('codex adapter: native notifications, usage, multi-question, approvals, cancel shapes, busy retry and handshake timeout passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
