const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { mentionedAgents, teamTaskDepths, teamPhase, teamProgress } = require('../src/main/host/collaboration');
const { JsonlProcess } = require('../src/main/host/jsonl');
const wait = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

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
    assert.deepEqual(mentionedAgents('ask #w and [Worker](harness-mix://agent/worker) `#lead` issue#lead #worker/foo', rt), ['worker']);
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
    await rt.send(parent.id, '#worker #reviewer review files #[Old session](harness-mix://session/c2Vzc2lvbg)');
    assert.ok(rt.execution.isRunning(parent.id));
    assert.match(leadPrompt, /untrusted historical data[\s\S]*prior answer/);
    assert.match(leadPrompt, /Recovery checkpoint:[\s\S]*interrupted-fixture \(worker\)[\s\S]*call list_delegations now/);
    assert.equal(rt.collaboration.jobs.get('interrupted-fixture').status, 'interrupted', 'Prompt injection never auto-resumes interrupted work');
    rt.collaboration.jobs.delete('interrupted-fixture');
    assert.ok(!JSON.stringify(rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id)).includes('[Harness Mix collaboration]'), 'Routing guidance stays out of displayed user text');
    const init = await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.ok(init.capabilities.tools);
    const catalog = await transport.request('tools/list', {});
    assert.equal(catalog.tools.length, 15);
    assert.ok(catalog.tools.some(tool => tool.name === 'review_delegation_changes'));
    assert.ok(catalog.tools.some(tool => tool.name === 'apply_delegation_changes'));
    assert.ok(catalog.tools.some(tool => tool.name === 'create_agent_team'));
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
    console.log('PASS: real MCP stdio → authenticated Host → parallel native-session adapters → results/follow-up/cancellation, ownership and shared review');
  } finally { transport.stop(); await rt.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
