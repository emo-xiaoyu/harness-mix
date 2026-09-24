const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { mentionedAgents, teamTaskDepths, teamPhase, teamProgress, workerSessionOptions } = require('../src/main/host/collaboration');
const { createWorkspace, reviewWorkspace, git } = require('../src/main/host/collaboration-worktree');
const { JsonlProcess } = require('../src/main/host/jsonl');
const wait = async fn => { for (let i = 0; i < 600; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

async function main() {
  const root = await fs.mkdtemp(path.resolve('output/collaboration-'));
  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt.store.load();
  let connection, teamConnection, active = 0, maximum = 0;
  const pending = new Map();
  let leadPrompt = '';
  const lead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
    async open(input) { connection = input.collaboration; return { emit: input.emit, collaborationEnabled: true }; },
    async send(s, text) { leadPrompt = text; }, async cancel() {}, async close() {} };
  const worker = { manifest: { id: 'worker', name: 'Worker', aliases: ['w'], capabilities: { collaborationTools: true } },
    async open(input) {
      if (input.collaboration) teamConnection = input.collaboration;
      else assert.equal(input.collaboration, undefined);
      return { id: input.thread.id, emit: input.emit, collaborationEnabled: !!input.collaboration };
    },
    async send(s, text) { active++; maximum = Math.max(maximum, active); pending.set(s.id, { s, text }); },
    async cancel(s) { if (pending.delete(s.id)) active--; }, async close() {} };
  const reviewer = { ...worker, manifest: { id: 'reviewer', name: 'Reviewer', capabilities: { collaborationTools: true } } };
  rt.adapters.set('lead', lead); rt.status.lead = { available: true };
  rt.adapters.set('worker', worker); rt.status.worker = { available: true };
  rt.adapters.set('reviewer', reviewer); rt.status.reviewer = { available: true };
  const parent = await rt.createThread({ harnessId: 'lead', cwd: root });
  rt.collaboration.jobs.set('interrupted-fixture', { id: 'interrupted-fixture', owner: parent.id, agent: 'worker', childId: 'old-child', status: 'interrupted' });
  const ownerConnection = connection;
  const transport = new JsonlProcess(connection.command, connection.args, { env: { ...process.env, ...connection.env } }, {});
  const call = (name, args) => rt.collaboration.call(parent.id, name, args);
  const finish = (id, answer) => { const { s } = pending.get(id); pending.delete(id); active--; s.emit({ kind: 'text-delta', text: answer }); s.emit({ kind: 'completed', finalAnswer: true }); };
  try {
    // 协作/Agent Team/委派子会话的免打扰权限映射：各家选原生自有的免询问档；
    // ACP 系交给适配器按会话目录动态解析；无对应档位的 Harness 保持原生默认
    assert.deepEqual(workerSessionOptions('claude'), { permissionMode: 'bypassPermissions' });
    assert.deepEqual(workerSessionOptions('antigravity'), { permissionMode: 'skip' });
    assert.deepEqual(workerSessionOptions('pi'), { permissionMode: 'no-approve' });
    assert.deepEqual(workerSessionOptions('omp'), { permissionMode: 'yolo' }, 'OMP 免询问档是 --approval-mode yolo（no-approve 是 Pi 的旗标）');
    assert.deepEqual(workerSessionOptions('zcode'), { permissionMode: 'yolo' });
    assert.deepEqual(workerSessionOptions('codex-harness'), { turnPermissions: { approvalPolicy: 'never', sandboxPolicy: 'dangerFullAccess' } });
    assert.deepEqual(workerSessionOptions('codebuddy'), { workerPermissions: 'full' });
    assert.deepEqual(workerSessionOptions('qoder'), { workerPermissions: 'full' });
    assert.deepEqual(workerSessionOptions('grok'), { workerPermissions: 'full' });
    assert.deepEqual(workerSessionOptions('dsh'), {}, 'DSH 走自有 Web Remote 审批，不设置 ACP 档位');
    assert.deepEqual(workerSessionOptions('kiro-cli'), {}, 'Kiro autopilot 不是 Host 权限档位');
    assert.deepEqual(workerSessionOptions('worker'), {});
    assert.deepEqual(mentionedAgents('ask #w and [Worker](harness-mix://agent/worker) `#lead` issue#lead #worker/foo', rt), ['worker']);
    assert.deepEqual(mentionedAgents('\\#worker #reviewer 组成 Agent Team', rt), ['worker', 'reviewer'], 'Markdown 转义的 # 提及仍授权对应 Harness');
    assert.deepEqual(mentionedAgents('\\\\#worker #reviewer 组成 Agent Team', rt), ['reviewer'], '双反斜杠不应变成单次转义的授权');
    assert.deepEqual(mentionedAgents('\\[Worker]\\(harness-mix://agent/worker) 发消息', rt), ['worker'], 'Markdown 转义的 agent 链接仍授权对应 Harness');
    assert.deepEqual(mentionedAgents('\\\\[Worker]\\(harness-mix://agent/worker) 发消息', rt), [], '双反斜杠的链接不构成授权');
    assert.deepEqual(mentionedAgents('leave @w to native Codex mentions', rt), []);
    assert.deepEqual(mentionedAgents('创建 Agent Team：Worker 负责开发，Reviewer 负责审查。', rt), ['worker', 'reviewer'], '纯文本 Harness 名称可在明确团队语境中授权');
    assert.deepEqual(mentionedAgents('讨论 Worker 和 Reviewer 的界面显示', rt), [], '普通产品讨论不得误启动跨 Harness 协作');
    assert.deepEqual(mentionedAgents('组建团队，但不要从 `Worker` 或 ```Reviewer``` 调度', rt), [], '代码区域中的名称不得作为授权');
    assert.deepEqual(mentionedAgents('让 issue-worker 参与团队', rt), [], '较长标识符内的 Harness 子串不得误匹配');
    const depthFixture = [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b', 'missing'] }];
    assert.equal(teamTaskDepths(depthFixture).get('c'), 2, 'Depth follows the longest dependency chain and ignores unknown ids');
    assert.equal(teamTaskDepths(depthFixture).get('a'), 0);
    const cyclic = teamTaskDepths([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }]);
    assert.ok(Number.isFinite(cyclic.get('x')) && Number.isFinite(cyclic.get('y')), 'Cyclic graphs terminate');
    assert.equal(teamPhase({ tasks: [] }), 'forming');
    assert.equal(teamProgress([{ status: 'completed' }, { status: 'blocked' }]).percent, 50);
    await assert.rejects(call('list_agents', {}), /no longer active/);
    rt.history.context = async ({ nativeSessionId }) => { assert.equal(nativeSessionId, 'c2Vzc2lvbg'); return { harnessId: 'pi', title: 'Old session', cwd: root, transcript: 'User: prior question\nAssistant: prior answer' }; };
    await rt.send(parent.id, '\\#worker #reviewer review files #[Old session](harness-mix://session/c2Vzc2lvbg)');
    assert.ok(rt.execution.isRunning(parent.id));
    assert.deepEqual(parent.activeMentions, ['worker', 'reviewer'], '转义提及在真实发送路径中授权两个 Harness');
    assert.match(leadPrompt, /create a team member for each assigned Harness/, 'Lead 保留用户指定的跨 Harness 角色分工');
    assert.match(leadPrompt, /untrusted historical data[\s\S]*prior answer/);
    assert.match(leadPrompt, /Recovery checkpoint:[\s\S]*interrupted-fixture \(worker\)[\s\S]*call list_delegations now/);
    assert.equal(rt.collaboration.jobs.get('interrupted-fixture').status, 'interrupted', 'Prompt injection never auto-resumes interrupted work');
    rt.collaboration.jobs.delete('interrupted-fixture');
    assert.ok(!JSON.stringify(rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id)).includes('[Harness Mix collaboration]'), 'Routing guidance stays out of displayed user text');
    const init = await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.ok(init.capabilities.tools);
    const catalog = await transport.request('tools/list', {});
    assert.equal(catalog.tools.length, 16);
    assert.ok(catalog.tools.some(tool => tool.name === 'review_delegation_changes'));
    assert.ok(catalog.tools.some(tool => tool.name === 'apply_delegation_changes'));
    assert.ok(catalog.tools.some(tool => tool.name === 'create_agent_team'));
    assert.ok(catalog.tools.some(tool => tool.name === 'run_team_script'), '编排脚本工具进入 MCP 目录');
    assert.equal(catalog.tools.find(tool => tool.name === 'create_agent_team').inputSchema.properties.members.maxItems, 6, 'A Team supports six specialist members plus its Lead');
    await call('update_agent_plan', { steps: [{ text: 'Develop then review', status: 'in_progress' }] });
    assert.ok(rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id).some(item => item.type === 'plan' && item.entries[0].text === 'Develop then review'));
    const first = JSON.parse((await transport.request('tools/call', { name: 'delegate_to_agent', arguments: { agent_type: 'worker', task: 'one' } })).content[0].text);
    const second = await call('delegate_to_agent', { agent_type: 'worker', task: 'two', isolation: 'shared' });
    await wait(() => pending.size === 2);
    assert.equal(maximum, 2, 'Workers execute concurrently');
    const jobs = [...rt.collaboration.jobs.values()];
    for (const job of jobs) {
      const child = rt.threads.find(t => t.id === job.childId);
      assert.equal(child.parentThreadId, parent.id);
      assert.equal(child.cwd, root, 'Default worker shares the lead workspace');
      const assistant = child.messages.find(m => m.role === 'assistant');
      assert.equal(assistant.reviewId, undefined);
      assert.equal(assistant.reviewOwnerThreadId, parent.id);
    }
    const waitingChild = rt.threads.find(t => t.id === jobs[0].childId);
    waitingChild && pending.get(waitingChild.id).s.emit({ kind: 'approval', requestId: 'native-approval', method: 'confirm', title: 'Allow test?' });
    assert.equal(rt.collaboration.view(jobs[0]).display_status, 'waiting_approval');
    await wait(() => rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id).some(item => item.type === 'tool_call' && String(item.output).includes('waiting_approval')));
    pending.get(jobs[0].childId).s.emit({ kind: 'interaction-responded', requestId: 'native-approval' });
    finish(jobs[0].childId, 'first-result');
    await wait(() => jobs[0].status === 'completed');
    const before = Date.now();
    const partial = await call('get_delegation_status', { task_ids: [first.task_id, second.task_id], wait_ms: 3000 });
    assert.equal(partial[1].status, 'running');
    assert.ok(Date.now() - before < 1000, 'Fan-out collection returns when any result is ready');
    finish(jobs[1].childId, 'second-result');
    await wait(() => jobs[1].status === 'completed');
    const results = await call('get_delegation_status', { task_ids: [first.task_id, second.task_id], wait_ms: 3000 });
    assert.deepEqual(results.map(r => r.status), ['completed', 'completed']);
    assert.deepEqual(results.map(r => r.result), ['first-result', 'second-result']);
    const cards = rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id).filter(item => item.collaboration);
    const { projectItem } = require('../src/main/native/protocol');
    const spawnCard = cards.find(item => item.collaboration.operation === 'spawnAgent' && item.collaboration.task_id === jobs[0].id);
    const workCard = cards.find(item => item.collaboration.operation === 'sendInput' && item.collaboration.task_id === jobs[0].id);
    assert.ok(spawnCard && workCard, 'Delegation projects separate spawn and execution cards');
    assert.equal(projectItem(spawnCard).type, 'collabAgentToolCall');
    assert.equal(projectItem(spawnCard).status, 'completed', 'Spawn card settles once the agent session exists (no stuck 创建中)');
    assert.deepEqual(projectItem(spawnCard).receiverThreadIds, [jobs[0].childId]);
    assert.equal(projectItem(workCard).status, 'completed');
    assert.equal(projectItem(workCard).agentsStates[jobs[0].childId].message, 'first-result');
    assert.ok(rt.execution.isRunning(parent.id), 'Tool results do not end the native lead turn');
    await call('message_agent', { task_id: first.task_id, task: 'follow-up' });
    await wait(() => pending.size === 1);
    finish(jobs[0].childId, 'follow-up-result');
    assert.equal((await call('get_delegation_status', { task_ids: [first.task_id], wait_ms: 3000 }))[0].result, 'follow-up-result');
  // 回归：apply 的同目录并发守卫不得把正在等待 MCP 工具结果的 lead 回合自身计为并发
  // （此前条件恒真，apply_delegation_changes 不可能成功）；第三方会话占用同目录时仍必须拦截。
  rt.collaboration.jobs.set('apply-guard-job', { id: 'apply-guard-job', owner: parent.id, agent: 'worker', status: 'completed',
    workspace: { mode: 'worktree', cwd: path.join(root, 'guard-wt'), root: path.join(root, 'guard-wt'), source: root, branch: 'guard', baseTree: 't', baseCommit: 'c' } });
  await assert.rejects(rt.collaboration.apply('apply-guard-job', '0'.repeat(64)),
    error => !/结算后再应用/.test(error.message), '运行中的 lead 自身不得触发同目录并发守卫');
  const guardIntruder = await rt.createThread({ harnessId: 'worker', cwd: root });
  const intruderTurn = rt.send(guardIntruder.id, '占用目录');
  await wait(() => rt.execution.isRunning(guardIntruder.id));
  await assert.rejects(rt.collaboration.apply('apply-guard-job', '0'.repeat(64)), /结算后再应用/, '第三方同目录运行会话仍被守卫拦截');
  await rt.cancel(guardIntruder.id);
  await intruderTurn;
    const team = await call('create_agent_team', { name: 'Release team', goal: 'Ship a verified change', members: [{ name: 'Builder', role: 'Implement and coordinate', agent_type: 'worker' }, { name: 'Reviewer', role: 'Independently verify', agent_type: 'reviewer' }, { name: 'Frontend', role: 'Integrate the native UI', agent_type: 'worker' }, { name: 'QA', role: 'Run the regression matrix', agent_type: 'reviewer' }, { name: 'Docs', role: 'Document the delivery', agent_type: 'worker' }, { name: 'Release', role: 'Verify Git and final Diff', agent_type: 'reviewer' }] });
    assert.equal(team.lead.agent, 'lead');
    assert.match(team.lead.role, /Lead/);
    assert.equal(team.members.length, 6);
    const teamTask = (await call('assign_team_task', { team_id: team.team_id, title: 'Build', description: 'Implement the change', assignee: team.members[0].id })).task;
    const dependentAssign = await call('assign_team_task', { team_id: team.team_id, title: 'Verify', description: 'Verify the result', assignee: team.members[1].id, depends_on: [teamTask.id] });
    const dependent = dependentAssign.task;
    assert.equal(dependent.status, 'blocked');
    assert.equal(dependentAssign.team.phase, 'waiting', 'Assigned work with nothing in flight reads as waiting');
    assert.deepEqual(dependentAssign.team.progress, { total: 2, pending: 1, blocked: 1, in_progress: 0, completed: 0, failed: 0, interrupted: 0, percent: 0 });
    assert.equal(dependentAssign.team.tasks.find(entry => entry.id === dependent.id).depth, 1, 'Dependent task sits one dependency lane deep');
    assert.equal(dependentAssign.team.tasks.find(entry => entry.id === teamTask.id).depth, 0);
    const teamJob = await call('delegate_to_agent', { agent_type: 'worker', task: 'Implement as Builder', team_id: team.team_id, member_id: team.members[0].id, team_task_id: teamTask.id, isolation: 'shared' });
    await wait(() => pending.size === 1 && teamConnection);
    const teammateTransport = new JsonlProcess(teamConnection.command, teamConnection.args, { env: { ...process.env, ...teamConnection.env } }, {});
    await teammateTransport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'teammate-test', version: '1' } });
    const teammateState = JSON.parse((await teammateTransport.request('tools/call', { name: 'get_team_state', arguments: { team_id: team.team_id } })).content[0].text);
    assert.equal(teammateState.members[0].display_status, 'working');
    assert.equal(teammateState.phase, 'running', 'In-flight work reads as running');
    assert.equal(teammateState.progress.in_progress, 1);
    await teammateTransport.request('tools/call', { name: 'send_team_message', arguments: { team_id: team.team_id, to: 'lead', task_id: teamTask.id, kind: 'review-request', message: 'Implementation is ready for verification.' } });
    await assert.rejects(rt.collaboration.call(parent.id, 'send_team_message', { team_id: team.team_id, to: 'lead', message: 'bad kind', kind: 'bogus' }), /invalid_value|Invalid/, 'Message kind is a closed enum');
    const teamChild = rt.collaboration.jobs.get(teamJob.task_id).childId;
    await assert.rejects(rt.collaboration.call(teamChild, 'assign_team_task', { team_id: team.team_id, title: 'Escalate', description: 'Must be lead-owned', assignee: team.members[0].id }), /Only the Team Lead/);
    await assert.rejects(rt.collaboration.call(teamChild, 'delegate_to_agent', { agent_type: 'worker', task: 'recursive' }), /Only lead/);
    finish(teamChild, 'team-result');
    await wait(() => rt.collaboration.jobs.get(teamJob.task_id).status === 'completed');
    const settledTeam = await call('get_team_state', { team_id: team.team_id });
    assert.equal(settledTeam.tasks.find(entry => entry.id === teamTask.id).status, 'completed');
    assert.equal(settledTeam.tasks.find(entry => entry.id === dependent.id).status, 'pending');
    assert.equal(settledTeam.messages[0].fromName, 'Builder');
    assert.equal(settledTeam.messages[0].kind, 'review-request', 'Mailbox messages keep their typed kind');
    assert.equal(settledTeam.phase, 'waiting', 'Build settled but dependent review is not delegated yet');
    assert.equal(settledTeam.progress.completed, 1);
    assert.equal(settledTeam.members[0].child_thread_id ?? settledTeam.members[0].childId, teamChild);
    const verifyJob = await call('delegate_to_agent', { agent_type: 'reviewer', task: 'Verify independently as Reviewer', team_id: team.team_id, member_id: team.members[1].id, team_task_id: dependent.id, isolation: 'shared' });
    await wait(() => rt.collaboration.jobs.get(verifyJob.task_id).childId && pending.has(rt.collaboration.jobs.get(verifyJob.task_id).childId));
    const reviewerChild = rt.collaboration.jobs.get(verifyJob.task_id).childId;
    assert.notEqual(reviewerChild, teamChild, 'Different Harness teammates own different native sessions');
    finish(reviewerChild, 'verification-result');
    await wait(() => rt.collaboration.jobs.get(verifyJob.task_id).status === 'completed');
    const polish = (await call('assign_team_task', { team_id: team.team_id, title: 'Polish', description: 'Address final details', assignee: team.members[0].id, depends_on: [dependent.id] })).task;
    const polishJob = await call('delegate_to_agent', { agent_type: 'worker', task: 'Polish in the persistent Builder session', team_id: team.team_id, member_id: team.members[0].id, team_task_id: polish.id, isolation: 'worktree' });
    assert.equal(polishJob.child_thread_id, teamChild, 'A teammate keeps one native session across team tasks');
    assert.equal(polishJob.workspace.cwd, rt.collaboration.jobs.get(teamJob.task_id).workspace.cwd, 'A teammate keeps its existing workspace across team tasks');
    await wait(() => pending.has(teamChild));
    finish(teamChild, 'polish-result');
    await wait(() => rt.collaboration.jobs.get(polishJob.task_id).status === 'completed');
    const inspectedTeam = await rt.collaboration.inspectTeam(parent.id, team.team_id);
    assert.equal(inspectedTeam.team.team_id, team.team_id);
    assert.equal(inspectedTeam.team.phase, 'completed', 'All team tasks settled');
    assert.equal(inspectedTeam.team.progress.percent, 100);
    assert.ok(inspectedTeam.snapshots.length >= 8, 'Team lifecycle is preserved as replayable snapshots');
    assert.ok(inspectedTeam.snapshots.some(entry => entry.action === 'member_session_ready'));
    assert.ok(inspectedTeam.snapshots.some(entry => entry.action === 'task_settled'));
    assert.equal((await rt.collaboration.inspectTeam(teamChild, team.team_id)).team.team_id, team.team_id, 'Members may inspect their own shared team state');
    const { NativeProtocol } = require('../src/main/native/protocol');
    const protocolTeam = await new NativeProtocol(rt, () => {}).request('harnessmix/thread/team/inspect', { threadId: parent.id, teamId: team.team_id });
    assert.equal(protocolTeam.snapshots.at(-1).team.team_id, team.team_id, 'Renderer protocol exposes the persisted Team timeline');
    await rt.collaboration.saveTeams();
    const persistedTeams = JSON.parse(await fs.readFile(path.join(root, 'data', 'collaboration', 'teams.json'), 'utf8'));
    assert.equal(persistedTeams[0].id, team.team_id);
    assert.equal(persistedTeams[0].history.length, inspectedTeam.snapshots.length);
    teammateTransport.stop();
    await assert.rejects(call('get_delegation_status', { task_ids: ['foreign-task'] }), /Unknown task/);
    await assert.rejects(rt.collaboration.call(jobs[0].childId, 'delegate_to_agent', { agent_type: 'worker', task: 'recursive' }), /Only lead/);
    await assert.rejects(call('delegate_to_agent', { agent_type: 'worker', task: 'x', unexpected: true }));
    const savedMentions = parent.activeMentions;
    delete parent.activeMentions;
    await assert.rejects(call('delegate_to_agent', { agent_type: 'worker', task: 'unauthorized' }), /用户本轮未显式委派/);
    parent.activeMentions = savedMentions;
    const denied = await fetch(ownerConnection.env.HARNESS_MIX_COLLAB_URL, { method: 'POST', headers: { Authorization: 'Bearer invalid' }, body: '{}' });
    assert.equal(denied.status, 403);
    const outsider = await rt.createThread({ harnessId: 'worker', cwd: root });
    await assert.rejects(rt.collaboration.inspectTeam(outsider.id, team.team_id), /not a team participant/);
    const noTeam = await rt.collaboration.inspectTeam(outsider.id);
    assert.equal(noTeam.team, null, 'Inspecting a non-team thread without a teamId answers benignly');
    assert.deepEqual(noTeam.snapshots, []);
    await rt.send(outsider.id, 'unrelated');
    assert.equal(outsider.messages.at(-1).concurrent, true, 'Independent same-workspace turns are marked concurrent');
    await rt.cancel(outsider.id); await wait(() => !pending.has(outsider.id));
    for (let i = 0; i < 6; i++) await call('delegate_to_agent', { agent_type: 'worker', task: 'cancel me', isolation: 'shared' });
    await wait(() => pending.size === 6);
    await assert.rejects(call('delegate_to_agent', { agent_type: 'worker', task: 'too many' }), /six concurrent/);
    await rt.cancel(parent.id);
    await wait(() => !pending.size);
    assert.equal(rt.execution.lastTurn(parent.id).status, 'cancelled');
    await assert.rejects(call('list_agents', {}), /no longer active/);

    // Settings → Collaboration 开关：默认开启；关闭后服务端硬拒绝，并持久化到磁盘
    const prefsRoot = await fs.mkdtemp(path.resolve('output/collaboration-prefs-'));
    const prefsRt = new HostRuntime({ dataDirectory: path.join(prefsRoot, 'data') });
    try {
      await prefsRt.collaboration.initialize();
      assert.deepEqual(prefsRt.collaboration.getPreferences(), { collaboration: true, agentTeam: true }, 'Both collaboration switches default to on');
      await prefsRt.collaboration.setPreferences({ collaboration: false });
      await assert.rejects(prefsRt.collaboration.call('any-thread', 'list_agents', {}), /停用.*disabled/, 'Collaboration tools are hard-rejected while the switch is off');
      await prefsRt.collaboration.setPreferences({ collaboration: true, agentTeam: false });
      await assert.rejects(
        prefsRt.collaboration.call('any-thread', 'create_agent_team', { name: 't', goal: 'g', members: [{ name: 'A', role: 'r', agent_type: 'worker' }] }),
        /Agent Team 已在设置中停用/,
        'create_agent_team is rejected while the Agent Team switch is off, before any turn-state check',
      );
      const reloaded = new HostRuntime({ dataDirectory: path.join(prefsRoot, 'data') });
      await reloaded.collaboration.initialize();
      assert.deepEqual(reloaded.collaboration.getPreferences(), { collaboration: true, agentTeam: false }, 'Preferences survive a Host restart');
      await reloaded.close();
      const onAgain = await prefsRt.collaboration.setPreferences({ agentTeam: true });
      assert.deepEqual(onAgain, { collaboration: true, agentTeam: true });
    } finally { await prefsRt.close(); }

    // 上一段已取消 lead 回合：先开一个新的运行中回合再驱动后续回归
    await rt.send(parent.id, '#worker 继续回归验证');

    // 回归：用户在 UI 直接停止 worker 线程（= runtime.cancel）不得把团队任务永久卡在
    // in_progress——此前 runtime.cancel 直改 job 状态、绕过团队簿记，该成员从此无法
    // 再被委派（delegate_to_agent 以 already running 拒绝）
    const stopTeam = await call('create_agent_team', { name: 'Stop team', goal: 'Survive direct worker stops', members: [{ name: 'Runner', role: 'Run until stopped', agent_type: 'worker' }] });
    const stopTask = (await call('assign_team_task', { team_id: stopTeam.team_id, title: 'Run', description: 'Run until stopped', assignee: stopTeam.members[0].id })).task;
    const stopJob = await call('delegate_to_agent', { agent_type: 'worker', task: 'run', team_id: stopTeam.team_id, member_id: stopTeam.members[0].id, team_task_id: stopTask.id, isolation: 'shared' });
    await wait(() => { const child = rt.collaboration.jobs.get(stopJob.task_id).childId; return child && pending.has(child); });
    const stopChild = rt.collaboration.jobs.get(stopJob.task_id).childId;
    await rt.cancel(stopChild);
    const stopTeamObj = rt.collaboration.teams.get(stopTeam.team_id);
    await wait(() => stopTeamObj.tasks.find(t => t.id === stopTask.id).status === 'pending');
    assert.equal(stopTeamObj.members.find(m => m.id === stopTeam.members[0].id).status, 'ready', '直接停止 worker 后成员回到 ready');
    const rerunJob = await call('delegate_to_agent', { agent_type: 'worker', task: 'run again', team_id: stopTeam.team_id, member_id: stopTeam.members[0].id, team_task_id: stopTask.id, isolation: 'shared' });
    await wait(() => pending.has(rt.collaboration.jobs.get(rerunJob.task_id).childId));
    finish(rt.collaboration.jobs.get(rerunJob.task_id).childId, 'rerun-result');
    await wait(() => rt.collaboration.jobs.get(rerunJob.task_id).status === 'completed');
    assert.equal(rt.collaboration.teams.get(stopTeam.team_id).tasks.find(t => t.id === stopTask.id).status, 'completed', '同一任务在直接停止后可被重新委派并完成');

    // 回归：子会话线程被删除后，后续输入回落新建替代会话——此前抛
    // 'Native child history is missing' 使该作业永久报废
    const goneJob = await call('delegate_to_agent', { agent_type: 'worker', task: 'original work', isolation: 'shared' });
    await wait(() => { const child = rt.collaboration.jobs.get(goneJob.task_id).childId; return child && pending.has(child); });
    const goneChild = rt.collaboration.jobs.get(goneJob.task_id).childId;
    finish(goneChild, 'original-result');
    await wait(() => rt.collaboration.jobs.get(goneJob.task_id).status === 'completed');
    await rt.removeThread(goneChild);
    assert.equal(rt.collaboration.jobs.get(goneJob.task_id).childId, goneChild, '删除线程不抹掉作业的会话记录');
    await call('message_agent', { task_id: goneJob.task_id, task: 'continue in a replacement session' });
    await wait(() => {
      const revivedChild = rt.collaboration.jobs.get(goneJob.task_id).childId;
      return revivedChild && revivedChild !== goneChild && pending.has(revivedChild);
    });
    finish(rt.collaboration.jobs.get(goneJob.task_id).childId, 'replacement-result');
    await wait(() => rt.collaboration.jobs.get(goneJob.task_id).status === 'completed');
    assert.equal((await call('get_delegation_status', { task_ids: [goneJob.task_id], wait_ms: 0 }))[0].result, 'replacement-result', '替代会话产出可被正常收集');

    // 回归：委派超时必须落 failed+error——此前先 cancel 子线程再抛错，runtime.cancel 的
    // 直改把作业标成 cancelled，catch 的记录分支（仅认 running）吞掉了超时错误
    const timeoutRoot = await fs.mkdtemp(path.resolve('output/collaboration-timeout-'));
    const timeoutRt = new HostRuntime({ dataDirectory: path.join(timeoutRoot, 'data'), delegationTimeoutMs: 150 });
    try {
      await timeoutRt.store.load();
      const tLead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
        async open(input) { return { emit: input.emit, collaborationEnabled: true }; }, async send() {}, async cancel() {}, async close() {} };
      const tWorker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
        async open(input) { return { id: input.thread.id, emit: input.emit }; },
        async send(s) { tPending.set(s.id, s); }, async cancel() {}, async close() {} };
      const tPending = new Map();
      timeoutRt.adapters.set('lead', tLead); timeoutRt.status.lead = { available: true };
      timeoutRt.adapters.set('worker', tWorker); timeoutRt.status.worker = { available: true };
      const tParent = await timeoutRt.createThread({ harnessId: 'lead', cwd: timeoutRoot });
      await timeoutRt.send(tParent.id, '#worker stuck');
      const tJob = await timeoutRt.collaboration.call(tParent.id, 'delegate_to_agent', { agent_type: 'worker', task: 'never settles', isolation: 'shared' });
      await wait(() => timeoutRt.collaboration.jobs.get(tJob.task_id).status === 'failed');
      const failedJob = timeoutRt.collaboration.jobs.get(tJob.task_id);
      assert.match(failedJob.error, /timed out/, '超时错误被记录');
      assert.notEqual(failedJob.status, 'cancelled', '超时不得误报为已取消');
    } finally { await timeoutRt.close(); }

    // 同目录外部并发（另一个独立会话正在运行）→ 用户收到 toast 警告，
    // 且新委派的 worker 默认升级为隔离模式（auto）；非 Git 目录下 auto 回落 shared。
    // 用系统临时目录：output/ 位于本仓库内，auto 在仓库内会真实创建 worktree。
    const isoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-iso-'));
    const isoRt = new HostRuntime({ dataDirectory: path.join(isoRoot, 'data') });
    try {
      await isoRt.store.load();
      const isoToasts = [];
      isoRt.subscribe(event => { if (event.type === 'toast') isoToasts.push(event); });
      const isoPending = new Map();
      const isoLead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
        async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
        async send() {}, async cancel() {}, async close() {} };
      const isoWorker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
        async open(input) { return { id: input.thread.id, emit: input.emit, collaborationEnabled: !!input.collaboration }; },
        async send(s) { isoPending.set(s.id, s); }, async cancel() {}, async close() {} };
      isoRt.adapters.set('lead', isoLead); isoRt.status.lead = { available: true };
      isoRt.adapters.set('worker', isoWorker); isoRt.status.worker = { available: true };
      const isoParent = await isoRt.createThread({ harnessId: 'lead', cwd: isoRoot });
      await isoRt.send(isoParent.id, '#worker build something');
      const isoOutsider = await isoRt.createThread({ harnessId: 'worker', cwd: isoRoot });
      await isoRt.send(isoOutsider.id, 'other session');
      await wait(() => isoPending.has(isoOutsider.id));
      assert.equal(isoOutsider.messages.at(-1).concurrent, true, 'Concurrent turn is still marked');
      assert.ok(isoToasts.some(t => t.threadId === isoOutsider.id && /同一目录/.test(t.text)), 'Concurrent same-directory sessions warn the user');
      const isoJob = await isoRt.collaboration.call(isoParent.id, 'delegate_to_agent', { agent_type: 'worker', task: 'auto-isolated under concurrency' });
      assert.equal(isoRt.collaboration.jobs.get(isoJob.task_id).isolation, 'auto', 'A new worker defaults to isolated mode while another session runs in the same directory');
      await wait(() => isoRt.collaboration.jobs.get(isoJob.task_id).workspace);
      assert.equal(isoRt.collaboration.jobs.get(isoJob.task_id).workspace.mode, 'shared', 'Auto falls back to shared outside Git projects');
      await isoRt.cancel(isoOutsider.id);
      const quietJob = await isoRt.collaboration.call(isoParent.id, 'delegate_to_agent', { agent_type: 'worker', task: 'shared again once quiet' });
      assert.equal(isoRt.collaboration.jobs.get(quietJob.task_id).isolation, 'shared', 'Default returns to shared once the directory is quiet');
    } finally { await isoRt.close(); }

    // 看板用户操作面（Phase 1）：取消/改派/消息/继续协作。取消与消息任意时刻可执行；
    // 改派与继续协作要求 lead 空闲，由 Host 向 lead 线程注入指令回合实现——指令自带
    // 目标成员的 #提及，走与用户手打提及完全相同的授权路径。
    const uaRoot = await fs.mkdtemp(path.resolve('output/collaboration-user-action-'));
    const uaRt = new HostRuntime({ dataDirectory: path.join(uaRoot, 'data') });
    try {
      await uaRt.store.load();
      let uaLeadPrompt = '';
      const uaPending = new Map();
      const uaLead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
        async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
        async send(s, text) { uaLeadPrompt = text; }, async cancel() {}, async close() {} };
      const uaWorker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
        async open(input) { return { id: input.thread.id, emit: input.emit, collaborationEnabled: !!input.collaboration }; },
        async send(s, text) { uaPending.set(s.id, { s, text }); }, async cancel(s) { uaPending.delete(s.id); }, async close() {} };
      const uaReviewer = { ...uaWorker, manifest: { id: 'reviewer', name: 'Reviewer', capabilities: { collaborationTools: true } } };
      uaRt.adapters.set('lead', uaLead); uaRt.status.lead = { available: true };
      uaRt.adapters.set('worker', uaWorker); uaRt.status.worker = { available: true };
      uaRt.adapters.set('reviewer', uaReviewer); uaRt.status.reviewer = { available: true };
      const uaParent = await uaRt.createThread({ harnessId: 'lead', cwd: uaRoot });
      const uaCall = (name, args) => uaRt.collaboration.call(uaParent.id, name, args);
      await uaRt.send(uaParent.id, '#worker #reviewer 修复发布阻塞');
      const uaTeam = await uaCall('create_agent_team', { name: 'User-action team', goal: 'Exercise board actions', members: [{ name: 'Builder', role: 'Implement', agent_type: 'worker' }, { name: 'Checker', role: 'Verify', agent_type: 'reviewer' }] });
      const uaTask = (await uaCall('assign_team_task', { team_id: uaTeam.team_id, title: 'Fix', description: 'Make it pass', assignee: uaTeam.members[0].id })).task;
      const uaJob = await uaCall('delegate_to_agent', { agent_type: 'worker', task: 'fix it', team_id: uaTeam.team_id, member_id: uaTeam.members[0].id, team_task_id: uaTask.id, isolation: 'shared' });
      await wait(() => { const child = uaRt.collaboration.jobs.get(uaJob.task_id).childId; return child && uaPending.has(child); });
      const uaBuilderChild = uaRt.collaboration.jobs.get(uaJob.task_id).childId;

      // 授权边界：成员线程不能执行团队操作；运行中任务必须先取消才能改派
      await assert.rejects(uaRt.collaboration.userAction(uaBuilderChild, 'task/cancel', { teamId: uaTeam.team_id, taskId: uaTask.id }), /仅限主导者线程/);
      await assert.rejects(uaRt.collaboration.userAction(uaParent.id, 'task/reassign', { teamId: uaTeam.team_id, taskId: uaTask.id, memberId: uaTeam.members[1].id }), /不能改派/);
      await assert.rejects(uaRt.collaboration.userAction(uaParent.id, 'bogus', {}), /未知的用户操作/);
      await assert.rejects(uaRt.collaboration.userAction(uaParent.id, 'task/reassign', { teamId: uaTeam.team_id, taskId: 'nope', memberId: uaTeam.members[1].id }), /未知的团队任务/);

      // 取消：lead 运行中也可执行——任务回 pending、成员回 ready
      const uaCancelled = await uaRt.collaboration.userAction(uaParent.id, 'task/cancel', { teamId: uaTeam.team_id, taskId: uaTask.id });
      assert.equal(uaCancelled.tasks.find(entry => entry.id === uaTask.id).status, 'pending');
      assert.equal(uaCancelled.members.find(entry => entry.id === uaTeam.members[0].id).display_status, 'ready');

      // 重派后让子回合以 error 结算 → 任务 failed，供改派使用
      await uaCall('delegate_to_agent', { agent_type: 'worker', task: 'fix it again', team_id: uaTeam.team_id, member_id: uaTeam.members[0].id, team_task_id: uaTask.id, isolation: 'shared' });
      await wait(() => { const child = uaRt.collaboration.jobs.get(uaJob.task_id).childId; return child && uaPending.has(child) && uaRt.execution.isRunning(child); });
      uaPending.get(uaRt.collaboration.jobs.get(uaJob.task_id).childId).s.emit({ kind: 'error', message: 'build broke' });
      await wait(() => uaRt.collaboration.teams.get(uaTeam.team_id).tasks.find(entry => entry.id === uaTask.id).status === 'failed');
      await assert.rejects(uaRt.collaboration.userAction(uaParent.id, 'task/reassign', { teamId: uaTeam.team_id, taskId: uaTask.id, memberId: uaTeam.members[1].id }), /回合进行中/, 'lead 回合运行中不能改派');

      // 改派：lead 空闲时执行——任务重置 pending、assignee 切换、指令回合注入 lead
      await uaRt.cancel(uaParent.id);
      await wait(() => !uaRt.execution.isRunning(uaParent.id));
      const uaReassigned = await uaRt.collaboration.userAction(uaParent.id, 'task/reassign', { teamId: uaTeam.team_id, taskId: uaTask.id, memberId: uaTeam.members[1].id, note: '换人重做' });
      const uaReassignedTask = uaReassigned.tasks.find(entry => entry.id === uaTask.id);
      assert.equal(uaReassignedTask.status, 'pending');
      assert.equal(uaReassignedTask.assignee, uaTeam.members[1].id);
      assert.equal(uaReassignedTask.reassignedFrom, uaTeam.members[0].id, '改派保留原负责人痕迹');
      await wait(() => uaLeadPrompt.includes('用户改派'));
      assert.match(uaLeadPrompt, /#reviewer/, '改派指令自带目标成员的 #提及，走同一授权路径');
      assert.match(uaLeadPrompt, /换人重做/);
      await wait(() => uaRt.execution.isRunning(uaParent.id));
      assert.deepEqual(uaParent.activeMentions, ['reviewer'], '指令回合重算 activeMentions');
      // lead 依指令重新派发：授权门放行，成员绑定成立
      const uaRedone = await uaCall('delegate_to_agent', { agent_type: 'reviewer', task: 'redo as Checker', team_id: uaTeam.team_id, member_id: uaTeam.members[1].id, team_task_id: uaTask.id, isolation: 'shared' });
      await wait(() => { const child = uaRt.collaboration.jobs.get(uaRedone.task_id).childId; return child && uaPending.has(child); });
      uaPending.get(uaRt.collaboration.jobs.get(uaRedone.task_id).childId).s.emit({ kind: 'text-delta', text: 'redone' });
      uaPending.get(uaRt.collaboration.jobs.get(uaRedone.task_id).childId).s.emit({ kind: 'completed', finalAnswer: true });
      await wait(() => uaRt.collaboration.teams.get(uaTeam.team_id).tasks.find(entry => entry.id === uaTask.id).status === 'completed');

      // 消息：以 lead 身份直发；空闲收件人经原生会话直达
      const uaMessaged = await uaRt.collaboration.userAction(uaParent.id, 'message/send', { teamId: uaTeam.team_id, to: uaTeam.members[0].name, message: 'user note' });
      assert.equal(uaMessaged.team.messages.at(-1).from, 'lead');
      assert.equal(uaMessaged.team.messages.at(-1).body, 'user note');
      await wait(() => uaRt.collaboration.teams.get(uaTeam.team_id).messages.at(-1).delivery === 'native_session');
      // 直投为 Builder 开启了一个真实子回合：结算它，成员回到空闲，供下面的降级路径复用
      await wait(() => uaPending.has(uaBuilderChild));
      uaPending.get(uaBuilderChild).s.emit({ kind: 'text-delta', text: 'noted' });
      uaPending.get(uaBuilderChild).s.emit({ kind: 'completed', finalAnswer: true });
      await wait(() => !uaRt.execution.isRunning(uaBuilderChild));
      await assert.rejects(uaRt.collaboration.userAction(uaParent.id, 'message/send', { teamId: uaTeam.team_id, to: uaTeam.members[0].id, message: 'x', kind: 'bogus' }), /未知的消息类型/);

      // 继续协作：generic 与指定 taskId 两种指令；非中断任务拒绝
      uaRt.collaboration.jobs.set('ua-interrupted', { id: 'ua-interrupted', owner: uaParent.id, agent: 'worker', childId: 'gone', status: 'interrupted' });
      await assert.rejects(uaRt.collaboration.userAction(uaParent.id, 'continue', { taskId: uaRedone.task_id }), /仅中断的委派/);
      await uaRt.cancel(uaParent.id);
      await wait(() => !uaRt.execution.isRunning(uaParent.id));
      const uaContinued = await uaRt.collaboration.userAction(uaParent.id, 'continue', {});
      assert.equal(uaContinued.dispatched, true);
      assert.deepEqual(uaContinued.interrupted.map(job => job.task_id), ['ua-interrupted']);
      await wait(() => uaLeadPrompt.includes('继续之前中断的协作'));
      assert.match(uaLeadPrompt, /#worker/, '继续协作指令带中断作业的 #提及');
      await uaRt.cancel(uaParent.id);
      await wait(() => !uaRt.execution.isRunning(uaParent.id));
      await uaRt.collaboration.userAction(uaParent.id, 'continue', { taskId: 'ua-interrupted' });
      await wait(() => uaLeadPrompt.includes('恢复中断的委派 ua-interrupted'));

      // Renderer 协议面：方法经 NativeProtocol → collaboration.userAction
      await uaRt.cancel(uaParent.id);
      await wait(() => !uaRt.execution.isRunning(uaParent.id));
      const { NativeProtocol } = require('../src/main/native/protocol');
      const protoTeam = await new NativeProtocol(uaRt, () => {}).request('harnessmix/thread/team/message/send', { threadId: uaParent.id, teamId: uaTeam.team_id, to: uaTeam.members[0].name, message: 'via protocol' });
      assert.equal(protoTeam.team.messages.at(-1).body, 'via protocol', 'Protocol 方法触达 userAction');
      await wait(() => { const message = uaRt.collaboration.teams.get(uaTeam.team_id).messages.at(-1); return message.delivery === 'mailbox' && message.deliveryError; }, 'lead 空闲时直投降级回邮箱并记录原因');
      await assert.rejects(new NativeProtocol(uaRt, () => {}).request('harnessmix/thread/team/task/reassign', { threadId: uaParent.id, teamId: uaTeam.team_id, taskId: uaTask.id, memberId: uaTeam.members[0].id }), /已完成的任务不能改派/);
      // 用户插入任务直接写入持久任务图；已完成依赖应立即成为 pending。
      const uaProto = new NativeProtocol(uaRt, () => {});
      const inserted = await uaProto.request('harnessmix/thread/team/task/insert', { threadId: uaParent.id, teamId: uaTeam.team_id, title: 'Final review', description: 'Review finished work', memberId: uaTeam.members[1].id, dependsOn: [uaTask.id] });
      assert.equal(inserted.task.status, 'pending');
      assert.equal(inserted.task.assignee, uaTeam.members[1].id);
      assert.deepEqual(inserted.task.dependsOn, [uaTask.id]);
      await assert.rejects(uaProto.request('harnessmix/thread/team/task/insert', { threadId: uaParent.id, teamId: uaTeam.team_id, title: 'Bad', description: 'Bad dependency', memberId: uaTeam.members[1].id, dependsOn: ['missing'] }), /依赖任务/);
      const continuedTeam = await uaProto.request('harnessmix/thread/collaboration/continue', { threadId: uaParent.id, teamId: uaTeam.team_id });
      assert.deepEqual(continuedTeam.pending, [inserted.task.id]);
      await wait(() => uaLeadPrompt.includes(`team_id=${uaTeam.team_id}`) && uaLeadPrompt.includes('Final review') === false && uaRt.execution.isRunning(uaParent.id));
      assert.match(uaLeadPrompt, /#reviewer/);
      const insertedJob = await uaCall('delegate_to_agent', { agent_type: 'reviewer', task: 'Final review', team_id: uaTeam.team_id, member_id: uaTeam.members[1].id, team_task_id: inserted.task.id, isolation: 'shared' });
      await wait(() => { const child = uaRt.collaboration.jobs.get(insertedJob.task_id).childId; return child && uaPending.has(child) && uaRt.execution.isRunning(child); });
      await uaProto.request('harnessmix/thread/team/interrupt', { threadId: uaParent.id, teamId: uaTeam.team_id });
      await wait(() => uaRt.collaboration.jobs.get(insertedJob.task_id).status === 'interrupted');
      assert.equal(uaRt.collaboration.teams.get(uaTeam.team_id).tasks.find(entry => entry.id === inserted.task.id).status, 'interrupted');
      assert.equal(uaRt.collaboration.teams.get(uaTeam.team_id).members.find(entry => entry.id === uaTeam.members[1].id).status, 'interrupted');
      const resumedTeam = await uaProto.request('harnessmix/thread/collaboration/continue', { threadId: uaParent.id, teamId: uaTeam.team_id });
      assert.deepEqual(resumedTeam.interrupted.map(job => job.task_id), [insertedJob.task_id]);
      await wait(() => uaRt.execution.isRunning(uaParent.id));
      await uaProto.request('turn/interrupt', { threadId: uaParent.id });
      assert.equal(uaRt.execution.isRunning(uaParent.id), false, '原生停止按钮协议可结算团队 Lead 回合');
    } finally { await uaRt.close(); }

    // Phase 2 失败处理：retry 预算自动重派（同一成员，复用会话与工作区，附上次失败
    // 原因）；任务失败必达 lead 邮箱的 system 通知；用户主动取消不算失败、不通知。
    const r2Root = await fs.mkdtemp(path.resolve('output/collaboration-retry-'));
    const r2Rt = new HostRuntime({ dataDirectory: path.join(r2Root, 'data') });
    try {
      await r2Rt.store.load();
      const r2Pending = new Map();
      const r2Sends = [];
      const r2Lead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
        async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
        async send() {}, async cancel() {}, async close() {} };
      const r2Worker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
        async open(input) { return { id: input.thread.id, emit: input.emit, collaborationEnabled: !!input.collaboration }; },
        async send(s, text) { r2Pending.set(s.id, { s, text }); r2Sends.push({ id: s.id, text }); }, async cancel(s) { r2Pending.delete(s.id); }, async close() {} };
      r2Rt.adapters.set('lead', r2Lead); r2Rt.status.lead = { available: true };
      r2Rt.adapters.set('worker', r2Worker); r2Rt.status.worker = { available: true };
      const r2Parent = await r2Rt.createThread({ harnessId: 'lead', cwd: r2Root });
      const r2Call = (name, args) => r2Rt.collaboration.call(r2Parent.id, name, args);
      await r2Rt.send(r2Parent.id, '#worker 重试回归');
      const r2Team = await r2Call('create_agent_team', { name: 'Retry team', goal: 'Failure handling', members: [{ name: 'Builder', role: 'Build', agent_type: 'worker' }] });
      const r2TeamObj = r2Rt.collaboration.teams.get(r2Team.team_id);
      const r2TaskState = task => r2TeamObj.tasks.find(entry => entry.id === task.id);
      const r2Notices = task => r2TeamObj.messages.filter(message => message.from === 'system' && message.taskId === task.id);
      const r2Fail = id => r2Pending.get(id).s.emit({ kind: 'error', message: 'flaky build' });
      const r2Ok = (id, text) => { const entry = r2Pending.get(id); entry.s.emit({ kind: 'text-delta', text }); entry.s.emit({ kind: 'completed', finalAnswer: true }); };
      const r2Delegate = async (task, attempt) => r2Call('delegate_to_agent', { agent_type: 'worker', task: attempt, team_id: r2Team.team_id, member_id: r2Team.members[0].id, team_task_id: task.id, isolation: 'shared' });
      // 等发送记录本身（每场景唯一文本），而不是 r2Pending.has + isRunning：回合注册先于
      // adapter.send 投递（中间有 review 快照/save 等 await），按运行态同步会在「已注册
      // 未投递」窗口提前放行，r2Fail 会结算一个从未投递的回合，计数随即少一
      const r2WaitSent = text => wait(() => r2Sends.some(send => send.text.startsWith(text)));
      const r2WaitTurn = () => wait(() => r2Rt.execution.isRunning(childA));

      // A) retry {max:1}：失败 → system 通知 + 自动重派（附失败原因、复用成员会话）→ 成功
      const taskA = (await r2Call('assign_team_task', { team_id: r2Team.team_id, title: 'A', description: 'retry then pass', assignee: r2Team.members[0].id, retry: { max: 1 } })).task;
      assert.deepEqual(taskA.retry, { max: 1, used: 0 }, '预算持久化在任务上');
      const jobA = await r2Delegate(taskA, 'attempt one A');
      await r2WaitSent('attempt one A');
      const childA = r2Rt.collaboration.jobs.get(jobA.task_id).childId;
      r2Fail(childA);
      await wait(() => r2Sends.filter(send => send.id === childA).length >= 2, '自动重派复用同一成员会话');
      assert.match(r2Sends.find(send => send.id === childA && send.text.includes('Previous attempt failed')).text, /flaky build/, '重派提示词附上次失败原因');
      assert.match(r2Sends.filter(send => send.id === childA).at(-1).text, /persistent teammate/, '重派仍携带团队信封');
      assert.equal(r2Notices(taskA).length, 1);
      assert.match(r2Notices(taskA)[0].body, /失败[\s\S]*第 1\/1 次/, '失败通知先于重派进入 lead 邮箱');
      await r2WaitTurn();
      r2Ok(childA, 'A-fixed');
      await wait(() => r2TaskState(taskA).status === 'completed');
      assert.equal(r2TaskState(taskA).retry.used, 1, '成功后预算停在 1');
      assert.ok(r2TeamObj.history.some(entry => entry.action === 'task_retry'), 'task_retry 入史');

      // B) retry {max:1} 预算耗尽：两次失败后落 failed，两条通知（重试中/已耗尽）
      const taskB = (await r2Call('assign_team_task', { team_id: r2Team.team_id, title: 'B', description: 'always fails', assignee: r2Team.members[0].id, retry: { max: 1 } })).task;
      const baselineB = r2Sends.length;
      const jobB = await r2Delegate(taskB, 'attempt one B');
      await r2WaitSent('attempt one B');
      r2Fail(childA);
      await wait(() => r2Sends.length >= baselineB + 2, '预算内自动重试');
      await r2WaitTurn();
      r2Fail(childA);
      await wait(() => r2TaskState(taskB).status === 'failed');
      assert.equal(r2TaskState(taskB).retry.used, 1, '预算只消耗一次');
      assert.match(r2TaskState(taskB).result, /flaky build/);
      const noticesB = r2Notices(taskB);
      assert.equal(noticesB.length, 2);
      assert.match(noticesB[0].body, /第 1\/1 次/);
      assert.match(noticesB[1].body, /重试预算已耗尽/);
      await wait(() => r2TeamObj.history.some(entry => entry.action === 'task_failed'), '最终失败入史');

      // C) 无预算：单条纯失败通知，不重派
      const taskC = (await r2Call('assign_team_task', { team_id: r2Team.team_id, title: 'C', description: 'no budget', assignee: r2Team.members[0].id })).task;
      assert.equal(taskC.retry, undefined, '未声明 retry 时行为与现状一致');
      const baselineC = r2Sends.length;
      const jobC = await r2Delegate(taskC, 'attempt one C');
      await r2WaitSent('attempt one C');
      r2Fail(childA);
      await wait(() => r2TaskState(taskC).status === 'failed');
      assert.equal(r2Sends.length, baselineC + 1, '无预算不重派');
      assert.equal(r2Notices(taskC).length, 1);
      assert.match(r2Notices(taskC)[0].body, /失败/);
      assert.ok(!/重试/.test(r2Notices(taskC)[0].body), '纯失败通知不带重试字样');

      // schema 边界：retry.max 超界被 zod 拒绝
      await assert.rejects(r2Call('assign_team_task', { team_id: r2Team.team_id, title: 'X', description: 'bad budget', assignee: r2Team.members[0].id, retry: { max: 5 } }));

      // Phase 3：忙碌收件人 queued → 回合边界投递；成员未读计数
      const taskD = (await r2Call('assign_team_task', { team_id: r2Team.team_id, title: 'D', description: 'busy recipient', assignee: r2Team.members[0].id })).task;
      const jobD = await r2Delegate(taskD, 'busy work');
      await r2WaitSent('busy work');
      const msgQ = await r2Call('send_team_message', { team_id: r2Team.team_id, to: r2Team.members[0].name, message: 'while busy' });
      assert.equal(msgQ.message.delivery, 'queued', '忙碌收件人聚合状态为 queued');
      assert.equal(msgQ.message.deliveryBy[r2Team.members[0].id], 'queued');
      assert.equal(msgQ.team.members[0].unread, 1, '未读计数进入 teamView');
      // 结束成员回合：结算路径的投递泵把 queued 消息送进其原生会话
      r2Ok(childA, 'D-done');
      await wait(() => r2TaskState(taskD).status === 'completed');
      await wait(() => r2TeamObj.messages.find(message => message.id === msgQ.message.id).deliveryBy[r2Team.members[0].id] === 'native_session');
      assert.equal((await r2Call('get_team_state', { team_id: r2Team.team_id })).members[0].unread, 0, '送达后未读清零');
      assert.ok(r2Sends.some(send => send.id === childA && send.text.includes('while busy')), '排队消息按 teammate 信封投进原生会话');

      // Phase 3 降级：排队消息在 lead 回合结束时回落邮箱并记录原因。
      // E 的语义就是成员忙（'while busy' 投递回合仍在运行）：任务派发不要求送达
      //（busy 会按重试窗口等待），直接验证消息排队与 lead 结束后的邮箱回落。
      const taskE = (await r2Call('assign_team_task', { team_id: r2Team.team_id, title: 'E', description: 'race the end', assignee: r2Team.members[0].id })).task;
      const jobE = await r2Delegate(taskE, 'busy again');
      const msgE = await r2Call('send_team_message', { team_id: r2Team.team_id, to: r2Team.members[0].name, message: 'race the end' });
      assert.equal(msgE.message.delivery, 'queued');
      await r2Rt.cancel(r2Parent.id);
      await wait(() => {
        const message = r2TeamObj.messages.find(entry => entry.id === msgE.message.id);
        return message.deliveryBy[r2Team.members[0].id] === 'mailbox' && message.deliveryError;
      }, 'lead 结束后排队消息降级回邮箱');

      // Phase 4：apply 附加 advisory 验证（off 策略零配置安全网，不阻断、不改门禁）
      const r4Repo = path.join(r2Root, 'apply-repo');
      await fs.mkdir(r4Repo, { recursive: true });
      await git(r4Repo, ['init', '-q']);
      await git(r4Repo, ['config', 'core.autocrlf', 'false']);
      await fs.writeFile(path.join(r4Repo, 'file.txt'), 'base\n');
      await git(r4Repo, ['add', '.']);
      await git(r4Repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
      const r4Ws = await createWorkspace(r4Repo, 'apply-advisory-job', 'worktree');
      await fs.writeFile(path.join(r4Ws.cwd, 'file.txt'), 'applied\n');
      const r4Rev = await reviewWorkspace(r4Ws);
      const r4Child = await r2Rt.createThread({ harnessId: 'worker', cwd: r4Ws.cwd, title: 'apply advisory child' });
      await r2Rt.send(r4Child.id, 'produce the change');
      await wait(() => r2Pending.has(r4Child.id) && r2Rt.execution.isRunning(r4Child.id));
      r2Ok(r4Child.id, 'done');
      await wait(() => !r2Rt.execution.isRunning(r4Child.id));
      r2Rt.collaboration.jobs.set('apply-advisory-job', { id: 'apply-advisory-job', owner: r2Parent.id, agent: 'worker', childId: r4Child.id, status: 'completed', task: 'apply advisory', workspace: r4Ws });
      const r4Result = await r2Rt.collaboration.apply('apply-advisory-job', r4Rev.digest);
      assert.equal(r4Result.verification.mode, 'advisory', 'apply 结果附带 advisory 验证');
      assert.ok(r4Result.verification.checks.some(check => check.id === 'turnCompleted' && check.status === 'passed'));
      assert.equal(r2Rt.collaboration.jobs.get('apply-advisory-job').verification.status, r4Result.verification.status, 'advisory 结果持久化在作业上');
      assert.equal(r2Rt.verificationGates.inspect(r2Rt.threads.find(t => t.id === r4Child.id)).policy.mode, 'off', 'advisory 不改线程门禁策略');
    } finally { await r2Rt.close(); }

    // Phase 5 中断收尾握手：team/interrupt 级联中断后，Host 给运行中的成员原生会话一次
    // 有界收尾回合——成员自述交接落在作业（handoff）、任务图与 lead 邮箱（kind=handoff），
    // 「继续协作」指令与 resume_delegation 提示词携带交接；任务卡取消不握手；成员不
    // 回复时按超时静默放弃，不改变中断语义。
    const hsRoot = await fs.mkdtemp(path.resolve('output/collaboration-handshake-'));
    const hsRt = new HostRuntime({ dataDirectory: path.join(hsRoot, 'data') });
    try {
      await hsRt.store.load();
      let hsLeadPrompt = '';
      const hsPending = new Map();
      const hsSends = [];
      const hsLead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
        async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
        async send(s, text) { hsLeadPrompt = text; }, async cancel() {}, async close() {} };
      const hsWorker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
        async open(input) { return { id: input.thread.id, emit: input.emit, collaborationEnabled: !!input.collaboration }; },
        async send(s, text) { hsPending.set(s.id, { s, text }); hsSends.push({ id: s.id, text }); }, async cancel(s) { hsPending.delete(s.id); }, async close() {} };
      hsRt.adapters.set('lead', hsLead); hsRt.status.lead = { available: true };
      hsRt.adapters.set('worker', hsWorker); hsRt.status.worker = { available: true };
      const hsParent = await hsRt.createThread({ harnessId: 'lead', cwd: hsRoot });
      const hsCall = (name, args) => hsRt.collaboration.call(hsParent.id, name, args);
      const hsFinish = (id, text) => { const { s } = hsPending.get(id); hsPending.delete(id); s.emit({ kind: 'text-delta', text }); s.emit({ kind: 'completed', finalAnswer: true }); };
      await hsRt.send(hsParent.id, '#worker 握手回归');
      const hsTeam = await hsCall('create_agent_team', { name: 'Handshake team', goal: 'Interrupt with dignity', members: [{ name: 'Builder', role: 'Build', agent_type: 'worker' }] });
      const hsTeamObj = hsRt.collaboration.teams.get(hsTeam.team_id);
      const hsTask = (await hsCall('assign_team_task', { team_id: hsTeam.team_id, title: 'Build', description: 'Long running', assignee: hsTeam.members[0].id })).task;
      const hsJob = await hsCall('delegate_to_agent', { agent_type: 'worker', task: 'long work', team_id: hsTeam.team_id, member_id: hsTeam.members[0].id, team_task_id: hsTask.id, isolation: 'shared' });
      await wait(() => { const child = hsRt.collaboration.jobs.get(hsJob.task_id).childId; return child && hsPending.has(child); });
      const hsChild = hsRt.collaboration.jobs.get(hsJob.task_id).childId;

      // A) 握手成功：中断后成员收到收尾回合，自述交接三处落档
      await hsRt.collaboration.userAction(hsParent.id, 'interrupt', { teamId: hsTeam.team_id });
      await wait(() => hsPending.has(hsChild) && /Agent Team handoff/.test(hsPending.get(hsChild).text));
      assert.match(hsPending.get(hsChild).text, /Do not read or write files/, '收尾回合禁止副作用');
      await wait(() => hsRt.collaboration.jobs.get(hsJob.task_id).status === 'interrupted');
      const hsHandoffText = '已完成：解析模块重构；进行中：导出器适配；阻塞：输出格式待确认；下一步：跑通导出回归。';
      hsFinish(hsChild, hsHandoffText);
      // 以 member_handoff 入史为同步点：job.handoff 赋值与 publishTeam 之间存在 await 窗口
      await wait(() => hsTeamObj.history.some(entry => entry.action === 'member_handoff'));
      assert.equal(hsRt.collaboration.jobs.get(hsJob.task_id).handoff, hsHandoffText);
      assert.equal(hsTeamObj.tasks.find(t => t.id === hsTask.id).handoff, hsHandoffText, '交接写进任务图');
      const hsMail = hsTeamObj.messages.find(m => m.kind === 'handoff' && m.taskId === hsTask.id);
      assert.ok(hsMail && hsMail.to === 'lead' && hsMail.from === hsTeam.members[0].id, '交接以成员身份落入 lead 邮箱');
      assert.ok(hsTeamObj.history.some(entry => entry.action === 'member_handoff'), 'member_handoff 进入回放时间轴');
      assert.equal((await hsRt.collaboration.inspectTeam(hsParent.id, hsTeam.team_id)).team.tasks.find(t => t.id === hsTask.id).handoff, hsHandoffText, '团队检视面可见交接');

      // B) 「继续协作」指令携带交接摘要，供恢复的 Lead 直接引用
      await wait(() => !hsRt.execution.isRunning(hsParent.id));
      const hsContinued = await hsRt.collaboration.userAction(hsParent.id, 'continue', { teamId: hsTeam.team_id });
      assert.equal(hsContinued.dispatched, true);
      await wait(() => hsLeadPrompt.includes('成员交接'));
      assert.match(hsLeadPrompt, /导出回归/, '交接内容进入继续协作指令');

      // C) resume_delegation：恢复提示词附上成员交接（Lead 回合由 continue 指令保持运行）
      await hsRt.collaboration.call(hsParent.id, 'resume_delegation', { task_id: hsJob.task_id });
      await wait(() => hsPending.has(hsChild) && /Worker handoff at interruption/.test(hsPending.get(hsChild).text));
      assert.match(hsPending.get(hsChild).text, /输出格式待确认/, '恢复提示词引用成员自述');
      hsFinish(hsChild, 'resumed and done');
      await wait(() => hsRt.collaboration.jobs.get(hsJob.task_id).status === 'completed');

      // D) 任务卡取消（task/cancel）不触发握手：语义是放弃，不是中断待恢复
      const hsTask2 = (await hsCall('assign_team_task', { team_id: hsTeam.team_id, title: 'Cancel me', description: 'Plain cancel', assignee: hsTeam.members[0].id })).task;
      const hsJob2 = await hsCall('delegate_to_agent', { agent_type: 'worker', task: 'work two', team_id: hsTeam.team_id, member_id: hsTeam.members[0].id, team_task_id: hsTask2.id, isolation: 'shared' });
      await wait(() => { const child = hsRt.collaboration.jobs.get(hsJob2.task_id).childId; return child && hsPending.has(child); });
      const hsChild2 = hsRt.collaboration.jobs.get(hsJob2.task_id).childId;
      await hsRt.collaboration.userAction(hsParent.id, 'task/cancel', { teamId: hsTeam.team_id, taskId: hsTask2.id });
      await wait(() => hsRt.collaboration.jobs.get(hsJob2.task_id).status === 'cancelled');
      const sendsAfterCancel = hsSends.filter(send => send.id === hsChild2).length;
      await new Promise(r => setTimeout(r, 250));
      assert.equal(hsSends.filter(send => send.id === hsChild2).length, sendsAfterCancel, '任务卡取消不派发收尾回合');
      assert.equal(hsRt.collaboration.jobs.get(hsJob2.task_id).handoff, undefined);

      // E) 成员不回复：超时静默放弃，作业保持 interrupted、不写交接
      hsRt.handshakeTimeoutMs = 250;
      const hsTask3 = (await hsCall('assign_team_task', { team_id: hsTeam.team_id, title: 'Silent', description: 'Never replies', assignee: hsTeam.members[0].id })).task;
      const hsJob3 = await hsCall('delegate_to_agent', { agent_type: 'worker', task: 'work three', team_id: hsTeam.team_id, member_id: hsTeam.members[0].id, team_task_id: hsTask3.id, isolation: 'shared' });
      await wait(() => { const child = hsRt.collaboration.jobs.get(hsJob3.task_id).childId; return child && hsPending.has(child); });
      const hsChild3 = hsRt.collaboration.jobs.get(hsJob3.task_id).childId;
      await hsRt.collaboration.userAction(hsParent.id, 'interrupt', { teamId: hsTeam.team_id });
      await wait(() => hsRt.collaboration.jobs.get(hsJob3.task_id).status === 'interrupted');
      await wait(() => hsSends.filter(send => send.id === hsChild3).some(send => /Agent Team handoff/.test(send.text)));
      await new Promise(r => setTimeout(r, 500));
      assert.equal(hsRt.collaboration.jobs.get(hsJob3.task_id).handoff, undefined, '超时未回复则无交接');
      assert.equal(hsTeamObj.tasks.find(t => t.id === hsTask3.id).status, 'interrupted', '中断语义不被握手改变');
      await wait(() => !hsRt.execution.isRunning(hsChild3), '超时后收尾回合被止住');
    } finally { await hsRt.close(); }

    // Phase 6 编排脚本：Lead 一次生成脚本，Host 零模型执行，终态一次唤醒；验证门；
    // 独占；Lead 回合结束后脚本独立存活；中断→握手→「继续协作」journal 重放（已结算
    // 任务零重派、中断任务复用原会话）；结果驱动分支。
    const scRoot = await fs.mkdtemp(path.resolve('output/collaboration-script-'));
    const scRt = new HostRuntime({ dataDirectory: path.join(scRoot, 'data') });
    try {
      await scRt.store.load();
      const scLeadSends = [];
      const scPending = new Map();
      const scSends = [];
      const scLead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
        async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
        async send(s, text) { scLeadSends.push(text); }, async cancel() {}, async close() {} };
      const scWorker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
        async open(input) { return { id: input.thread.id, emit: input.emit, collaborationEnabled: !!input.collaboration }; },
        async send(s, text) { scPending.set(s.id, { s, text }); scSends.push({ id: s.id, text }); }, async cancel(s) { scPending.delete(s.id); }, async close() {} };
      const scReviewer = { ...scWorker, manifest: { id: 'reviewer', name: 'Reviewer', capabilities: { collaborationTools: true } } };
      scRt.adapters.set('lead', scLead); scRt.status.lead = { available: true };
      scRt.adapters.set('worker', scWorker); scRt.status.worker = { available: true };
      scRt.adapters.set('reviewer', scReviewer); scRt.status.reviewer = { available: true };
      const scParent = await scRt.createThread({ harnessId: 'lead', cwd: scRoot });
      const scCall = (name, args) => scRt.collaboration.call(scParent.id, name, args);
      const scFinish = (id, text) => { const { s } = scPending.get(id); scPending.delete(id); s.emit({ kind: 'text-delta', text }); s.emit({ kind: 'completed', finalAnswer: true }); };
      const settleLead = () => {
        const session = scRt.sessions.get(scParent.id);
        session.emit({ kind: 'text-delta', text: 'ok' });
        session.emit({ kind: 'completed', finalAnswer: true });
      };
      await scRt.send(scParent.id, '#worker #reviewer 编排脚本回归');
      const scTeam = await scCall('create_agent_team', { name: 'Script team', goal: 'Orchestrate server-side', members: [{ name: 'Builder', role: 'Build', agent_type: 'worker' }, { name: 'Checker', role: 'Check', agent_type: 'reviewer' }] });
      const scTeamObj = scRt.collaboration.teams.get(scTeam.team_id);
      const scTaskByTitle = title => scTeamObj.tasks.find(t => t.title === title);

      // A) 验证门：语法错误、未知成员、动态 member、无 task
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: 'const = 3' }), /验证门：声明需要变量名/);
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: "task({ title: 'x', description: 'y', member: 'Nobody' })" }), /成员「Nobody」不在团队中/);
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: "const who = 'Builder'\ntask({ title: 'x', description: 'y', member: who })" }), /member 必须是字符串字面量/);
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: "phase('only')" }), /至少需要声明一个 task/);
      await assert.rejects(scRt.collaboration.call((await scRt.createThread({ harnessId: 'worker', cwd: scRoot })).id, 'run_team_script', { team_id: scTeam.team_id, script: "task({ title: 'x', description: 'y', member: 'Builder' })" }), /no longer active|Only lead|participant/, '非 Lead 线程不能启动脚本');
      // 静态作用域门：未定义变量在派发前拦截——先声明任务再写错变量也不烧 token
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: "task({ title: '先行', description: 'would burn tokens', member: 'Builder' })\nconst x = undefinedVar" }), /验证门：[\s\S]*未定义的变量 "undefinedVar"/);
      assert.ok(!scTeamObj.tasks.some(t => t.title === '先行'), '静态门在任何任务入图前拦截');
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: "task({ title: 'y', description: 'z', member: 'Builder', dependsOn: [nope] })" }), /验证门：[\s\S]*未定义的变量 "nope"/);
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: "const a = task" }), /验证门：[\s\S]*只能调用/);

      // B) 主流程：并行 + 依赖 + 阶段 + Lead 回合结束后独立存活 + 一次唤醒
      const scScript = [
        "phase('build')",
        "const build = task({ title: '实现', description: '写实现并报告', member: 'Builder' })",
        "const verify = task({ title: '审查', description: '独立审查实现', member: 'Checker', dependsOn: [build] })",
        "const settled = Promise.all([build, verify])",
        "phase('report')",
        "return 'done:' + settled.length",
      ].join('\n');
      const scRun = await scCall('run_team_script', { team_id: scTeam.team_id, script: scScript });
      assert.equal(scRun.status, 'running');
      assert.match(scRun.note, /零模型调用/);
      // 独占：driver 运行中直接委派与二次脚本均被拒（图任务由脚本异步创建，
      // 独占门在任务解析之前生效，任意 team_task_id 即可触发）
      await assert.rejects(scCall('delegate_to_agent', { agent_type: 'worker', task: 'x', team_id: scTeam.team_id, member_id: scTeam.members[0].id, team_task_id: 'any' }), /独占/);
      await assert.rejects(scCall('run_team_script', { team_id: scTeam.team_id, script: scScript }), /已有编排脚本在运行/);
      // Lead 回合结束（工具已返回）：脚本独立存活
      settleLead();
      await wait(() => !scRt.execution.isRunning(scParent.id));
      await wait(() => scPending.size === 1 && /写实现并报告/.test([...scPending.values()][0].text));
      const scBuilderChild = [...scPending.keys()][0];
      assert.equal(scTaskByTitle('审查').status, 'blocked', '依赖未完成时后继保持 blocked');
      assert.equal(scTeamObj.driver.phase, 'build');
      scFinish(scBuilderChild, '实现完成 A');
      await wait(() => [...scPending.values()].some(entry => /独立审查实现/.test(entry.text)));
      assert.equal(scTaskByTitle('实现').status, 'completed', 'Lead 回合结束后任务照常结算');
      const scCheckerChild = [...scPending.keys()].find(id => id !== scBuilderChild);
      scFinish(scCheckerChild, '审查通过');
      await wait(() => scTeamObj.driver.status === 'completed');
      assert.equal(scTeamObj.driver.result, 'done:2');
      assert.ok(scTeamObj.history.some(entry => entry.action === 'script_completed'), 'script_completed 入史');
      // 零模型执行：执行期 Lead 仅收到一次终态唤醒
      await wait(() => scLeadSends.length === 2);
      assert.match(scLeadSends[1], /编排脚本完成/);
      assert.match(scLeadSends[1], /实现完成 A/);
      assert.match(scLeadSends[1], /审查通过/);
      assert.match(scLeadSends[1], /最终阶段：report/);
      assert.equal(scLeadSends.length, 2, '执行期零模型调用（仅用户初始消息 + 一次唤醒）');
      assert.equal((await scRt.collaboration.inspectTeam(scParent.id, scTeam.team_id)).team.driver.status, 'completed', 'teamView 暴露 driver 状态');
      settleLead(); // 唤醒回合在 fake lead 上不会自行结束，结算后才能开下一场景
      await wait(() => !scRt.execution.isRunning(scParent.id));

      // C) 结果驱动分支：失败任务走 else 路径
      await scRt.send(scParent.id, '#worker 分支回归');
      const scTeam2 = await scCall('create_agent_team', { name: 'Branch team', goal: 'Branch on results', members: [{ name: 'Builder', role: 'Build', agent_type: 'worker' }] });
      const scTeam2Obj = scRt.collaboration.teams.get(scTeam2.team_id);
      await scCall('run_team_script', { team_id: scTeam2.team_id, script: [
        "const probe = task({ title: '探测', description: 'probe the branch', member: 'Builder' })",
        "if (probe.status === 'completed') {",
        "  return 'branch-ok'",
        "}",
        "return 'branch-failed'",
      ].join('\n') });
      settleLead();
      await wait(() => [...scPending.values()].some(entry => /probe the branch/.test(entry.text)));
      const probeChild = [...scPending.keys()].find(id => scSends.some(send => send.id === id && /probe the branch/.test(send.text)));
      scPending.get(probeChild).s.emit({ kind: 'error', message: 'probe broke' });
      await wait(() => scTeam2Obj.driver.status === 'completed');
      assert.equal(scTeam2Obj.driver.result, 'branch-failed', '失败结果驱动 else 分支');
      // C 的终态唤醒落地并结算，避免与 D 的用户回合竞态
      await wait(() => scLeadSends.some(text => /编排脚本完成[\s\S]*探测/.test(text)));
      settleLead();
      await wait(() => !scRt.execution.isRunning(scParent.id));

      // D) 中断→握手→「继续协作」journal 重放
      await scRt.send(scParent.id, '#worker 重放回归');
      const scTeam3 = await scCall('create_agent_team', { name: 'Replay team', goal: 'Interrupt and resume', members: [{ name: 'Builder', role: 'Build', agent_type: 'worker' }] });
      const scTeam3Obj = scRt.collaboration.teams.get(scTeam3.team_id);
      await scCall('run_team_script', { team_id: scTeam3.team_id, script: [
        "phase('run')",
        "const first = task({ title: '第一步', description: 'first step', member: 'Builder' })",
        "const second = task({ title: '第二步', description: 'second step', member: 'Builder' })",
        "return 'replayed'",
      ].join('\n') });
      settleLead();
      await wait(() => [...scPending.values()].some(entry => /first step/.test(entry.text)));
      const firstChild = [...scPending.keys()].find(id => scSends.some(send => send.id === id && /first step/.test(send.text)));
      scFinish(firstChild, '第一步完成');
      await wait(() => [...scPending.values()].some(entry => /second step/.test(entry.text)));
      const secondChild = [...scPending.keys()].find(id => scSends.some(send => send.id === id && /second step/.test(send.text)));
      // 在第二步执行中中断：握手留给成员自述交接
      await scRt.collaboration.userAction(scParent.id, 'interrupt', { teamId: scTeam3.team_id });
      await wait(() => scTeam3Obj.driver.status === 'interrupted');
      assert.equal(scTeam3Obj.tasks.find(t => t.title === '第一步').status, 'completed');
      assert.equal(scTeam3Obj.tasks.find(t => t.title === '第二步').status, 'interrupted');
      await wait(() => [...scPending.values()].some(entry => /Agent Team handoff/.test(entry.text)));
      scFinish(secondChild, '第二步做到一半，阻塞在导出格式');
      await wait(() => scRt.collaboration.jobs.get(scTeam3Obj.tasks.find(t => t.title === '第二步').jobId)?.handoff != null || scTeam3Obj.tasks.find(t => t.title === '第二步').handoff != null);
      const firstStepSendCount = scSends.filter(send => /first step/.test(send.text)).length;
      // 「继续协作」→ driver 重放：已完成的第一步零重派，第二步复用原会话
      const scResumed = await scRt.collaboration.userAction(scParent.id, 'continue', { teamId: scTeam3.team_id });
      assert.equal(scResumed.driver.status, 'running');
      await wait(() => [...scPending.values()].some(entry => /Continue the interrupted team task/.test(entry.text)));
      assert.equal(scSends.filter(send => /first step/.test(send.text)).length, firstStepSendCount, 'journal 命中的已完成任务不重新派发');
      const resumeSend = scSends.find(send => send.id === secondChild && /Continue the interrupted team task/.test(send.text));
      assert.ok(resumeSend, '中断任务复用原成员会话恢复');
      assert.match(resumeSend.text, /第二步做到一半/, '恢复提示词携带成员交接');
      scFinish(secondChild, '第二步完成');
      await wait(() => scTeam3Obj.driver.status === 'completed');
      assert.equal(scTeam3Obj.driver.result, 'replayed');
      assert.equal(scTeam3Obj.tasks.filter(t => t.scriptId).length, 2, '重放不重复建任务');
      await wait(() => scLeadSends.some(text => /编排脚本完成[\s\S]*第二步完成/.test(text)), '重放完成后唤醒 Lead');

      // E) 运行时错误：静态门放行、解释期失败 → driver failed + 结构化错误唤醒。
      // 任务先正常结算（Promise.all 汇合），失败发生在无在途任务时点
      settleLead();
      await wait(() => !scRt.execution.isRunning(scParent.id));
      await scRt.send(scParent.id, '#worker 运行时错误回归');
      await scCall('run_team_script', { team_id: scTeam.team_id, script: "const prep = task({ title: '准备', description: 'prepare work', member: 'Builder' })\nconst settled = Promise.all([prep])\nconst box = 'text'\nbox.push(1)\nreturn 'unreachable'" });
      settleLead();
      await wait(() => !scRt.execution.isRunning(scParent.id));
      await wait(() => [...scPending.values()].some(entry => /prepare work/.test(entry.text)));
      const prepChildId = [...scPending.keys()].find(id => scSends.some(send => send.id === id && /prepare work/.test(send.text)));
      scFinish(prepChildId, '准备完成');
      await wait(() => scTeamObj.tasks.find(t => t.title === '准备').status === 'completed');
      await wait(() => scTeamObj.driver.status === 'failed');
      assert.match(scTeamObj.driver.error, /只有数组支持 \.push/, '运行时错误结构化记录在 driver');
      assert.ok(scTeamObj.history.some(entry => entry.action === 'script_failed'), 'script_failed 入史');
      await wait(() => scLeadSends.some(text => /编排脚本失败[\s\S]*只有数组支持/.test(text)), '失败唤醒携带结构化错误');
    } finally { await scRt.close(); }

    // Phase 7 团队跨回合存活：Lead 回合自然收尾后成员继续执行（信箱模型），任务落定时
    // 唤醒空闲 Lead 交接结果；显式中断仍级联取消。回归：此前 Lead 回合一结束，结算
    // 路径 cancelOwner 全量取消 running 成员作业——团队任务被重置回 pending 且无人
    // 推进，用户看到的就是「转圈卡死」。
    const twRoot = await fs.mkdtemp(path.resolve('output/collaboration-team-wake-'));
    const twRt = new HostRuntime({ dataDirectory: path.join(twRoot, 'data') });
    try {
      await twRt.store.load();
      const twLeadSends = [];
      const twPending = new Map();
      const twLead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
        async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
        async send(s, text) { twLeadSends.push(text); }, async cancel() {}, async close() {} };
      const twWorker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
        async open(input) { return { id: input.thread.id, emit: input.emit, collaborationEnabled: !!input.collaboration }; },
        async send(s, text) { twPending.set(s.id, { s, text }); }, async cancel(s) { twPending.delete(s.id); }, async close() {} };
      twRt.adapters.set('lead', twLead); twRt.status.lead = { available: true };
      twRt.adapters.set('worker', twWorker); twRt.status.worker = { available: true };
      const twParent = await twRt.createThread({ harnessId: 'lead', cwd: twRoot });
      const twCall = (name, args) => twRt.collaboration.call(twParent.id, name, args);
      const twSettleLead = () => { const session = twRt.sessions.get(twParent.id); session.emit({ kind: 'text-delta', text: 'ok' }); session.emit({ kind: 'completed', finalAnswer: true }); };
      await twRt.send(twParent.id, '#worker 团队跨回合回归');
      const twTeam = await twCall('create_agent_team', { name: '跨回合团队', goal: 'Cross-turn team', members: [{ name: 'Reviewer', role: 'Review', agent_type: 'worker' }] });
      const twTask = await twCall('assign_team_task', { team_id: twTeam.team_id, title: '评审', description: 'review across turns', assignee: 'Reviewer' });
      await twCall('delegate_to_agent', { agent_type: 'worker', task: 'review the code', team_id: twTeam.team_id, member_id: twTeam.members[0].id, team_task_id: twTask.task.id });
      await wait(() => twPending.size === 1);
      const twJob = [...twRt.collaboration.jobs.values()].find(j => j.teamId === twTeam.team_id);
      const twTeamObj = twRt.collaboration.teams.get(twTeam.team_id);
      // Lead 回合自然结束（成员仍在执行）：成员作业必须存活，不得被结算路径回收
      twSettleLead();
      await wait(() => !twRt.execution.isRunning(twParent.id));
      assert.equal(twJob.status, 'running', 'Lead 回合自然结束后团队成员继续执行（不被 cancelOwner 回收）');
      assert.equal(twTeamObj.tasks[0].status, 'in_progress');
      // 成员完成：任务结算 + 唤醒空闲 Lead（新回合携带结果与 get_team_state 指引）
      const twChild = [...twPending.keys()][0];
      const twChildSession = twPending.get(twChild).s;
      twPending.delete(twChild);
      twChildSession.emit({ kind: 'text-delta', text: '评审结论：无缺陷' });
      twChildSession.emit({ kind: 'completed', finalAnswer: true });
      await wait(() => twTeamObj.tasks[0].status === 'completed');
      await wait(() => twLeadSends.length === 2);
      assert.match(twLeadSends[1], /团队任务完成/);
      assert.match(twLeadSends[1], /评审结论：无缺陷/);
      assert.match(twLeadSends[1], /get_team_state/);
      assert.ok(twRt.execution.isRunning(twParent.id), '任务落定唤醒回合已在 Lead 上启动');
      // 唤醒回合结束后不再有新的自动唤醒（单任务团队已收尾）
      twSettleLead();
      await wait(() => !twRt.execution.isRunning(twParent.id));
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(twLeadSends.length, 2, '无新任务落定时不再追加唤醒回合');
      assert.equal(twTeamObj.status, 'completed', '全部任务完成后团队收尾');
      // 显式中断仍全量级联取消成员（保护既有语义）
      await twRt.send(twParent.id, '#worker 第二轮');
      const twTask2 = await twCall('assign_team_task', { team_id: twTeam.team_id, title: '二评', description: 'second review', assignee: 'Reviewer' });
      await twCall('delegate_to_agent', { agent_type: 'worker', task: 'review again', team_id: twTeam.team_id, member_id: twTeam.members[0].id, team_task_id: twTask2.task.id });
      await wait(() => twPending.size === 1);
      const twJob2 = [...twRt.collaboration.jobs.values()].find(j => j.teamTaskId === twTask2.task.id);
      await twRt.cancel(twParent.id);
      await wait(() => twJob2.status === 'cancelled');
      assert.equal(twJob2.status, 'cancelled', '用户显式停止 Lead 回合仍级联取消团队成员作业');
    } finally { await twRt.close(); }

    console.log('PASS: real MCP stdio → authenticated Host → parallel native-session adapters → results/follow-up/cancellation, ownership and shared review');
  } finally { transport.stop(); await rt.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
