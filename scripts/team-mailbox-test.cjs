const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const wait = async fn => { for (let i = 0; i < 600; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

// Agent Team 邮箱：追问（Lead 回合外的直投）、未读清理（手动 message/ack、
// 团队收尾自动清、Host 重启后对已收尾团队的滞留清扫）。
async function main() {
  const root = await fs.mkdtemp(path.resolve('output/team-mailbox-'));
  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt.store.load();
  const workerTexts = [];
  const lead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
    async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
    async send(session, text) { setTimeout(() => { session.emit({ kind: 'text-delta', text: 'done' }); session.emit({ kind: 'completed', finalAnswer: true }); }, 0); },
    async cancel() {}, async close() {} };
  const worker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
    async open(input) { return { id: input.thread.id, emit: input.emit }; },
    async send(session, text) { workerTexts.push(text); setTimeout(() => { session.emit({ kind: 'text-delta', text: 'ok' }); session.emit({ kind: 'completed', finalAnswer: true }); }, 0); },
    async cancel() {}, async close() {} };
  rt.adapters.set('lead', lead); rt.status.lead = { available: true };
  rt.adapters.set('worker', worker); rt.status.worker = { available: true };
  await rt.collaboration.initialize();

  const parent = await rt.createThread({ harnessId: 'lead', cwd: root });
  parent.activeMentions = ['worker'];
  // 团队在 Lead 回合内创建：先跑完一个正常回合，让 lastTurn 落在 completed。
  // 发送会重算提及（无 # 提及即清空 activeMentions），回合后再补回团队授权。
  await rt.send(parent.id, '组建团队');
  await wait(() => !rt.execution.isRunning(parent.id));
  parent.activeMentions = ['worker'];
  const teamView0 = await rt.collaboration.teamCall(parent.id, 'create_agent_team', {
    name: '邮箱测试队', goal: '验证投递与未读',
    members: [{ name: 'bee', role: '干活', agent_type: 'worker' }],
  });
  const team = rt.collaboration.teams.get(teamView0.team_id);
  const bee = team.members[0];
  await rt.collaboration.teamCall(parent.id, 'assign_team_task', { team_id: team.id, title: 't1', description: 'd1', assignee: bee.id });
  assert.equal(rt.execution.isRunning(parent.id), false, '前置：Lead 回合已结束');
  assert.equal(rt.execution.lastTurn(parent.id).status, 'completed', '前置：Lead 正常收尾（非取消/出错）');

  // 1) 手动清未读：bee 无子会话时的广播滞留 mailbox → message/ack 落 acknowledged
  await rt.collaboration.teamCall(parent.id, 'send_team_message', { team_id: team.id, to: '*', message: '第一声广播' });
  assert.equal(rt.collaboration.teamView(team).members[0].unread, 1, '未送达广播计入未读');
  await rt.collaboration.userAction(parent.id, 'message/ack', { teamId: team.id, memberId: bee.id });
  assert.equal(rt.collaboration.teamView(team).members[0].unread, 0, 'message/ack 后未读清零');
  assert.equal(team.messages[0].deliveryBy[bee.id], 'acknowledged', '滞留消息落 acknowledged 终态');

  // 2) 团队收尾自动清：再滞留一条，任务全部完成后 refreshTeamStatus 内部清扫
  await rt.collaboration.teamCall(parent.id, 'send_team_message', { team_id: team.id, to: bee.id, message: '第二声定向' });
  assert.equal(rt.collaboration.teamView(team).members[0].unread, 1);
  await rt.collaboration.teamCall(parent.id, 'update_team_task', { team_id: team.id, task_id: team.tasks[0].id, status: 'completed' });
  assert.equal(team.status, 'completed', '任务全完成后团队收尾');
  assert.equal(rt.collaboration.teamView(team).members[0].unread, 0, '收尾时滞留未读自动清除');

  // 3) 追问（Lead 回合外、团队已收尾）：直投不再被「协作父任务已结束」拒绝
  const child = await rt.createThread({ harnessId: 'worker', cwd: root, parentThreadId: parent.id });
  bee.childId = child.id;
  await rt.collaboration.saveTeams();
  await rt.collaboration.userAction(parent.id, 'message/send', { teamId: team.id, to: bee.id, message: '追问：结果确认了吗' });
  await wait(() => team.messages.at(-1).deliveryBy[bee.id] === 'native_session');
  assert.ok(workerTexts.some(text => text.includes('追问：结果确认了吗')), '成员原生会话收到追问信封');
  assert.equal(rt.collaboration.teamView(team).members[0].unread, 0, '送达后不计未读');
  assert.ok(!team.messages.some(message => message.deliveryError === '协作父任务已结束'), '没有投递被父回合守卫拒绝');

  // 4) Host 重启后对已收尾团队的滞留清扫：手工把一条消息改回 mailbox（模拟历史版本数据）
  await rt.close();
  const teamFile = path.join(root, 'data', 'collaboration', 'teams.json');
  const persisted = JSON.parse(await fs.readFile(teamFile, 'utf8'));
  persisted[0].messages[1].deliveryBy[bee.id] = 'mailbox';
  await fs.writeFile(teamFile, JSON.stringify(persisted));
  const rt2 = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt2.store.load();
  await rt2.collaboration.initialize();
  const reloaded = rt2.collaboration.teams.get(team.id);
  assert.equal(reloaded.status, 'completed');
  assert.equal(rt2.collaboration.teamView(reloaded).members[0].unread, 0, '重启加载时滞留 mailbox 也被清扫为 acknowledged');
  assert.equal(reloaded.messages[1].deliveryBy[bee.id], 'acknowledged');
  await rt2.close();
  console.log('team-mailbox-test: all assertions passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
