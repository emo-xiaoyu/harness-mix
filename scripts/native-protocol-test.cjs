const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol, decodeRoute, routeModel } = require('../src/main/native/protocol');
const wait = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out'); };

async function main() {
  const root = path.resolve('output/native-protocol', String(Date.now()));
  await fs.mkdir(root, { recursive: true });
  const runtime = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await runtime.store.load();
  let emit;
  const emits = [];
  const answers = [];
  const permissionModeCalls = [];
  const adapter = { manifest: { id: 'pi', name: 'Pi', capabilities: { streaming: true, models: true, approvals: true, questions: true, resume: true, fork: true } },
    async open(input) { emits.push(input.emit); emit = input.emit; return {}; },
    async describe() { return { models: [{ id: 'demo', name: 'Demo', provider: 'test' }], thinkingLevels: [{ id: 'high', label: 'High', default: true }, { id: 'low', label: 'Low' }], permissionModes: [] }; },
    async send(session, text, hooks, extras) { sendExtras.push(extras); sentTexts.push(text); }, async cancel() {}, async close() {},
    async setPermissionMode(session, mode) { permissionModeCalls.push(mode); },
    async fork(source) { return { session: {}, nativeSessionId: `forked-${source.id}` }; },
    async respond(session, id, answer) { answers.push({ id, answer }); } };
  const sendExtras = [];
  const sentTexts = [];
  runtime.adapters.set('pi', adapter); runtime.status.pi = { available: true };
  const events = [];
  let observeQueueOrder = false;
  let queueResponseResolved = false;
  let queueNotificationBeforeResponse = false;
  const section = { id: 'test-pinned-section', name: 'Pinned', appearance: null };
  const officialRequests = [];
  const bridge = new NativeProtocol(runtime, event => {
    if (observeQueueOrder && event?.method === 'thread/queue/changed' && !queueResponseResolved) queueNotificationBeforeResponse = true;
    events.push(event);
  }, async (method, params) => {
    officialRequests.push({ method, params });
    if (method === 'threadSection/list') return { data: [section], nextCursor: null };
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'native@example.com', planType: 'plus' }, requiresOpenaiAuth: true };
    if (method === 'account/rateLimits/read') return {
      rateLimits: {
        primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1_800_604_800 },
      },
      rateLimitResetCredits: { availableCount: 0, credits: [] },
    };
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'native-login', verificationUrl: 'https://auth.example.com/device', userCode: 'ABCD-EFGH' };
    if (method === 'account/login/cancel') return { status: 'canceled' };
    if (method === 'account/logout') return {};
    if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
    throw new Error(`Unexpected official request: ${method}`);
  });
  try {
    const catalogModels = [{ id: 'shared', provider: 'a' }, { id: 'shared', provider: 'b' }, { id: 'unique', provider: 'a' }];
    runtime.catalogs.set('pi', { models: catalogModels, thinkingLevels: [{ id: 'high', label: 'High', default: true }, { id: 'low', label: 'Low' }] });
    const ref = model => ({ id: Buffer.from(JSON.stringify({ id: model.id, provider: model.provider })).toString('base64url') });
    assert.deepEqual(bridge.configuration({ harnessId: 'pi', model: { id: 'unique' } }).effectiveModel, ref(catalogModels[2]), 'Recover provider from an unambiguous old Pi record');
    assert.deepEqual(bridge.configuration({ harnessId: 'pi', model: { id: 'shared' }, options: { model: catalogModels[1] } }).effectiveModel, ref(catalogModels[1]), 'Preserve provider identity for duplicate model names');
    assert.deepEqual(bridge.configuration({ harnessId: 'pi', model: { id: 'shared' } }).effectiveModel, ref({ id: 'shared' }), 'Do not guess an ambiguous provider');
    // 思考档位：adapter 声明默认档后才下发可选集合，且生效档位必须属于其中
    const thinkingConf = bridge.configuration({ harnessId: 'pi', model: { id: 'unique' }, options: { thinking: 'low' } });
    assert.deepEqual(thinkingConf.availableThinkingOptions, [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }], 'Declared default thinking level unlocks the selectable set');
    assert.equal(thinkingConf.effectiveThinkingOptionId, 'low');
    assert.equal(bridge.configuration({ harnessId: 'pi', model: { id: 'unique' }, options: { thinking: 'obsolete' } }).effectiveThinkingOptionId, undefined, 'Stale thinking level outside the catalog is dropped');
    runtime.catalogs.set('claude', { models: [{ id: 'opus', name: 'Native resolved model' }], thinkingLevels: [{ id: 'high', label: 'high' }] });
    const claudeConf = bridge.configuration({ harnessId: 'claude', model: { id: 'opus' }, options: { thinking: 'high' } });
    assert.deepEqual(claudeConf.availableThinkingOptions, [{ id: 'high', label: 'high' }], 'Thinking options flow without a declared default');
    assert.equal(claudeConf.effectiveThinkingOptionId, 'high');
    // 模型声明了 efforts（含空数组）以模型为准：声明空集的模型不适用全局档位
    runtime.catalogs.set('claude', { models: [{ id: 'opus', name: 'Native resolved model', efforts: [] }], thinkingLevels: [{ id: 'high', label: 'high' }] });
    assert.equal(bridge.configuration({ harnessId: 'claude', model: { id: 'opus' }, options: { thinking: 'high' } }).availableThinkingOptions, undefined, 'Model with declared empty efforts exposes no thinking options');
    runtime.catalogs.set('claude', { models: [{ id: 'opus', name: 'Native resolved model' }] });
    assert.deepEqual(bridge.configuration({ harnessId: 'claude', model: { id: 'resolved-model[1M]' }, options: { model: { id: 'opus' } } }).effectiveModel, ref({ id: 'opus' }), 'Keep the native selectable alias after runtime initialization');
    runtime.catalogs.delete('pi');
    const esbuild = require('esbuild');
    const schemaPath = path.join(root, 'schemas.cjs');
    await esbuild.build({ entryPoints: ['src/native-ui/shared-contracts/src/index.ts'], outfile: schemaPath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const schemas = require(schemaPath);
    const version = await bridge.request('harness-mix/runtime/version');
    assert.equal(version.version, require('../package.json').version, 'About page reads the installed package version');
    const accounts = await bridge.request('harnessmix/account/list');
    schemas.codexAccountListResultSchema.parse(accounts);
    assert.equal(accounts.accounts[0].email, 'native@example.com', 'Official account/read is projected into Account management');
    assert.equal(accounts.accounts[0].authenticated, true);
    assert.equal(accounts.accounts[0].management, 'native');
    const accountUsage = await bridge.request('harnessmix/account/usage/inspect', { accountId: 'official-codex' });
    schemas.codexAccountUsageResultSchema.parse(accountUsage);
    assert.equal(accountUsage.usage.planFiveHourUsedPercent, 33);
    assert.equal(accountUsage.usage.planSevenDayUsedPercent, 29);
    assert.equal(accountUsage.accountCredits.periodType, 'five_hour');
    assert.equal(accountUsage.accountCredits.productUsage[0].product, '7-day window');
    const login = await bridge.request('harnessmix/account/login/start', { accountId: 'official-codex' });
    schemas.codexAccountLoginStartResultSchema.parse(login);
    assert.equal(login.userCode, 'ABCD-EFGH');
    assert.deepEqual(await bridge.request('harnessmix/account/login/cancel', { accountId: 'official-codex', loginId: 'native-login' }), { cancelled: true });
    const loggedOut = await bridge.request('harnessmix/account/logout');
    schemas.codexAccountMutationResultSchema.parse(loggedOut);
    assert.equal(loggedOut.account.authenticated, false);
    let openedCodexThread = null;
    const codexAdapter = {
      manifest: { id: 'codex', name: 'Codex', capabilities: { streaming: true, models: true, approvals: true, questions: true, resume: true } },
      async describe() { return { models: [{ id: 'gpt-test', name: 'GPT Test', provider: 'openai' }], thinkingLevels: [], permissionModes: [] }; },
      async open(input) { openedCodexThread = input.thread; return { nativeSessionId: 'isolated-native-session', model: input.thread.options.model }; },
      async send() {}, async cancel() {}, async close() {},
    };
    runtime.adapters.set('codex', codexAdapter);
    runtime.status.codex = { available: true };
    bridge.codexAccounts.close();
    bridge.codexAccounts = {
      executionContext(accountId) {
        assert.equal(accountId, 'account-work');
        return { accountId, codexHome: path.join(root, 'isolated-codex-home') };
      },
      close() {},
    };
    const isolated = await bridge.request('thread/start', { cwd: root, model: 'gpt-test', __harnessmixAccountId: 'account-work' });
    assert.equal(decodeRoute(isolated.thread.model).harnessId, 'codex-harness', 'An isolated Codex Account becomes an owned Codex adapter Thread');
    assert.equal(openedCodexThread.options.accountId, 'account-work');
    assert.equal(openedCodexThread.options.codexHome, path.join(root, 'isolated-codex-home'));
    assert.equal(openedCodexThread.options.model.id, 'gpt-test');
    const inspection = await bridge.inspect('pi');
    schemas.harnessInspectionSchema.parse(inspection);
    assert.deepEqual(inspection.capabilities.workspace, { git: true, worktree: true, finalDiff: true, nativeDiff: false, nativePatch: false });
    assert.equal(inspection.catalog.defaultThinkingOptionId, 'high', 'Declared default thinking level projects to the catalog');
    assert.ok(inspection.catalog.models.every(m => m.supportedThinkingOptionIds?.join(',') === 'high,low'), 'Every catalog model carries the selectable thinking set');
    schemas.harnessPluginListResultSchema.parse(await bridge.request('harnessmix/harness/plugins/list'));
    const started = await bridge.request('thread/start', { cwd: root, model: routeModel('pi') });
    const threadId = started.thread.id;
    const threadInspection = await bridge.request('harnessmix/thread/inspect', { threadId });
    schemas.threadInspectionSchema.parse(threadInspection);
    assert.equal(threadInspection.workspace.hostManaged, true);
    assert.equal(threadInspection.workspace.finalDiff.source, 'snapshot');
    assert.equal(threadInspection.workspace.worktree.available, true);
    assert.equal(started.thread.sessionId, threadId, 'Desktop session identity is the host thread, not a native session id');
    assert.equal(started.thread.model, 'harnessmix/pi-native');
    const { includesThread } = require('../src/main/native/thread-list');
    const storedThread = runtime.threads.find(t => t.id === threadId);
    const hostCommands = await bridge.request('harnessmix/thread/commands/inspect', { threadId });
    assert.ok(hostCommands.commands.some(command => command.id === 'verify'));
    assert.ok(hostCommands.commands.some(command => command.id === 'gate'));
    const gate = await bridge.request('harnessmix/thread/verification/configure', { threadId, policy: { mode: 'required', checks: { cleanWorkingTree: false } } });
    assert.equal(gate.policy.mode, 'required');
    assert.equal(gate.satisfied, false);
    assert.equal((await bridge.request('harnessmix/thread/verification/get', { threadId })).policy.mode, 'required');
    const storage = await bridge.request('harnessmix/storage/inspect');
    assert.equal(storage.schemaVersion, 2);
    assert.ok(storage.threadCount >= 1);
    assert.equal(includesThread(storedThread, { sectionId: section.id }), false);
    await bridge.request('thread/section/move', { threadId, sectionId: section.id });
    assert.deepEqual((await bridge.request('thread/read', { threadId })).thread.section, section);
    assert.equal(includesThread(storedThread, { sectionId: section.id }), true);
    assert.equal((await runtime.store.load()).find(t => t.id === threadId).section.id, section.id);
    await bridge.request('thread/section/move', { threadId, sectionId: null });
    assert.equal(includesThread(storedThread, { sectionId: section.id }), false);
    assert.equal((await runtime.store.load()).find(t => t.id === threadId).section, null);
    await assert.rejects(bridge.request('thread/section/move', { threadId, sectionId: 'missing' }), /Unknown thread section/);
    // Desktop draft prewarm: ephemeral threads project as ephemeral and stay out of the sidebar;
    // the first real turn materializes them.
    const prewarmed = await bridge.request('thread/start', { cwd: root, model: routeModel('pi'), ephemeral: true });
    assert.equal(prewarmed.thread.ephemeral, true, 'Prewarm thread projects as ephemeral');
    await bridge.request('turn/start', { threadId: prewarmed.thread.id, input: [{ type: 'text', text: 'real input' }] });
    assert.equal(runtime.threads.find(t => t.id === prewarmed.thread.id).ephemeral, undefined, 'First real input materializes the thread');
    const materialized = await bridge.request('thread/read', { threadId: prewarmed.thread.id });
    assert.equal(materialized.thread.ephemeral, false, 'Materialized thread projects as persistent');
    await bridge.request('turn/interrupt', { threadId: prewarmed.thread.id });
    await wait(() => !runtime.threads.find(t => t.id === prewarmed.thread.id).reviewPending && !runtime.sending.has(prewarmed.thread.id));
    emit = emits[0]; // 恢复主线程的事件源（open 顺序：主线程序，预热线程后）
    schemas.threadInspectionSchema.parse(await bridge.request('harnessmix/thread/inspect', { threadId }));
    const turn = await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'test' }], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    // turn/start 在 currentTurn 建立后即返回，adapter.send 的调用在其后；等待透传到达
    await wait(() => sendExtras.at(-1)?.turnPermissions != null);
    assert.deepEqual(sendExtras.at(-1).turnPermissions, { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }, 'turn/start 权限参数透传到适配器');
    assert.ok(runtime.core.getTurn(turn.turn.id), 'Native turn IDs come from the existing ProtocolCore');
    emit({ kind: 'thinking-delta', text: 'reason' });
    emit({ kind: 'text-delta', text: 'hello' });
    emit({ kind: 'text-delta', text: ' world' });
    emit({ kind: 'tool', toolCallId: 't', title: 'Read', state: 'running', input: '{}' });
    emit({ kind: 'tool', toolCallId: 't', title: 'Read', state: 'completed', output: 'done' });
    emit({ kind: 'tool', toolCallId: 'sh', title: 'Bash', state: 'running', input: '{"command":"cat package.json"}' });
    emit({ kind: 'tool', toolCallId: 'sh', title: 'Bash', state: 'completed', output: '{}' });
    emit({ kind: 'approval', requestId: 'permission', method: 'confirm', title: 'Allow?' });
    const approval = events.find(e => e.id?.startsWith('harness-mix:approval:'));
    assert.equal(answers.length, 0, 'Approval is not fabricated');
    await bridge.respond({ id: approval.id, result: { decision: 'decline' } });
    assert.deepEqual(answers[0], { id: 'permission', answer: { confirmed: false } });
    emit({ kind: 'approval', requestId: 'question', method: 'input', title: 'Name?' });
    const question = events.find(e => e.method === 'item/tool/requestUserInput');
    await bridge.respond({ id: question.id, result: { answers: { question: { answers: ['Alice'] } } } });
    assert.equal(answers[1].answer.value, 'Alice');
    // 多选提问：answers 数组必须全量保留（JSON 编码），只取 [0] 会无声吞掉其余选项
    emit({ kind: 'approval', requestId: 'multi', method: 'input', title: 'Pick many?' });
    const multi = events.filter(e => e.method === 'item/tool/requestUserInput').at(-1);
    await bridge.respond({ id: multi.id, result: { answers: { multi: { answers: ['a', 'b'] } } } });
    assert.equal(answers[2].answer.value, '["a","b"]', '多选答案 JSON 编码全量保留');
    emit({ kind: 'approval', requestId: 'empty', method: 'input', title: 'Empty?' });
    const emptyQ = events.filter(e => e.method === 'item/tool/requestUserInput').at(-1);
    await bridge.respond({ id: emptyQ.id, result: { answers: { empty: { answers: [] } } } });
    assert.equal(answers[3].answer.value, '', '空答案数组回退为空字符串而非 undefined');
    // 权限模式（回合运行中，原生正忙/等审批）：选择立即接受为挂起档位并回报生效值，
    // 不向原生会话热应用（CodeBuddy 等会因 turn 进行中拒绝配置）
    const queuedMode = await bridge.request('harnessmix/thread/permission-mode/select', { threadId, permissionModeId: 'bypassPermissions' });
    assert.equal(queuedMode.effectivePermissionModeId, 'bypassPermissions', '回合运行中的权限模式选择被接受为生效档位');
    assert.deepEqual(permissionModeCalls, [], '回合运行中不向原生会话热应用权限模式');
    emit({ kind: 'file-change', changes: [{ path: 'a.txt', changeType: 'added', before: '', after: 'hello', complete: true }] });
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.threads.find(t => t.id === threadId).reviewPending && !runtime.sending.has(threadId));
    // Fork：Host 侧新建分支线程必须广播 thread/started，否则 Desktop 侧边栏不显示分支
    const forked = await bridge.request('thread/fork', { threadId });
    assert.ok(events.some(e => e.method === 'thread/started' && e.params.thread.id === forked.thread.id), 'Fork 后 Desktop 收到分支线程的 thread/started');
    assert.equal(events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join(''), 'hello world');
    // 非终端工具投影为 dynamicToolCall（摘要显示真实工具名），终端命令投影为原生 commandExecution
    assert.ok(events.some(e => e.method === 'item/completed' && e.params.item.type === 'dynamicToolCall' && e.params.item.tool === 'Read'));
    const execItem = events.filter(e => e.method === 'item/completed').map(e => e.params.item).find(i => i.type === 'commandExecution');
    assert.equal(execItem?.command, 'cat package.json', 'Shell tool projects the real command text');
    assert.equal(execItem?.commandActions?.[0]?.type, 'read', 'Simple cat command classifies as a read action');
    assert.equal(execItem?.commandActions?.[0]?.path, 'package.json');
    assert.equal(typeof execItem?.durationMs, 'number', 'Command execution carries a real duration');
    // Desktop 以 `diff --git a/x b/x` 切分文件并提取路径，且只在 @@ hunk 头之后计数增删行
    const turnDiff = events.filter(e => e.method === 'turn/diff/updated').at(-1).params.diff;
    assert.ok(turnDiff.includes('diff --git a/a.txt b/a.txt'), 'turn diff carries git-style file headers');
    assert.ok(turnDiff.includes('--- /dev/null') && turnDiff.includes('+++ b/a.txt'), 'added file uses /dev/null header');
    assert.ok(turnDiff.includes('@@ -0,0 +1,1 @@') && turnDiff.includes('+hello'), 'turn diff carries a countable hunk');
    assert.ok(events.some(e => e.method === 'turn/diff/updated' && e.params.diff.includes('a.txt')));
    assert.equal(events.filter(e => e.method === 'turn/completed' && e.params.threadId === threadId).length, 1);
    // Desktop「已处理/用时」计时契约：item/started 带 startedAtMs、item/completed 带
    // completedAtMs，终态 Turn 带 startedAt/completedAt（epoch 秒）与 durationMs（毫秒）；
    // 缺这些字段时 Desktop 无法合成 worked-for 计时项，完成回合只显示集成摘要。
    const completedTurn = events.filter(e => e.method === 'turn/completed' && e.params.threadId === threadId && e.params.turn.status === 'completed').at(-1).params.turn;
    assert.equal(typeof completedTurn.durationMs, 'number', 'Completed turn carries durationMs for the Desktop worked-for timer');
    assert.ok(Number.isInteger(completedTurn.startedAt) && Number.isInteger(completedTurn.completedAt), 'Completed turn carries epoch-second startedAt/completedAt');
    assert.ok(completedTurn.durationMs >= 0 && completedTurn.completedAt >= completedTurn.startedAt, 'Turn timing fields are coherent');
    assert.ok(events.filter(e => e.method === 'item/started').every(e => typeof e.params.startedAtMs === 'number'), 'item/started carries startedAtMs');
    assert.ok(events.filter(e => e.method === 'item/completed').every(e => typeof e.params.completedAtMs === 'number'), 'item/completed carries completedAtMs');
    const history = await bridge.request('thread/read', { threadId });
    assert.equal(history.thread.turns[0].status, 'completed');
    assert.equal(typeof history.thread.turns[0].durationMs, 'number', 'Restored turns keep durationMs');
    const projectedChange = history.thread.turns[0].items.flatMap(i => i.type === 'fileChange' ? i.changes : []).find(change => change.path === 'a.txt');
    assert.equal(projectedChange?.kind.type, 'add', 'fileChange item projects the added kind');
    assert.ok(projectedChange?.diff.includes('diff --git a/a.txt b/a.txt') && projectedChange.diff.includes('@@ -0,0 +1,1 @@'), 'fileChange item carries a full unified diff');
    await bridge.request('thread/settings/update', { threadId, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    assert.deepEqual(runtime.threads.find(t => t.id === threadId).options.turnPermissions, { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }, 'Desktop 权限菜单设置存储到线程');
    const resumed = await bridge.request('thread/resume', { threadId });
    assert.equal(resumed.approvalPolicy, 'never', 'thread/resume 回显实际生效的权限');
    assert.deepEqual(resumed.sandbox, { type: 'dangerFullAccess' }, 'thread/resume 回显实际生效的沙箱');
    await bridge.request('thread/name/set', { threadId, name: 'Local Core' });
    await bridge.request('thread/archive', { threadId });
    assert.equal(runtime.threads.find(t => t.id === threadId).archived, true);
    await bridge.request('thread/unarchive', { threadId });
    await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'cancel' }] });
    assert.deepEqual(permissionModeCalls, ['bypassPermissions'], '挂起的权限模式在下轮投递前应用到原生会话');
    await bridge.request('turn/interrupt', { threadId });
    await wait(() => !runtime.threads.find(t => t.id === threadId).reviewPending && !runtime.sending.has(threadId));
    assert.equal(events.filter(e => e.method === 'turn/completed').at(-1).params.turn.status, 'interrupted');
    // External steering: cancel the active Turn, settle, then start a real new Turn.
    const stale = await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'first' }] });
    await assert.rejects(bridge.request('turn/steer', { threadId, expectedTurnId: stale.turn.id, input: [] }), /non-empty text/, 'Invalid input is rejected before cancelling');
    assert.ok(runtime.execution.isRunning(threadId), 'Rejected steering leaves the active Turn running');
    const steered = await bridge.request('turn/steer', { threadId, expectedTurnId: stale.turn.id, clientUserMessageId: 'msg-1', input: [{ type: 'text', text: 'redirect' }] });
    assert.ok(steered.turnId && steered.turnId !== stale.turn.id, 'Steering allocates a real new Turn identity');
    assert.equal(runtime.core.getTurn(stale.turn.id).status, 'cancelled', 'Old Turn was cancelled');
    const replay = await bridge.request('turn/steer', { threadId, expectedTurnId: stale.turn.id, clientUserMessageId: 'msg-1', input: [{ type: 'text', text: 'redirect' }] });
    assert.equal(replay.turnId, steered.turnId, 'Identical retry returns the delivery receipt');
    await assert.rejects(bridge.request('turn/steer', { threadId, expectedTurnId: 'other', clientUserMessageId: 'msg-1', input: [{ type: 'text', text: 'changed' }] }), /Conflicting/, 'Same message ID with different payload is rejected');
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.execution.isRunning(threadId) && !runtime.threads.find(t => t.id === threadId).reviewPending && !runtime.sending.has(threadId));
    await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'second' }] });
    const current = runtime.threads.find(t => t.id === threadId).currentTurn.id;
    await assert.rejects(bridge.request('turn/steer', { threadId, expectedTurnId: 'wrong-turn', input: [{ type: 'text', text: 'x' }] }), /no longer matches/, 'Stale target is not guessed');
    assert.ok(runtime.execution.isRunning(threadId) && runtime.threads.find(t => t.id === threadId).currentTurn.id === current, 'Stale steering never cancels the running Turn');
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.execution.isRunning(threadId) && !runtime.threads.find(t => t.id === threadId).reviewPending && !runtime.sending.has(threadId));
    // 权限模式（空闲）：热应用一次并回报生效值；已应用的档位在后续轮次不重复下发
    const idleMode = await bridge.request('harnessmix/thread/permission-mode/select', { threadId, permissionModeId: 'approve' });
    assert.equal(idleMode.effectivePermissionModeId, 'approve', '空闲时的权限模式选择立即生效');
    assert.deepEqual(permissionModeCalls, ['bypassPermissions', 'approve'], '空闲时热应用恰好一次');
    await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'mode-check' }] });
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.execution.isRunning(threadId) && !runtime.threads.find(t => t.id === threadId).reviewPending && !runtime.sending.has(threadId));
    assert.deepEqual(permissionModeCalls, ['bypassPermissions', 'approve'], '已应用的权限模式在后续轮次不重复下发');
    assert.equal(await bridge.request('thread/start', { model: 'official-model' }), undefined, 'Official Codex thread/start passes through');
    for (const [method, params] of [
      ['thread/read', { threadId: 'official-thread', includeTurns: true }],
      ['thread/resume', { threadId: 'official-thread' }],
      ['turn/start', { threadId: 'official-thread', input: [{ type: 'text', text: 'continue' }] }],
      ['turn/interrupt', { threadId: 'official-thread', turnId: 'official-turn' }],
      ['thread/fork', { threadId: 'official-thread', lastTurnId: 'official-turn' }],
      ['thread/compact/start', { threadId: 'official-thread' }],
    ]) {
      assert.equal(await bridge.request(method, params), undefined, `Official Codex ${method} passes through`);
    }
    assert.deepEqual(await bridge.request('harnessmix/thread/ownership/list', { threadIds: ['official-thread', threadId] }), {
      threads: [
        { threadId: 'official-thread', owner: 'codex' },
        { threadId, owner: 'external', harnessId: 'pi' },
      ],
    }, 'Official and Harness-managed threads keep separate ownership');
    const runtimeInspection = await bridge.request('harness-mix/runtime/inspect');
    assert.deepEqual(runtimeInspection.codex, { mode: 'official-direct', managedRoute: 'codex-harness' });
    adapter.listCommands = async () => [{ id: 'compact', action: 'execute', label: 'Compact' }];
    let compactCalls = 0;
    adapter.executeCommand = async (_session, id, hooks) => {
      assert.equal(id, 'compact'); compactCalls++;
      hooks.emit({ kind: 'usage', usage: { input: 20, output: 5, cacheRead: 10, tokens: 30, contextWindow: 100, cost: 0.01 } });
      hooks.emit({ kind: 'completed', finalAnswer: true });
    };
    const command = await bridge.request('harnessmix/thread/command/execute', { threadId, commandId: 'compact' });
    schemas.threadCommandExecuteResultSchema.parse(command);
    await wait(() => compactCalls === 1 && !runtime.threads.find(t => t.id === threadId).reviewPending && !runtime.sending.has(threadId));
    const usage = await bridge.request('harnessmix/thread/usage/inspect', { threadId });
    schemas.threadUsageInspectionSchema.parse(usage);
    assert.equal(usage.usage.inputTokens, 20);
    assert.equal(usage.usage.contextUsagePercent, 30);
    assert.ok(events.some(e => e.method === 'harnessmix/thread/usage/updated' && e.params.usage?.cachedInputTokens === 10));
    await assert.rejects(bridge.request('harnessmix/thread/command/execute', { threadId, commandId: 'missing' }), /不支持此指令/);
    // ===== 新 Harness 路由：omp / opencode / grok 的 legacy 传输串解码与投影 =====
    assert.equal(routeModel('omp'), 'harnessmix/omp-native');
    assert.equal(routeModel('opencode'), 'harnessmix/opencode-native');
    assert.equal(routeModel('grok'), 'harnessmix/grok-native');
    assert.deepEqual(decodeRoute('harnessmix/omp-native'), { harnessId: 'omp' });
    assert.deepEqual(decodeRoute('harnessmix/omp-native@model-x@high'), { harnessId: 'omp', model: { id: 'model-x' }, thinkingOptionId: 'high' }, 'OMP 两段式 = model@thinking');
    assert.deepEqual(decodeRoute('harnessmix/omp-native@model-x@approve@high'), { harnessId: 'omp', model: { id: 'model-x' }, permissionModeId: 'approve', thinkingOptionId: 'high' }, 'OMP 三段式 = model@permission@thinking');
    assert.deepEqual(decodeRoute('harnessmix/opencode-native@m@perm'), { harnessId: 'opencode', model: { id: 'm' }, permissionModeId: 'perm' });
    assert.deepEqual(decodeRoute('harnessmix/grok-native@m@@think'), { harnessId: 'grok', model: { id: 'm' }, thinkingOptionId: 'think' });
    assert.throws(() => decodeRoute('harnessmix/omp-native@a@b@c@d'), /Invalid native Harness route/);
    // ===== 跨 Harness 协作：委派 → 消息 → 等待 → 级联取消 =====
    const childEmits = [];
    let childSend;
    const childAdapter = { manifest: { id: 'claude', name: 'Claude Code', aliases: ['claude', 'claude-code'], capabilities: { streaming: true, models: true, resume: true } },
      async open(input) { childEmits.push(input.emit); return {}; },
      async describe() { return { models: [], thinkingLevels: [], permissionModes: [] }; },
      sendCalls: [], cancelCalls: 0,
      async send(session, text, hooks) { this.sendCalls.push(text); await (childSend ?? (() => {}))(hooks); },
      async cancel() { this.cancelCalls++; },
      async close() {} };
    runtime.adapters.set('claude', childAdapter); runtime.status.claude = { available: true };
    // Host 级 /delegate 指令出现在命令目录中（insert 型，填入输入框）
    const commandList = await bridge.request('harnessmix/thread/commands/inspect', { threadId });
    assert.ok(commandList.commands.some(c => c.invocation === '/delegate' && c.argumentMode === 'text'), 'Host 级 /delegate 指令应出现在命令目录');
    // 委派：协议入口创建子任务线程并挂起父线程协作 Turn
    childSend = hooks => { hooks.emit({ kind: 'text-delta', text: '子任务结论' }); hooks.emit({ kind: 'completed', finalAnswer: true }); };
    const delegated = await bridge.request('harnessmix/thread/delegate', { threadId, harnessId: 'claude-code', task: '审查代码' });
    schemas.threadDelegationResultSchema.parse(delegated);
    assert.equal(delegated.turn.status, 'inProgress', '委派后父线程协作 Turn 保持活动');
    assert.ok(delegated.turn?.id, 'Delegation starts a parent collaboration Turn');
    const childId = delegated.childThreadId;
    const childThread = runtime.threads.find(t => t.id === childId);
    assert.equal(childThread.parentThreadId, threadId, '子任务记录父任务归属');
    assert.ok(events.some(e => e.method === 'thread/started' && e.params.thread.id === childId), 'Desktop 收到协作子任务的 thread/started');
    assert.equal((await bridge.request('thread/read', { threadId: childId })).thread.parentThreadId, threadId, '子任务投影 parentThreadId');
    assert.equal(includesThread(childThread, { parentThreadId: threadId }, runtime.threads), true, '父子归属查询匹配子任务');
    assert.equal(includesThread(childThread, { ancestorThreadId: threadId }, runtime.threads), true, '祖先查询沿 parentThreadId 链匹配');
    assert.equal(includesThread(storedThread, { parentThreadId: threadId }, runtime.threads), false, '普通线程不出现在子任务查询');
    await wait(() => !runtime.execution.isRunning(threadId));
    assert.deepEqual(childAdapter.sendCalls, ['审查代码'], '子任务收到委派任务');
    const parentTurn = runtime.core.getItemsForTurn(delegated.turn.id);
    const delegateTool = parentTurn.find(i => i.type === 'tool_call');
    assert.equal(delegateTool.title, 'Agent 协作 · Claude Code');
    assert.equal(delegateTool.status, 'completed', '子任务结算后协作工具项完成');
    assert.ok(String(delegateTool.output).includes('子任务结论'), '协作工具项携带子任务最终答复');
    // 消息链：向同一子任务跟进（复用既有子线程）
    const followUp = await bridge.request('harnessmix/thread/message', { threadId, childThreadId: childId, text: '再检查一遍' });
    schemas.threadDelegationResultSchema.parse(followUp);
    await wait(() => !runtime.execution.isRunning(threadId));
    assert.deepEqual(childAdapter.sendCalls, ['审查代码', '再检查一遍'], '跟进消息进入同一子任务');
    assert.equal(followUp.childThreadId, childId);
    // 循环防护：子任务不能继续委派
    await assert.rejects(bridge.request('harnessmix/thread/delegate', { threadId: childId, harnessId: 'pi', task: 'x' }), /暂不支持继续委派/);
    // 斜杠通道：/delegate 文本走同一委派链路
    childSend = hooks => { hooks.emit({ kind: 'text-delta', text: '斜杠委派完成' }); hooks.emit({ kind: 'completed', finalAnswer: true }); };
    const slashTurn = await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: '/delegate claude 用斜杠通道' }] });
    await wait(() => !runtime.execution.isRunning(threadId));
    assert.deepEqual(childAdapter.sendCalls.at(-1), '用斜杠通道', '斜杠指令进入委派链路');
    assert.equal(runtime.core.getItemsForTurn(slashTurn.turn.id).find(i => i.type === 'tool_call')?.status, 'completed');
    await assert.rejects(bridge.request('turn/start', { threadId, input: [{ type: 'text', text: '/delegate' }] }), /用法：\/delegate/);
    // 级联取消：中断父线程协作 Turn ⇒ 子任务被取消
    childSend = () => new Promise(() => {}); // 子任务永不自行结算
    const stuck = await bridge.request('harnessmix/thread/delegate', { threadId, harnessId: 'claude', task: '长跑任务' });
    assert.ok(runtime.execution.isRunning(threadId), '父线程协作 Turn 等待子任务');
    await bridge.request('turn/interrupt', { threadId });
    await wait(() => !runtime.execution.isRunning(threadId) && !runtime.execution.isRunning(stuck.childThreadId));
    assert.equal(childAdapter.cancelCalls, 1, '中断父线程级联取消子任务');
    assert.equal(runtime.core.getTurn(stuck.turn.id).status, 'cancelled');
    // 瞬态 Fork / 后台元数据线程防护：拒绝 ephemeral / threadSource 请求，防止重命名/索引时静默派生会话
    await assert.rejects(bridge.request('thread/fork', { threadId, ephemeral: true }), /Ephemeral fork is not supported/);
    await assert.rejects(bridge.request('thread/fork', { threadId, threadSource: 'thread_description' }), /Ephemeral fork is not supported/);
    await assert.rejects(bridge.request('thread/fork', { threadId, excludeTurns: true }), /Ephemeral fork is not supported/);
    await assert.rejects(bridge.request('thread/start', { cwd: root, model: routeModel('pi'), ephemeral: true, threadSource: 'thread_description' }), /Ephemeral background thread is not supported/);
    // Desktop 26.917 的用户草稿预热带 threadSource:"user" + ephemeral：必须创建 ephemeral
    // 外部线程（拒绝会迫使 Desktop 回退原生执行路径，同一条消息双执行、侧边栏重复会话）
    const prewarmThread = await bridge.request('thread/start', { cwd: root, model: routeModel('pi'), ephemeral: true, threadSource: 'user' });
    assert.ok(prewarmThread.thread?.id, '用户预热创建 ephemeral 外部线程');
    assert.equal(runtime.threads.find(t => t.id === prewarmThread.thread.id)?.ephemeral, true, '预热线程标记为 ephemeral');
    // Worktree 隔离工作区丢弃与推送协议接口
    await assert.rejects(bridge.request('harnessmix/thread/workspace/discard', { threadId }), /该任务未使用 Worktree 隔离工作区/);
    await assert.rejects(bridge.request('harnessmix/thread/workspace/push', { threadId }), /该任务未使用 Worktree 隔离工作区/);
    const dummyWorktreeThread = await bridge.request('thread/start', { cwd: root, model: routeModel('pi') });
    const dummyThreadId = dummyWorktreeThread.thread.id;
    const dummyWorkspaceDir = path.join(root, 'dummy-wt');
    await fs.mkdir(dummyWorkspaceDir, { recursive: true });
    const dummyTargetThread = runtime.threads.find(t => t.id === dummyThreadId);
    dummyTargetThread.workspace = {
      mode: 'worktree',
      root: dummyWorkspaceDir,
      cwd: dummyWorkspaceDir,
      source: root,
      branch: 'harnessmix/test-wt-branch',
    };
    await assert.rejects(bridge.request('harnessmix/thread/workspace/push', { threadId: dummyThreadId }), /git/i);
    const discardResult = await bridge.request('harnessmix/thread/workspace/discard', { threadId: dummyThreadId });
    assert.equal(discardResult.discarded, true);
    assert.equal(discardResult.branch, 'harnessmix/test-wt-branch');
    assert.equal(dummyTargetThread.workspace, undefined, 'Discard deletes thread.workspace');

    // 消息排队（thread/queue/add, list, update, reorder, delete, start）能力验证
    const qThread = await bridge.request('thread/start', { cwd: root, model: routeModel('pi') });
    const qThreadId = qThread.thread.id;
    assert.deepEqual(await bridge.request('thread/queue/list', { threadId: qThreadId }), { data: [], nextCursor: null });
    observeQueueOrder = true;
    const q1 = await bridge.request('thread/queue/add', {
      threadId: qThreadId,
      input: [{ type: 'text', text: '排队补充需求 1' }],
      clientUserMessageId: 'client-msg-1',
    });
    queueResponseResolved = true;
    assert.equal(typeof q1.queuedSubmission.id, 'string');
    assert.equal(q1.queuedSubmission.clientUserMessageId, 'client-msg-1');
    await wait(() => events.at(-1)?.method === 'thread/queue/changed' && events.at(-1)?.params?.threadId === qThreadId);
    assert.equal(queueNotificationBeforeResponse, false, 'Queue mutation response precedes changed notification so Desktop edits keep the current id');
    observeQueueOrder = false;
    assert.equal(events.at(-1)?.method, 'thread/queue/changed');
    assert.equal(events.at(-1)?.params?.threadId, qThreadId);

    const q2 = await bridge.request('thread/queue/add', {
      threadId: qThreadId,
      input: [{ type: 'text', text: '排队补充需求 2' }],
      clientUserMessageId: 'client-msg-2',
    });
    let qList = await bridge.request('thread/queue/list', { threadId: qThreadId });
    assert.equal(qList.data.length, 2);
    assert.equal(qList.data[0].id, q1.queuedSubmission.id);
    assert.equal(qList.data[1].id, q2.queuedSubmission.id);

    // 更新排队项
    const updated = await bridge.request('thread/queue/update', {
      threadId: qThreadId,
      queuedSubmissionId: q1.queuedSubmission.id,
      input: [{ type: 'text', text: '更新后的补充需求 1' }],
    });
    assert.equal(updated.queuedSubmission.input[0].text, '更新后的补充需求 1');

    // 重排序
    await bridge.request('thread/queue/reorder', {
      threadId: qThreadId,
      queuedSubmissionIds: [q2.queuedSubmission.id, q1.queuedSubmission.id],
    });
    qList = await bridge.request('thread/queue/list', { threadId: qThreadId });
    assert.equal(qList.data[0].id, q2.queuedSubmission.id);
    assert.equal(qList.data[1].id, q1.queuedSubmission.id);

    // 删除排队项
    const del = await bridge.request('thread/queue/delete', {
      threadId: qThreadId,
      queuedSubmissionId: q2.queuedSubmission.id,
    });
    assert.equal(del.deleted, true);
    qList = await bridge.request('thread/queue/list', { threadId: qThreadId });
    assert.equal(qList.data.length, 1);
    assert.equal(qList.data[0].id, q1.queuedSubmission.id);

    // 输入准备或原生启动失败时不得丢失排队项，仍可编辑后重试。
    await bridge.request('thread/queue/update', {
      threadId: qThreadId,
      queuedSubmissionId: q1.queuedSubmission.id,
      input: [{ type: 'unsupported-test-input' }],
    });
    await assert.rejects(bridge.request('thread/queue/start', {
      threadId: qThreadId,
      queuedSubmissionId: q1.queuedSubmission.id,
    }), /Unsupported native input type/);
    qList = await bridge.request('thread/queue/list', { threadId: qThreadId });
    assert.equal(qList.data[0]?.id, q1.queuedSubmission.id, 'Failed queue start keeps the item for editing or retry');
    await bridge.request('thread/queue/update', {
      threadId: qThreadId,
      queuedSubmissionId: q1.queuedSubmission.id,
      input: [{ type: 'text', text: '修正后的排队消息' }],
    });

    // 空闲状态启动排队消息
    const startedQ = await bridge.request('thread/queue/start', {
      threadId: qThreadId,
      queuedSubmissionId: q1.queuedSubmission.id,
    });
    assert.equal(typeof startedQ.turn?.id, 'string');
    assert.deepEqual(await bridge.request('thread/queue/list', { threadId: qThreadId }), { data: [], nextCursor: null });

    // 运行中打断执行排队消息（中途补充并打断执行）
    let releaseHold;
    const holdGate = new Promise(resolve => { releaseHold = resolve; });
    const holdAdapter = {
      manifest: { id: 'hold-adapter', name: 'Hold', capabilities: { streaming: true, models: true, resume: true } },
      async open() { return {}; },
      async send(session, text, { emit }) {
        if (text.includes('长任务')) {
          await holdGate;
        } else {
          emit({ kind: 'completed', finalAnswer: true });
        }
      },
      async cancel() { releaseHold(); },
      async close() {},
    };
    runtime.adapters.set('hold-adapter', holdAdapter);
    runtime.status['hold-adapter'] = { available: true };
    const steerThread = await bridge.request('thread/start', { cwd: root, model: routeModel('hold-adapter') });
    const steerThreadId = steerThread.thread.id;
    // 启动初始任务，使其进入运行中状态
    const initTurn = await bridge.request('turn/start', {
      threadId: steerThreadId,
      input: [{ type: 'text', text: '长任务运行中...' }],
    });
    assert.equal(runtime.execution.isRunning(steerThreadId), true);
    // 运行时添加排队补充
    const steerQueue = await bridge.request('thread/queue/add', {
      threadId: steerThreadId,
      input: [{ type: 'text', text: '中途打断补充并立即执行' }],
    });
    assert.equal(typeof steerQueue.queuedSubmission.id, 'string');
    // 执行 thread/queue/start：打断当前任务并立即执行补充内容
    const midTurnStart = await bridge.request('thread/queue/start', {
      threadId: steerThreadId,
      queuedSubmissionId: steerQueue.queuedSubmission.id,
    });
    assert.notEqual(midTurnStart.turn.id, initTurn.turn.id, '排队消息中途启动已成功打断并派生新 Turn');
    releaseHold();
    await wait(() => !runtime.execution.isRunning(steerThreadId));

    console.log('PASS: native protocol, external steering, command execution, message queue and Usage projection');
  } finally { bridge.close(); await runtime.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
