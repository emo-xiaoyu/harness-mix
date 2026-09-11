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
  const adapter = { manifest: { id: 'pi', name: 'Pi', capabilities: { streaming: true, models: true, approvals: true, questions: true, resume: true } },
    async open(input) { emits.push(input.emit); emit = input.emit; return {}; },
    async describe() { return { models: [{ id: 'demo', name: 'Demo', provider: 'test' }], thinkingLevels: [{ id: 'high', label: 'High', default: true }, { id: 'low', label: 'Low' }], permissionModes: [] }; },
    async send() {}, async cancel() {}, async close() {},
    async respond(session, id, answer) { answers.push({ id, answer }); } };
  runtime.adapters.set('pi', adapter); runtime.status.pi = { available: true };
  const events = [];
  const section = { id: 'test-pinned-section', name: 'Pinned', appearance: null };
  const bridge = new NativeProtocol(runtime, event => events.push(event), async method => {
    assert.equal(method, 'threadSection/list');
    return { data: [section], nextCursor: null };
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
    const inspection = await bridge.inspect('pi');
    schemas.harnessInspectionSchema.parse(inspection);
    assert.equal(inspection.catalog.defaultThinkingOptionId, 'high', 'Declared default thinking level projects to the catalog');
    assert.ok(inspection.catalog.models.every(m => m.supportedThinkingOptionIds?.join(',') === 'high,low'), 'Every catalog model carries the selectable thinking set');
    schemas.harnessPluginListResultSchema.parse(await bridge.request('codexhost/harness/plugins/list'));
    const started = await bridge.request('thread/start', { cwd: root, model: routeModel('pi') });
    const threadId = started.thread.id;
    assert.equal(started.thread.sessionId, threadId, 'Desktop session identity is the host thread, not a native session id');
    assert.equal(started.thread.model, 'codexhost/pi-native');
    const { includesThread } = require('../src/main/native/thread-list');
    const storedThread = runtime.threads.find(t => t.id === threadId);
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
    await wait(() => !runtime.threads.find(t => t.id === prewarmed.thread.id).reviewPending);
    emit = emits[0]; // 恢复主线程的事件源（open 顺序：主线程序，预热线程后）
    schemas.threadInspectionSchema.parse(await bridge.request('codexhost/thread/inspect', { threadId }));
    const turn = await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'test' }] });
    assert.ok(runtime.core.getTurn(turn.turn.id), 'Native turn IDs come from the existing ProtocolCore');
    emit({ kind: 'thinking-delta', text: 'reason' });
    emit({ kind: 'text-delta', text: 'hello' });
    emit({ kind: 'text-delta', text: ' world' });
    emit({ kind: 'tool', toolCallId: 't', title: 'Read', state: 'running', input: '{}' });
    emit({ kind: 'tool', toolCallId: 't', title: 'Read', state: 'completed', output: 'done' });
    emit({ kind: 'approval', requestId: 'permission', method: 'confirm', title: 'Allow?' });
    const approval = events.find(e => e.id?.startsWith('harness-mix:approval:'));
    assert.equal(answers.length, 0, 'Approval is not fabricated');
    await bridge.respond({ id: approval.id, result: { decision: 'decline' } });
    assert.deepEqual(answers[0], { id: 'permission', answer: { confirmed: false } });
    emit({ kind: 'approval', requestId: 'question', method: 'input', title: 'Name?' });
    const question = events.find(e => e.method === 'item/tool/requestUserInput');
    await bridge.respond({ id: question.id, result: { answers: { question: { answers: ['Alice'] } } } });
    assert.equal(answers[1].answer.value, 'Alice');
    emit({ kind: 'file-change', changes: [{ path: 'a.txt', changeType: 'added', before: '', after: 'hello', complete: true }] });
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.threads.find(t => t.id === threadId).reviewPending);
    assert.equal(events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join(''), 'hello world');
    assert.ok(events.some(e => e.method === 'item/completed' && e.params.item.type === 'mcpToolCall'));
    // Desktop 以 `diff --git a/x b/x` 切分文件并提取路径，且只在 @@ hunk 头之后计数增删行
    const turnDiff = events.filter(e => e.method === 'turn/diff/updated').at(-1).params.diff;
    assert.ok(turnDiff.includes('diff --git a/a.txt b/a.txt'), 'turn diff carries git-style file headers');
    assert.ok(turnDiff.includes('--- /dev/null') && turnDiff.includes('+++ b/a.txt'), 'added file uses /dev/null header');
    assert.ok(turnDiff.includes('@@ -0,0 +1,1 @@') && turnDiff.includes('+hello'), 'turn diff carries a countable hunk');
    assert.ok(events.some(e => e.method === 'turn/diff/updated' && e.params.diff.includes('a.txt')));
    assert.equal(events.filter(e => e.method === 'turn/completed' && e.params.threadId === threadId).length, 1);
    const history = await bridge.request('thread/read', { threadId });
    assert.equal(history.thread.turns[0].status, 'completed');
    const projectedChange = history.thread.turns[0].items.find(i => i.type === 'fileChange')?.changes?.[0];
    assert.equal(projectedChange?.kind.type, 'add', 'fileChange item projects the added kind');
    assert.ok(projectedChange?.diff.includes('diff --git a/a.txt b/a.txt') && projectedChange.diff.includes('@@ -0,0 +1,1 @@'), 'fileChange item carries a full unified diff');
    await bridge.request('thread/name/set', { threadId, name: 'Local Core' });
    await bridge.request('thread/archive', { threadId });
    assert.equal(runtime.threads.find(t => t.id === threadId).archived, true);
    await bridge.request('thread/unarchive', { threadId });
    await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'cancel' }] });
    await bridge.request('turn/interrupt', { threadId });
    await wait(() => !runtime.threads.find(t => t.id === threadId).reviewPending);
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
    await wait(() => !runtime.threads.find(t => t.id === threadId).reviewPending);
    await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'second' }] });
    const current = runtime.threads.find(t => t.id === threadId).currentTurn.id;
    await assert.rejects(bridge.request('turn/steer', { threadId, expectedTurnId: 'wrong-turn', input: [{ type: 'text', text: 'x' }] }), /no longer matches/, 'Stale target is not guessed');
    assert.ok(runtime.execution.isRunning(threadId) && runtime.threads.find(t => t.id === threadId).currentTurn.id === current, 'Stale steering never cancels the running Turn');
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.threads.find(t => t.id === threadId).reviewPending);
    assert.equal(await bridge.request('thread/start', { model: 'official-model' }), undefined, 'Official Codex requests pass through');
    adapter.listCommands = async () => [{ id: 'compact', action: 'execute', label: 'Compact' }];
    let compactCalls = 0;
    adapter.executeCommand = async (_session, id, hooks) => {
      assert.equal(id, 'compact'); compactCalls++;
      hooks.emit({ kind: 'usage', usage: { input: 20, output: 5, cacheRead: 10, tokens: 30, contextWindow: 100, cost: 0.01 } });
      hooks.emit({ kind: 'completed', finalAnswer: true });
    };
    const command = await bridge.request('codexhost/thread/command/execute', { threadId, commandId: 'compact' });
    schemas.threadCommandExecuteResultSchema.parse(command);
    await wait(() => compactCalls === 1 && !runtime.threads.find(t => t.id === threadId).reviewPending);
    const usage = await bridge.request('codexhost/thread/usage/inspect', { threadId });
    schemas.threadUsageInspectionSchema.parse(usage);
    assert.equal(usage.usage.inputTokens, 20);
    assert.equal(usage.usage.contextUsagePercent, 30);
    assert.ok(events.some(e => e.method === 'codexhost/thread/usage/updated' && e.params.usage?.cachedInputTokens === 10));
    await assert.rejects(bridge.request('codexhost/thread/command/execute', { threadId, commandId: 'missing' }), /不支持此指令/);
    // ===== 新 Harness 路由：omp / opencode / grok 的 legacy 传输串解码与投影 =====
    assert.equal(routeModel('omp'), 'codexhost/omp-native');
    assert.equal(routeModel('opencode'), 'codexhost/opencode-native');
    assert.equal(routeModel('grok'), 'codexhost/grok-native');
    assert.deepEqual(decodeRoute('codexhost/omp-native'), { harnessId: 'omp' });
    assert.deepEqual(decodeRoute('codexhost/omp-native@model-x@high'), { harnessId: 'omp', model: { id: 'model-x' }, thinkingOptionId: 'high' }, 'OMP 两段式 = model@thinking');
    assert.deepEqual(decodeRoute('codexhost/omp-native@model-x@approve@high'), { harnessId: 'omp', model: { id: 'model-x' }, permissionModeId: 'approve', thinkingOptionId: 'high' }, 'OMP 三段式 = model@permission@thinking');
    assert.deepEqual(decodeRoute('codexhost/opencode-native@m@perm'), { harnessId: 'opencode', model: { id: 'm' }, permissionModeId: 'perm' });
    assert.deepEqual(decodeRoute('codexhost/grok-native@m@@think'), { harnessId: 'grok', model: { id: 'm' }, thinkingOptionId: 'think' });
    assert.throws(() => decodeRoute('codexhost/omp-native@a@b@c@d'), /Invalid native Harness route/);
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
    const commandList = await bridge.request('codexhost/thread/commands/inspect', { threadId });
    assert.ok(commandList.commands.some(c => c.invocation === '/delegate' && c.argumentMode === 'text'), 'Host 级 /delegate 指令应出现在命令目录');
    // 委派：协议入口创建子任务线程并挂起父线程协作 Turn
    childSend = hooks => { hooks.emit({ kind: 'text-delta', text: '子任务结论' }); hooks.emit({ kind: 'completed', finalAnswer: true }); };
    const delegated = await bridge.request('codexhost/thread/delegate', { threadId, harnessId: 'claude-code', task: '审查代码' });
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
    const followUp = await bridge.request('codexhost/thread/message', { threadId, childThreadId: childId, text: '再检查一遍' });
    schemas.threadDelegationResultSchema.parse(followUp);
    await wait(() => !runtime.execution.isRunning(threadId));
    assert.deepEqual(childAdapter.sendCalls, ['审查代码', '再检查一遍'], '跟进消息进入同一子任务');
    assert.equal(followUp.childThreadId, childId);
    // 循环防护：子任务不能继续委派
    await assert.rejects(bridge.request('codexhost/thread/delegate', { threadId: childId, harnessId: 'pi', task: 'x' }), /暂不支持继续委派/);
    // 斜杠通道：/delegate 文本走同一委派链路
    childSend = hooks => { hooks.emit({ kind: 'text-delta', text: '斜杠委派完成' }); hooks.emit({ kind: 'completed', finalAnswer: true }); };
    const slashTurn = await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: '/delegate claude 用斜杠通道' }] });
    await wait(() => !runtime.execution.isRunning(threadId));
    assert.deepEqual(childAdapter.sendCalls.at(-1), '用斜杠通道', '斜杠指令进入委派链路');
    assert.equal(runtime.core.getItemsForTurn(slashTurn.turn.id).find(i => i.type === 'tool_call')?.status, 'completed');
    await assert.rejects(bridge.request('turn/start', { threadId, input: [{ type: 'text', text: '/delegate' }] }), /用法：\/delegate/);
    // 级联取消：中断父线程协作 Turn ⇒ 子任务被取消
    childSend = () => new Promise(() => {}); // 子任务永不自行结算
    const stuck = await bridge.request('codexhost/thread/delegate', { threadId, harnessId: 'claude', task: '长跑任务' });
    assert.ok(runtime.execution.isRunning(threadId), '父线程协作 Turn 等待子任务');
    await bridge.request('turn/interrupt', { threadId });
    await wait(() => !runtime.execution.isRunning(threadId) && !runtime.execution.isRunning(stuck.childThreadId));
    assert.equal(childAdapter.cancelCalls, 1, '中断父线程级联取消子任务');
    assert.equal(runtime.core.getTurn(stuck.turn.id).status, 'cancelled');
    console.log('PASS: native protocol, external steering, command execution and Usage projection');
  } finally { bridge.close(); await runtime.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
