const http = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tools } = require('./collaboration-tools');
const { z } = require('zod');
const { Store } = require('./store');
const { createWorkspace, reviewWorkspace, applyWorkspace, discardWorkspace, pushWorkspace } = require('./collaboration-worktree');
const validators = new Map(tools.map(tool => [tool.name, z.fromJSONSchema(tool.inputSchema)]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_CONCURRENT_SUBTASKS = 6;
const MAX_SUBTASKS_PER_TURN = 16;

// Settings → Collaboration 开关：两者默认开启。collaboration 关闭时不再注入协作
// MCP、不解析 # 提及、拒绝一切协作工具调用；agentTeam 关闭时保留一次性委派，
// 但隐藏并拒绝 create_agent_team 等团队工具。
const DEFAULT_PREFERENCES = Object.freeze({ collaboration: true, agentTeam: true });
const TEAM_TOOL_NAMES = new Set(['create_agent_team', 'assign_team_task', 'get_team_state', 'update_team_task', 'send_team_message']);

// Dependency depth of each task: the longest chain of prerequisites, used to
// lay the team board out in lanes.
// Missing dependency ids are ignored (the runtime already rejects unknown ids at
// assign time); the cycle back-edge returns 0 so corrupted graphs terminate.
function teamTaskDepths(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const depths = new Map();
  const visiting = new Set();
  const depthOf = id => {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) return 0;
    const task = byId.get(id);
    if (!task) return 0;
    visiting.add(id);
    const deps = (task.dependsOn || []).filter(dep => byId.has(dep));
    const depth = deps.length ? 1 + Math.max(...deps.map(depthOf)) : 0;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const task of tasks) depthOf(task.id);
  return depths;
}

// Coarse team phase: forming (no tasks yet),
// running (at least one task in flight), waiting (unfinished work but nothing
// running — the lead still has to delegate or unblock it), completed.
function teamPhase(team) {
  if (!team.tasks.length) return 'forming';
  if (team.tasks.every(task => task.status === 'completed')) return 'completed';
  return team.tasks.some(task => task.status === 'in_progress') ? 'running' : 'waiting';
}

// Per-status task counters plus completion percent, so a reader can reconstruct
// the workbench progress bar without walking the task list itself.
function teamProgress(tasks) {
  const progress = { total: tasks.length, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0, interrupted: 0 };
  for (const task of tasks) if (progress[task.status] !== undefined) progress[task.status] += 1;
  progress.percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  return progress;
}

function defaultWorkerPermissionMode(agent) {
  switch (agent) {
    case 'claude':
    case 'claude-code':
      return 'bypassPermissions';
    case 'antigravity':
    case 'agy':
      return 'skip';
    case 'pi':
    case 'omp':
      return 'no-approve';
    case 'zcode':
      // Worker threads run in kernel-isolated workspaces with nobody watching
      // approval cards; yolo is the ZCode selector's no-prompts mode.
      return 'yolo';
    default:
      return undefined;
  }
}

// A session-scoped local bridge. Native models/credentials and approvals stay in adapters.
class Collaboration {
  constructor(runtime) {
    this.runtime = runtime;
    this.keys = new Map();
    this.jobs = new Map();
    this.cancelling = new Set();
    this.closing = false;
    this.store = new Store(path.join(runtime.store.directory, 'collaboration'));
    this.teamStore = new Store(path.join(runtime.store.directory, 'collaboration'), 'teams.json');
    this.teams = new Map();
    this.prefFile = path.join(runtime.store.directory, 'collaboration', 'preferences.json');
    this.prefs = { ...DEFAULT_PREFERENCES };
  }

  async loadPreferences() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.prefFile, 'utf8'));
      // 只认显式的 false：缺失字段/旧文件一律回落到默认开启
      this.prefs = {
        collaboration: parsed?.collaboration !== false,
        agentTeam: parsed?.agentTeam !== false,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  getPreferences() {
    return { ...this.prefs };
  }

  async setPreferences(patch = {}) {
    await this.initialize();
    if (typeof patch.collaboration === 'boolean') this.prefs.collaboration = patch.collaboration;
    if (typeof patch.agentTeam === 'boolean') this.prefs.agentTeam = patch.agentTeam;
    await fs.promises.mkdir(path.dirname(this.prefFile), { recursive: true });
    const tmp = `${this.prefFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.prefs, null, 2));
    await fs.promises.rename(tmp, this.prefFile);
    return this.getPreferences();
  }

  async initialize() {
    if (!this.loading) this.loading = this.loadPreferences().then(() => Promise.all([this.store.load(), this.teamStore.load()])).then(async ([rows, teams]) => {
      for (const row of rows) {
        if (!row.id || !row.owner || !row.agent) throw new Error('Invalid collaboration history');
        this.jobs.set(row.id, { ...row, ...(row.status === 'running' ? { status: 'interrupted', error: 'Host restarted; resume this native session explicitly.' } : {}) });
      }
      for (const team of teams) {
        if (!team.id || !team.owner || !Array.isArray(team.members) || !Array.isArray(team.tasks) || !Array.isArray(team.messages)) throw new Error('Invalid Agent Team history');
        if (!Array.isArray(team.history)) team.history = [];
        this.teams.set(team.id, team);
      }
      for (const job of this.jobs.values()) {
        if (job.status !== 'interrupted' || !job.teamId) continue;
        const team = this.teams.get(job.teamId);
        const member = team?.members.find(entry => entry.id === job.memberId);
        const task = team?.tasks.find(entry => entry.id === job.teamTaskId);
        if (member) member.status = 'interrupted';
        if (task?.status === 'in_progress') task.status = 'interrupted';
        if (team) this.refreshTeamStatus(team);
      }
      await this.save();
      await this.saveTeams();
    });
    return this.loading;
  }

  save() {
    return this.store.save([...this.jobs.values()].map(({ done, cancelling, followupPending, applying, ...job }) => job));
  }

  saveTeams() { return this.teamStore.save([...this.teams.values()]); }

  recordTeamSnapshot(team, action) {
    if (!Array.isArray(team.history)) team.history = [];
    team.history.push({ id: randomUUID(), action, at: Date.now(), team: this.teamView(team) });
    if (team.history.length > 200) team.history.splice(0, team.history.length - 200);
  }

  async publishTeam(team, action) {
    this.recordTeamSnapshot(team, action);
    await this.saveTeams();
    this.emitTeam(team, action);
  }

  async inspectTeam(threadId, teamId) {
    await this.initialize();
    const participant = this.participant(threadId, teamId);
    if (!participant) {
      // An explicit teamId is an ownership check: outsiders are denied. Without
      // one the caller only asks "does this thread belong to a team?" — the
      // renderer polls exactly that for every active thread, so answer benignly
      // instead of failing an internal error on every poll.
      if (teamId) throw new Error('Unknown team or caller is not a team participant');
      return { team: null, snapshots: [] };
    }
    return {
      team: this.teamView(participant.team),
      snapshots: (participant.team.history || []).map(snapshot => ({ ...snapshot, team: { ...snapshot.team } })),
    };
  }

  refreshTeamStatus(team) {
    team.status = team.tasks.length && team.tasks.every(task => task.status === 'completed') ? 'completed' : 'active';
    team.updatedAt = Date.now();
  }

  list(owner) { return [...this.jobs.values()].filter(j => !owner || j.owner === owner).map(j => this.view(j)); }

  participant(threadId, teamId) {
    for (const team of this.teams.values()) {
      if (teamId && team.id !== teamId) continue;
      if (team.owner === threadId) return { team, kind: 'lead', id: 'lead', name: 'Lead' };
      const member = team.members.find(entry => entry.childId === threadId);
      if (member) return { team, kind: 'member', id: member.id, name: member.name, member };
    }
    return null;
  }

  isTeamParticipantThread(threadId) { return !!this.participant(threadId); }

  teamFor(principal, teamId) {
    const participant = this.participant(principal, teamId);
    if (!participant) throw new Error('Unknown team or caller is not a team participant');
    return participant;
  }

  resolveMember(team, value) {
    const normalized = String(value).toLowerCase();
    const matches = team.members.filter(member => member.id === value || member.name.toLowerCase() === normalized);
    if (matches.length !== 1) throw new Error(matches.length ? 'Team member name is ambiguous; use member_id' : 'Unknown team member');
    return matches[0];
  }

  // 成员未读数：发给该成员（定向或广播）且尚未经原生会话送达的消息条数，
  // 让轮询 get_team_state 的成员一眼看到“有 N 条未读”，无需遍历邮箱。
  memberUnread(team, member) {
    return team.messages.filter(message => {
      if (message.from === member.id) return false;
      if (message.to !== member.id && message.to !== '*') return false;
      const state = message.deliveryBy?.[member.id] ?? (message.to === member.id ? message.delivery : 'mailbox');
      return state !== 'native_session';
    }).length;
  }

  teamView(team) {
    const leadThread = this.runtime.threads.find(thread => thread.id === team.owner);
    const leadAgent = leadThread?.harnessId ?? 'codex';
    const leadName = this.runtime.adapters.get(leadAgent)?.manifest?.name ?? leadAgent;
    const depths = teamTaskDepths(team.tasks);
    return {
      team_id: team.id, name: team.name, goal: team.goal, status: team.status, lead_thread_id: team.owner,
      phase: teamPhase(team), progress: teamProgress(team.tasks),
      lead: { id: 'lead', name: 'Team Lead', role: `${leadName} · 协调与验收`, agent: leadAgent, display_status: this.runtime.execution.isRunning(team.owner) ? 'working' : 'ready' },
      members: team.members.map(member => ({ ...member, display_status: member.childId && this.runtime.execution.isRunning(member.childId) ? 'working' : member.status, unread: this.memberUnread(team, member) })),
      tasks: team.tasks.map(task => ({ ...task, depth: depths.get(task.id) ?? 0 })), messages: team.messages.slice(-40).map(message => ({ ...message })),
      updated_at: team.updatedAt,
    };
  }

  emitTeam(team, action) {
    if (!this.runtime.execution.isRunning(team.owner)) return;
    // 团队全部完成时把团队卡片结算为 done——否则它会作为未终态 tool_call
    // 一直挂到回合结束，被投影成「执行中」。完成后若再 reopen，会以 running 复更。
    const done = team.status === 'completed';
    this.runtime.emitCollaboration(team.owner, {
      kind: 'tool', toolCallId: `agent-team:${team.id}`, title: `Agent Team · ${team.name}`,
      state: done ? 'done' : 'running', input: team.goal, output: JSON.stringify({ action, ...this.teamView(team) }),
    });
  }

  async review(id) {
    const job = this.jobs.get(id);
    if (!job || job.status === 'running') throw new Error('子任务尚未完成');
    return reviewWorkspace(job.workspace);
  }

  async apply(id, digest) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'completed') throw new Error('仅可应用已完成子任务的改动');
    if (job.applying) throw new Error('正在应用改动');
    if (job.appliedDigest) throw new Error('此任务已应用；后续修改请创建新任务');
    const parent = this.runtime.threads.find(t => t.id === job.owner);
    // lead 回合在等待本 MCP 工具返回时必然处于运行态（call() 的前置条件），子线程由下方
    // verification gates 单独校验，因此同目录并发扫描必须排除这两者，否则条件恒真、apply 永远失败
    if (!parent || this.runtime.threads.some(t => t.id !== job.owner && t.id !== job.childId
      && (this.runtime.execution.isRunning(t.id) || t.reviewPending)
      && [parent.cwd, job.workspace?.cwd].some(cwd => String(cwd).toLowerCase() === String(t.cwd).toLowerCase()))) throw new Error('其他任务正在同一目录运行或待审查，请等待其结算后再应用');
    // 子线程已删除时无从查询其门禁策略：review+digest+用户显式授权仍是硬前置，这里跳过
    const childThread = job.childId ? this.runtime.threads.find(t => t.id === job.childId) : null;
    if (childThread) this.runtime.verificationGates.assertSatisfied(childThread, '应用子任务改动');
    job.applying = true;
    try {
      const result = await applyWorkspace(job.workspace, digest);
      job.appliedDigest = result.digest;
      // off 策略下的零配置安全网：apply 结果附一次 advisory 验证（不阻断、不改门禁语义）
      const childForVerify = job.childId ? this.runtime.threads.find(t => t.id === job.childId) : null;
      if (childForVerify) {
        const report = await this.runtime.verificationGates.advisory(childForVerify).catch(() => null);
        if (report) { job.verification = { mode: 'advisory', status: report.status, checks: report.checks }; result.verification = job.verification; }
      }
      await this.save();
      return result;
    } finally { delete job.applying; }
  }

  async discard(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('子任务不存在');
    if (job.status === 'running') throw new Error('子任务正在运行，请先取消');
    const result = await discardWorkspace(job.workspace);
    job.status = 'cancelled';
    delete job.workspace;
    await this.save();
    return result;
  }

  async push(id, { remote = 'origin', branch } = {}) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('子任务不存在');
    if (job.status === 'running') throw new Error('请等待子任务完成后再推送分支');
    if (job.childId) this.runtime.verificationGates.assertSatisfied(this.runtime.getThread(job.childId), '推送子任务分支');
    return pushWorkspace(job.workspace, remote, branch);
  }

  async connection(thread) {
    await this.initialize();
    if (!this.starting) this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => void this.handle(req, res));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    await this.starting;
    let key = this.keys.get(thread.id);
    if (!key) { key = randomUUID(); this.keys.set(thread.id, key); }
    return { command: process.execPath, args: [path.join(__dirname, 'collaboration-mcp.cjs')],
      env: { HARNESS_MIX_COLLAB_URL: `http://127.0.0.1:${this.server.address().port}`, HARNESS_MIX_COLLAB_KEY: key, HARNESS_MIX_COLLAB_TEAM: this.prefs.agentTeam ? '1' : '0' } };
  }

  async handle(req, res) {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const owner = [...this.keys].find(([, key]) => req.headers.authorization === `Bearer ${key}`)?.[0];
    if (!owner || req.method !== 'POST' || req.url !== '/' || req.headers.origin) return reply(403, { error: 'Forbidden' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64000) throw new Error('Request too large'); }
      const { name, arguments: args } = JSON.parse(body);
      reply(200, { result: await this.call(owner, name, args ?? {}) });
    } catch (error) { reply(400, { error: error.message }); }
  }

  owned(owner, id) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new Error('Unknown task or task belongs to another lead');
    return job;
  }

  async teamCall(principal, name, args) {
    const rt = this.runtime;
    if (name === 'create_agent_team') {
      const lead = rt.threads.find(thread => thread.id === principal);
      if (!lead || lead.parentThreadId) throw new Error('Only a lead task can create an Agent Team');
      const names = new Set();
      const members = args.members.map(entry => {
        const agent = rt.resolveHarnessId(entry.agent_type);
        if (!agent || !rt.status[agent]?.available) throw new Error(`Target Harness unavailable: ${entry.agent_type}`);
        if (!rt.adapters.get(agent)?.manifest?.capabilities?.collaborationTools) throw new Error(`Harness cannot participate in Agent Team messaging: ${agent}`);
        if (!lead.activeMentions?.includes(agent)) throw new Error(`Agent Team member ${entry.name} uses unselected Harness "${agent}"`);
        const key = entry.name.trim().toLowerCase();
        if (names.has(key)) throw new Error('Agent Team member names must be unique');
        names.add(key);
        return { id: randomUUID(), name: entry.name.trim(), role: entry.role.trim(), agent, status: 'ready' };
      });
      const team = { id: randomUUID(), owner: principal, name: args.name.trim(), goal: args.goal, status: 'active', members, tasks: [], messages: [], history: [], createdAt: Date.now(), updatedAt: Date.now() };
      this.teams.set(team.id, team);
      await this.publishTeam(team, 'team_created');
      return this.teamView(team);
    }

    const participant = this.teamFor(principal, args.team_id);
    const { team } = participant;
    if (name === 'get_team_state') return this.teamView(team);
    if (name === 'assign_team_task') {
      if (participant.kind !== 'lead') throw new Error('Only the Team Lead can assign team tasks');
      const assignee = this.resolveMember(team, args.assignee);
      const dependencies = [...new Set(args.depends_on ?? [])];
      if (dependencies.some(id => !team.tasks.some(task => task.id === id))) throw new Error('Unknown dependency task');
      const taskEntry = { id: randomUUID(), title: args.title.trim(), description: args.description, assignee: assignee.id, dependsOn: dependencies, status: dependencies.length ? 'blocked' : 'pending', createdAt: Date.now(), updatedAt: Date.now(), ...(args.retry ? { retry: { max: args.retry.max, used: 0 } } : {}) };
      team.tasks.push(taskEntry);
      this.refreshTeamStatus(team);
      await this.publishTeam(team, 'task_assigned');
      return { task: taskEntry, team: this.teamView(team) };
    }
    if (name === 'update_team_task') {
      const taskEntry = team.tasks.find(task => task.id === args.task_id);
      if (!taskEntry) throw new Error('Unknown team task');
      if (participant.kind === 'member' && taskEntry.assignee !== participant.id) throw new Error('A teammate can update only its assigned tasks');
      if (participant.kind === 'member' && !['in_progress', 'completed', 'failed'].includes(args.status)) throw new Error('A teammate can only start, complete, or fail its assigned task');
      if (participant.kind === 'member' && taskEntry.status === 'completed') throw new Error('A completed task can only be reopened by the Team Lead');
      if (['in_progress', 'completed'].includes(args.status) && taskEntry.dependsOn.some(id => team.tasks.find(task => task.id === id)?.status !== 'completed')) throw new Error('Task dependencies are not complete');
      taskEntry.status = args.status;
      taskEntry.updatedAt = Date.now();
      if (args.result !== undefined) taskEntry.result = args.result;
      for (const candidate of team.tasks) {
        if (candidate.status === 'blocked' && candidate.dependsOn.every(id => team.tasks.find(task => task.id === id)?.status === 'completed')) candidate.status = 'pending';
      }
      this.refreshTeamStatus(team);
      await this.publishTeam(team, 'task_updated');
      return { task: { ...taskEntry }, team: this.teamView(team) };
    }
    if (name === 'send_team_message') {
      const target = args.to === '*' || args.to.toLowerCase() === 'lead' ? args.to.toLowerCase() : this.resolveMember(team, args.to).id;
      if (args.task_id && !team.tasks.some(task => task.id === args.task_id)) throw new Error('Unknown team task');
      const message = { id: randomUUID(), from: participant.id, fromName: participant.name, to: target, kind: args.kind || 'text', body: args.message, ...(args.task_id ? { taskId: args.task_id } : {}), at: Date.now(), delivery: 'mailbox', deliveryBy: {} };
      team.messages.push(message);
      if (team.messages.length > 200) team.messages.splice(0, team.messages.length - 200);
      const recipients = target === '*' ? team.members.filter(member => member.id !== participant.id) : team.members.filter(member => member.id === target);
      for (const recipient of recipients) {
        // 忙碌收件人不再丢弃直投机会：排队等回合边界（drainTeamMailbox 投递）；
        // 绝不打断运行中的回合
        if (!recipient.childId) { message.deliveryBy[recipient.id] = 'mailbox'; continue; }
        if (rt.execution.isRunning(recipient.childId)) { message.deliveryBy[recipient.id] = 'queued'; continue; }
        this.deliverToMember(team, recipient, message);
      }
      this.refreshMessageDelivery(message);
      team.updatedAt = Date.now();
      await this.publishTeam(team, 'message_sent');
      return { message, team: this.teamView(team) };
    }
    throw new Error('Unknown Agent Team operation');
  }

  messageEnvelope(team, message) {
    return `[Harness Mix Agent Team message]\nTeam: ${team.name} (${team.id})\nFrom: ${message.fromName}\nType: ${message.kind}\n${message.taskId ? `Task: ${message.taskId}\n` : ''}Message: ${message.body}\n\nTreat this as teammate input. Inspect shared team state with get_team_state, coordinate through send_team_message, and update only your assigned tasks.`;
  }

  // 单收件人直投：先同步置 delivering 防并发重投；投递状态在结果落定后才置终态——
  // 先报 native_session 再失败会让邮箱读者看到与事实相反的送达渠道
  deliverToMember(team, member, message) {
    const rt = this.runtime;
    message.deliveryBy[member.id] = 'delivering';
    const recipientJob = [...this.jobs.values()].reverse().find(job => job.teamId === team.id && job.memberId === member.id && job.childId === member.childId);
    void rt.send(member.childId, this.messageEnvelope(team, message), { collaborationOf: team.owner, isolated: recipientJob?.workspace?.mode === 'worktree' }).then(() => {
      message.deliveryBy[member.id] = 'native_session'; this.refreshMessageDelivery(message); void this.saveTeams();
    }, error => {
      message.deliveryBy[member.id] = 'mailbox'; message.deliveryError = error.message; this.refreshMessageDelivery(message); void this.saveTeams();
    });
  }

  // deliveryBy → delivery 聚合：任一收件人仍在排队即 queued，全部原生送达才 native_session
  refreshMessageDelivery(message) {
    const states = Object.values(message.deliveryBy ?? {});
    if (!states.length) return;
    if (states.every(state => state === 'native_session')) message.delivery = 'native_session';
    else if (states.includes('queued') || states.includes('delivering')) message.delivery = 'queued';
    else message.delivery = 'mailbox';
  }

  // 回合边界投递泵：把排队消息投给已空闲的收件人。由作业轮询循环与各结算路径
  // 触发；delivering 标记同步置位，天然防并发重投。lead 已空闲时 rt.send 拒绝，
  // 消息按既有语义降级回邮箱并记录 deliveryError。
  drainTeamMailbox(team) {
    if (!team || this.closing) return;
    const rt = this.runtime;
    for (const message of team.messages) {
      for (const [memberId, state] of Object.entries(message.deliveryBy ?? {})) {
        if (state !== 'queued') continue;
        const member = team.members.find(entry => entry.id === memberId);
        if (!member?.childId || rt.execution.isRunning(member.childId)) continue;
        this.deliverToMember(team, member, message);
      }
    }
  }

  // 用户在团队看板/协作卡上的操作入口。principal 是用户：权限高于 lead 模型，
  // 因此允许 lead-only 语义（改派/以 lead 身份发消息）。安全边界不变——改派目标
  // 只能是团队既有成员（创建时已过 # 提及门控），派发类操作以「向 lead 线程注入
  // 指令回合」实现：run() 把 worker 作业监管在运行中的 lead 回合上，绕过 lead
  // 直接派发会被立刻结算为 cancelled。指令文本自带目标成员的 #提及，走与用户
  // 手打提及完全相同的授权路径（activeMentions 按回合重算，见 runtime #send）。
  async userAction(threadId, action, args = {}) {
    await this.initialize();
    if (this.closing) throw new Error('Host is closing');
    if (!this.prefs.collaboration) throw new Error('多 Agent 协作已在设置中停用（设置 → 协作）。');
    const rt = this.runtime;
    const thread = rt.threads.find(t => t.id === threadId);
    if (!thread || thread.parentThreadId) throw new Error('团队操作仅限主导者线程');
    const dispatch = text => {
      // 不等待回合完成（可能长达整个协作周期）；回合级失败由线程自身呈现
      void rt.send(threadId, text, {}).catch(() => {});
    };
    if (action === 'continue') {
      const interrupted = this.list(threadId).filter(job => job.status === 'interrupted');
      if (!interrupted.length) throw new Error('没有可恢复的中断委派');
      if (args.taskId && this.owned(threadId, args.taskId).status !== 'interrupted') throw new Error('仅中断的委派可以恢复');
      if (rt.execution.isRunning(threadId)) throw new Error('主导者回合进行中，请在回合结束后继续协作');
      // list() 返回 view 投影：agent 字段名是 agent_type
      const mentions = [...new Set(interrupted.map(job => job.agent_type))].map(agent => `#${agent}`).join(' ');
      dispatch(args.taskId
        ? `[Harness Mix collaboration · 用户操作]\n用户要求恢复中断的委派 ${args.taskId}（${mentions}）。请调用 list_delegations 确认状态后，用 resume_delegation 恢复该任务；不要重放已完成的写入或外部副作用。`
        : `[Harness Mix collaboration · 用户操作]\n用户要求继续之前中断的协作（涉及 ${mentions}）。请先调用 list_delegations 查看全部中断项，逐项判断能否安全继续：用户明确要求继续的用 resume_delegation 恢复，其余报告 task_id 与不恢复的原因；不要重放已完成的写入或外部副作用。`);
      // list() 已返回 view 投影，不可再包一层 this.view（字段名会错位）
      return { dispatched: true, interrupted };
    }
    const participant = this.teamFor(threadId, args.teamId);
    if (participant.kind !== 'lead') throw new Error('团队操作仅限主导者线程');
    const { team } = participant;
    if (action === 'task/cancel') {
      const task = team.tasks.find(entry => entry.id === args.taskId);
      if (!task) throw new Error('未知的团队任务');
      const job = [...this.jobs.values()].find(entry => entry.teamId === team.id && entry.teamTaskId === task.id && entry.status === 'running');
      if (job) await this.cancel(job);
      else if (task.status === 'in_progress') {
        // 防御：in_progress 但无运行作业（状态簿记损坏）——直接归位并广播，
        // 不让任务永久卡在进行中
        task.status = 'pending'; task.updatedAt = Date.now();
        const member = team.members.find(entry => entry.id === task.assignee);
        if (member?.status === 'working') member.status = 'ready';
        this.refreshTeamStatus(team);
        await this.publishTeam(team, 'task_cancelled');
      } else throw new Error('仅进行中的任务可以取消');
      return this.teamView(team);
    }
    if (action === 'task/reassign') {
      const task = team.tasks.find(entry => entry.id === args.taskId);
      if (!task) throw new Error('未知的团队任务');
      if (!['failed', 'interrupted', 'pending'].includes(task.status)) throw new Error('运行中或已完成的任务不能改派；请先取消或等待其结算');
      const target = this.resolveMember(team, args.memberId);
      if ([...this.jobs.values()].some(entry => entry.teamId === team.id && entry.memberId === target.id && entry.status === 'running')) throw new Error(`成员 ${target.name} 正在执行其他任务，不能改派`);
      if (rt.execution.isRunning(threadId)) throw new Error('主导者回合进行中，请在回合结束后改派');
      if (target.id !== task.assignee) { task.reassignedFrom = task.assignee; task.assignee = target.id; }
      task.status = task.dependsOn.some(id => team.tasks.find(entry => entry.id === id)?.status !== 'completed') ? 'blocked' : 'pending';
      task.result = undefined; task.updatedAt = Date.now();
      this.refreshTeamStatus(team);
      await this.publishTeam(team, 'task_reassigned');
      dispatch(`[Harness Mix collaboration · 用户改派]\n用户在团队看板上将任务「${task.title}」改派给成员 ${target.name}（Harness: #${target.agent}）。该任务已重置为待开始。请立即调用 delegate_to_agent 派发它：team_id=${team.id}、member_id=${target.id}、team_task_id=${task.id}、agent_type=${target.agent}，任务描述写明目标${args.note ? `，并纳入用户备注：${args.note}` : ''}。${task.reassignedFrom ? '任务此前已部分执行过，派发时说明不要重复已完成的步骤。' : ''}`);
      return this.teamView(team);
    }
    if (action === 'message/send') {
      if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('消息内容不能为空');
      if (args.kind && !['text', 'handoff', 'review-request', 'review-result'].includes(args.kind)) throw new Error('未知的消息类型');
      const to = args.to ?? '*';
      if (to !== '*') this.resolveMember(team, to);
      // 以 lead 身份发出：teamCall 以 team.owner 为 principal 解析为 lead
      return this.teamCall(team.owner, 'send_team_message', { team_id: team.id, to, message: args.message, ...(args.kind ? { kind: args.kind } : {}) });
    }
    throw new Error('未知的用户操作');
  }

  view(job) {
    const pending = job.childId ? this.runtime.core.interactions?.pending(job.childId)?.[0] : null;
    return { task_id: job.id, parent_thread_id: job.owner, child_thread_id: job.childId, agent_type: job.agent, status: job.status,
      team_id: job.teamId, member_id: job.memberId, team_task_id: job.teamTaskId,
      display_status: pending ? 'waiting_approval' : job.status, attention: pending ? { type: pending.type, title: pending.title, message: pending.message } : undefined,
      task: job.task, workspace: job.workspace, applied: !!job.appliedDigest, result: job.result, error: job.error,
      diff: job.diff, digest: job.digest, branch: job.workspace?.branch, verification: job.verification };
  }

  async call(principal, name, args) {
    await this.initialize();
    if (this.closing) throw new Error('Host is closing');
    if (!validators.has(name)) throw new Error('Unknown collaboration tool');
    if (!this.prefs.collaboration) {
      throw new Error('多 Agent 协作已在设置中停用（设置 → 协作）。Multi-Agent collaboration is disabled in Settings → Collaboration.');
    }
    args = validators.get(name).parse(args);
    const rt = this.runtime;
    const teamTools = TEAM_TOOL_NAMES;
    const participant = this.participant(principal, args.team_id);
    const owner = participant?.team.owner ?? principal;
    const parent = rt.threads.find(t => t.id === owner);
    if (teamTools.has(name)) {
      if (name === 'create_agent_team' && !this.prefs.agentTeam) {
        throw new Error('Agent Team 已在设置中停用（设置 → 协作）。Agent Team is disabled in Settings → Collaboration; one-shot delegation remains available.');
      }
      if (!rt.execution.isRunning(principal) || (principal === owner && this.cancelling.has(owner))) throw new Error('Collaboration turn is no longer active');
      return this.teamCall(principal, name, args);
    }
    if (!parent || principal !== owner || parent.parentThreadId) throw new Error('Only lead tasks can delegate');
    if (!rt.execution.isRunning(principal) || this.cancelling.has(owner)) throw new Error('Collaboration turn is no longer active');
    if (name === 'list_agents') return [...rt.adapters.values()].map(a => ({ agent_type: a.manifest.id, name: a.manifest.name, available: !!rt.status[a.manifest.id]?.available, team_capable: !!a.manifest.capabilities?.collaborationTools }));
    if (name === 'list_delegations') return this.list(owner);
    if (name === 'update_agent_plan') {
      rt.emitCollaboration(owner, { kind: 'plan', entries: args.steps });
      return { steps: args.steps };
    }
    if (name === 'delegate_to_agent') {
      const agent = rt.resolveHarnessId(args.agent_type);
      if (!agent || !rt.status[agent]?.available) throw new Error('Target Harness unavailable');
      // Server-side enforcement: multi-agent collaboration can ONLY start when the user explicitly selected/mentioned agents.
      if (!parent.activeMentions || !parent.activeMentions.length) {
        throw new Error('跨 Harness 协作仅在用户显式选择 Agent，或在团队/委派语境中明确写出 Harness 名称时允许启动（例如 #pi #claude，或“用 Pi 开发、Claude 审查组成团队”）。用户本轮未显式委派，不能由大模型自行决定启动跨 Harness 协作。');
      }
      if (!parent.activeMentions.includes(agent)) {
        throw new Error(`用户仅显式指定了 [${parent.activeMentions.join(', ')}]，不能委派给未指定的 "${agent}"。请向用户确认是否需要委派给其他 Harness。`);
      }
      let team, member, teamTask, previousMemberJob;
      const teamFields = [args.team_id, args.member_id, args.team_task_id].filter(Boolean).length;
      if (teamFields && teamFields !== 3) throw new Error('Agent Team delegation requires team_id, member_id and team_task_id together');
      if (teamFields) {
        ({ team } = this.teamFor(owner, args.team_id));
        member = this.resolveMember(team, args.member_id);
        teamTask = team.tasks.find(entry => entry.id === args.team_task_id);
        if (!teamTask || teamTask.assignee !== member.id) throw new Error('Team task is not assigned to this member');
        if (member.agent !== agent) throw new Error('Delegated Harness does not match the team member');
        if (member.childId && !rt.threads.some(thread => thread.id === member.childId)) delete member.childId;
        previousMemberJob = member.childId ? [...this.jobs.values()].reverse().find(job => job.teamId === team.id && job.memberId === member.id && job.childId === member.childId) : null;
        if (teamTask.dependsOn.some(id => team.tasks.find(entry => entry.id === id)?.status !== 'completed')) throw new Error('Team task dependencies are not complete');
        if (teamTask.status === 'completed') throw new Error('Team task is already completed');
        if (teamTask.status === 'in_progress') throw new Error('Team task is already running');
        if ([...this.jobs.values()].some(job => job.teamId === team.id && job.memberId === member.id && job.status === 'running')) throw new Error('Team member is already working on another task');
      }
      const jobs = [...this.jobs.values()].filter(j => j.owner === owner);
      if (jobs.filter(j => j.status === 'running').length >= MAX_CONCURRENT_SUBTASKS) throw new Error('At most six concurrent subtasks; collect existing results first');
      if (jobs.filter(j => j.turnId === rt.execution.lastTurn(owner)?.id).length >= MAX_SUBTASKS_PER_TURN) throw new Error('At most sixteen subtasks per lead turn');
      // Risk-aware default: while another session outside this collaboration group is
      // actively running in the lead directory, a shared workspace would let both sides
      // silently overwrite each other — start new workers isolated ('auto' isolates Git
      // projects into a worktree and falls back to shared only outside Git). A teammate's
      // inherited workspace and an explicit isolation argument still win over the default.
      const externalActive = rt.threads.some(t => t.id !== owner && t.parentThreadId !== owner && !this.isParticipant(t, owner)
        && String(t.cwd).toLowerCase() === String(parent.cwd).toLowerCase()
        && (rt.execution.isRunning(t.id) || t.reviewPending));
      const job = { id: randomUUID(), owner, agent, turnId: rt.execution.lastTurn(owner).id, status: 'running', task: args.task,
        isolation: previousMemberJob?.isolation ?? args.isolation ?? (externalActive ? 'auto' : 'shared'),
        ...(previousMemberJob?.workspace ? { workspace: previousMemberJob.workspace } : {}),
        ...(team ? { teamId: team.id, memberId: member.id, teamTaskId: teamTask.id, ...(member.childId ? { childId: member.childId } : {}) } : {}) };
      this.jobs.set(job.id, job);
      if (team) {
        teamTask.status = 'in_progress'; teamTask.jobId = job.id; teamTask.updatedAt = Date.now();
        member.status = 'working'; this.refreshTeamStatus(team);
        await this.publishTeam(team, 'task_started');
      }
      await this.save();
      const teamPrompt = team ? this.teamEnvelope(team, member, teamTask, args.task) : args.task;
      job.done = this.run(parent, job, teamPrompt);
      return this.view(job);
    }
    if (name === 'get_delegation_status') {
      const jobs = args.task_ids.map(id => this.owned(owner, id));
      const until = Date.now() + (args.wait_ms ?? 0);
      while (jobs.every(j => j.status === 'running') && Date.now() < until && !this.closing && !this.cancelling.has(owner) && rt.execution.isRunning(owner)) await delay(Math.min(100, until - Date.now()));
      return jobs.map(j => this.view(j));
    }
    const job = this.owned(owner, args.task_id);
    if (name === 'cancel_delegation') { await this.cancel(job); return this.view(job); }
    if (name === 'review_delegation_changes') return this.review(job.id);
    if (name === 'apply_delegation_changes') return this.apply(job.id, args.digest);
    if (name === 'resume_delegation' && job.status !== 'interrupted') throw new Error('Only interrupted tasks can be resumed');
    if (job.status === 'running' || job.cancelling || job.followupPending || job.applying) throw new Error('Subtask still running; wait before sending a follow-up');
    if (job.appliedDigest) throw new Error('Applied task is closed; delegate a new task for further changes');
    if (!job.childId && name !== 'resume_delegation') throw new Error('Subtask did not create a session; resume or delegate a new task');
    job.followupPending = true;
    try { await job.done; } finally { job.followupPending = false; }
    if (this.closing || !rt.execution.isRunning(owner) || this.cancelling.has(owner)) throw new Error('Lead turn is no longer active');
    if ([...this.jobs.values()].filter(j => j.owner === owner && j.status === 'running').length >= MAX_CONCURRENT_SUBTASKS) throw new Error('At most six concurrent subtasks');
    job.status = 'running'; job.result = undefined; job.error = undefined;
    job.turnId = rt.execution.lastTurn(owner).id;
    const task = name === 'resume_delegation' ? `Continue the interrupted task in this existing workspace. Inspect existing progress before acting; do not repeat completed side effects. Original task:\n${job.task}` : args.task;
    if (name !== 'resume_delegation') job.task = task;
    if (job.teamId) {
      const team = this.teams.get(job.teamId);
      const member = team?.members.find(entry => entry.id === job.memberId);
      const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
      if (member) member.status = 'working';
      if (teamTask) { teamTask.status = 'in_progress'; teamTask.updatedAt = Date.now(); }
      if (team) { this.refreshTeamStatus(team); await this.publishTeam(team, name === 'resume_delegation' ? 'task_resumed' : 'task_followup'); }
    }
    await this.save();
    job.done = this.run(parent, job, task);
    return this.view(job);
  }

  async run(parent, job, task) {
    const rt = this.runtime;
    const turnId = job.turnId;
    const title = `Agent 协作 · ${rt.adapters.get(job.agent).manifest.name}`;
    // 「创建智能体」(spawnAgent) 与「执行中」(sendInput) 是两个独立的投影 item：
    // spawn 在子会话就绪后立即结算为 done，否则 Desktop 原生协作卡片会在整个
    // 执行期间一直停留在「创建中 N 个智能体」。
    const spawnCallId = `collaboration:${randomUUID()}`;
    const workCallId = `collaboration:${randomUUID()}`;
    const emit = (event, operation, toolCallId) => {
      if (rt.execution.lastTurn(parent.id)?.id === turnId) rt.emitCollaboration(parent.id, { ...event,
        collaboration: { ...this.view(job), operation } });
    };
    // 已有子会话的后续输入（message_agent / resume / 团队持久成员）不涉及创建。
    let spawnSettled = !!job.childId;
    try {
      if (!job.workspace) {
        job.workspace = await createWorkspace(parent.cwd, job.id, job.isolation);
        await this.save();
      }
      const workerPermMode = defaultWorkerPermissionMode(job.agent);
      if (!spawnSettled) emit({ kind: 'tool', toolCallId: spawnCallId, title, input: task, state: 'running', output: JSON.stringify(this.view(job)) }, 'spawnAgent', spawnCallId);
      // resume/follow-up 时既有子会话可能已被删除：回落新建替代会话（同一 Harness、
      // 同一工作区），而不是永久报错把该作业废弃
      const child = (job.childId && rt.threads.find(t => t.id === job.childId)) || await rt.createThread({
        harnessId: job.agent, cwd: job.workspace.cwd, title: `${parent.title} › ${task.slice(0, 40)}`, parentThreadId: parent.id,
        options: { ...(workerPermMode ? { permissionMode: workerPermMode } : {}) },
        onCreated: async thread => {
          job.childId = thread.id;
          const team = job.teamId ? this.teams.get(job.teamId) : null;
          const member = team?.members.find(entry => entry.id === job.memberId);
          if (member) { member.childId = thread.id; member.status = 'working'; team.updatedAt = Date.now(); await this.publishTeam(team, 'member_session_ready'); }
          await this.save();
        }
      });
      job.childId = child.id;
      await this.save();
      if (!spawnSettled) {
        emit({ kind: 'tool', toolCallId: spawnCallId, title, input: task, state: 'done', output: JSON.stringify(this.view(job)) }, 'spawnAgent', spawnCallId);
        spawnSettled = true;
      }
      emit({ kind: 'tool', toolCallId: workCallId, title, input: task, state: 'running', output: JSON.stringify(this.view(job)) }, 'sendInput', workCallId);
      // 终态保持：cancel()/close() 已写入的 cancelled/interrupted 不得在此被覆写——
      // 关机竞态下覆写成 cancelled 会让重启后的 resume_delegation 拒绝恢复该作业
      if (job.status !== 'running' || this.closing || !rt.execution.isRunning(parent.id)) {
        if (job.status === 'running') {
          job.status = this.closing ? 'interrupted' : 'cancelled';
          await this.settleStoppedJob(job);
        }
        return;
      }
      // Child native file events remain visible; only the lead snapshots the shared workspace.
      // 成员会话可能被并发占用（邮箱投递泵、用户追问、上一回合结算尾部，或 isRunning
      // 已清而 sending 锁未释放的结算窗口）：busy 拒绝等空闲后重试（≤10s），而不是把
      // 「任务正在执行」误判为任务失败（改派/重派紧跟失败结算时尤其容易触发）
      let sendDone = false, sendError, sendRetrying = false;
      const dispatchInput = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await rt.send(child.id, task, { collaborationOf: parent.id, isolated: job.workspace.mode === 'worktree' });
          } catch (error) {
            if (!/任务正在执行/.test(String(error?.message ?? error)) || attempt >= 100) throw error;
            sendRetrying = true;
            await delay(100);
            sendRetrying = false;
          }
        }
      };
      const sending = dispatchInput();
      void sending.then(() => { sendDone = true; }, error => { sendDone = true; sendError = error; });
      const timeoutMs = rt.delegationTimeoutMs ?? 30 * 60 * 1000;
      const until = Date.now() + timeoutMs;
      let displayedStatus = 'running';
      let turnInactiveSince = null;
      while (job.status === 'running' && !this.closing && !this.cancelling.has(parent.id) && rt.execution.isRunning(parent.id)) {
        // 已删除的 worker 线程：core 回合可能仍呈 running 态（removeThread 不结算回合），
        // 不得据此继续等待，否则作业空转到超时
        const childRunning = rt.threads.some(t => t.id === child.id) && (rt.execution.isRunning(child.id) || child.reviewPending);
        if (!childRunning) {
          if (!turnInactiveSince) turnInactiveSince = Date.now();
          // sendRetrying 期间不按「子回合静默」提前结算：投递还在等成员空闲
          if (sendDone || (!sendRetrying && Date.now() - turnInactiveSince > 2000)) break;
        } else {
          turnInactiveSince = null;
        }
        const current = this.view(job).display_status;
        if (current !== displayedStatus) { displayedStatus = current; emit({ kind: 'tool', toolCallId: workCallId, state: 'running', output: JSON.stringify(this.view(job)) }, 'sendInput', workCallId); }
        if (Date.now() > until) {
          // 先落失败再取消子线程：runtime.cancel 会把 running 作业标记为 cancelled，
          // 若先取消后抛错，catch 的记录分支（仅认 running）会吞掉超时错误并误报已取消
          job.status = 'failed';
          job.error = `Subtask timed out after ${Math.round(timeoutMs / 60000)} minutes`;
          await rt.cancel(child.id);
          throw new Error(job.error);
        }
        // 顺带泵送排队消息：其他成员可能已空闲（不打断任何人运行中的回合）
        if (job.teamId) this.drainTeamMailbox(this.teams.get(job.teamId));
        await delay(100);
      }
      if (job.status !== 'running') return;
      if (!rt.threads.some(t => t.id === child.id)) {
        // 子线程在执行中被删除：按停止结算，而不是把未完成的 core 回合误判为 completed
        job.status = 'cancelled';
        await this.settleStoppedJob(job);
        return;
      }
      if (sendError) throw sendError;
      const turn = rt.execution.lastTurn(child.id);
      if (!turn || turn.status === 'error') throw new Error(turn?.error || child.error || 'Subtask failed');
      job.status = turn.status === 'cancelled' ? 'cancelled' : 'completed';
      const messages = rt.core.getItemsForTurn(turn.id).filter(i => i.type === 'agent_message');
      const finals = messages.filter(i => i.phase === 'final');
      job.result = (finals.length ? finals : messages).map(i => i.content || '').join('\n').slice(0, 48000);
      if (job.teamId) {
        const team = this.teams.get(job.teamId);
        const member = team?.members.find(entry => entry.id === job.memberId);
        const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
        if (member) member.status = 'ready';
        if (teamTask && teamTask.status === 'in_progress') {
          teamTask.status = job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'pending' : 'failed';
          teamTask.result = job.result;
          teamTask.updatedAt = Date.now();
          for (const candidate of team.tasks) {
            if (candidate.status === 'blocked' && candidate.dependsOn.every(id => team.tasks.find(entry => entry.id === id)?.status === 'completed')) candidate.status = 'pending';
          }
        }
        if (team) { this.refreshTeamStatus(team); await this.publishTeam(team, 'task_settled'); this.drainTeamMailbox(team); }
      }
      if (job.workspace?.mode === 'worktree' && job.status === 'completed') {
        try {
          const rev = await reviewWorkspace(job.workspace);
          job.diff = rev.patch;
          job.digest = rev.digest;
        } catch {}
      }
    } catch (error) {
      if (job.status === 'running') { job.status = 'failed'; job.error = error.message; }
      if (job.teamId) {
        const team = this.teams.get(job.teamId);
        const member = team?.members.find(entry => entry.id === job.memberId);
        const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
        if (member && member.status !== 'interrupted') member.status = 'ready';
        let retried = false;
        if (teamTask && teamTask.status === 'in_progress') {
          // 失败必达：system 通知先进 lead 邮箱，再决定自动重派或落 failed
          retried = await this.retryTeamTask(parent, job, team, member, teamTask, error);
        }
        if (teamTask && !retried) { teamTask.status = 'failed'; teamTask.result = error.message; teamTask.updatedAt = Date.now(); }
        if (team && !retried) { this.refreshTeamStatus(team); await this.publishTeam(team, 'task_failed'); this.drainTeamMailbox(team); }
      }
    }
    finally {
      await this.save();
      // 创建阶段失败（如原生会话启动报错）时，把仍在「创建中」的 spawn 卡片结算为错误。
      if (!spawnSettled) emit({ kind: 'tool', toolCallId: spawnCallId, title, input: task, state: 'error', output: JSON.stringify(this.view(job)) }, 'spawnAgent', spawnCallId);
      emit({ kind: 'tool', toolCallId: workCallId, title, state: job.status === 'completed' ? 'done' : 'error', output: JSON.stringify(this.view(job)) }, 'sendInput', workCallId);
    }
  }

  // 团队委派的任务信封：成员身份 + 共享图约定（call() 的首次派发与失败重派共用）
  teamEnvelope(team, member, teamTask, baseTask) {
    return `${baseTask}\n\n[Harness Mix Agent Team]\nTeam: ${team.name} (${team.id})\nShared goal: ${team.goal}\nYou are ${member.name}. Role: ${member.role}\nAssigned task: ${teamTask.title} (${teamTask.id})\nYou are a persistent teammate, not a one-shot subagent. Read shared state with get_team_state, update your assigned task with update_team_task, and coordinate directly with teammates through send_team_message. Do not create or assign team members.`;
  }

  // system 伪参与者通知：不进 roster、不投递，只进邮箱与团队动态，供 lead 免轮询看到失败
  pushSystemNotice(team, body, taskId) {
    team.messages.push({ id: randomUUID(), from: 'system', fromName: 'Harness Mix', to: 'lead', kind: 'text', body, ...(taskId ? { taskId } : {}), at: Date.now(), delivery: 'mailbox' });
    if (team.messages.length > 200) team.messages.splice(0, team.messages.length - 200);
  }

  // 失败结算的统一入口：先投 system 通知，再按 retry 预算决定自动重派（同一成员，
  // 复用其会话与工作区，附上次失败原因）或落 failed。返回 true 表示已重新派发。
  // 重派仍处于同一 lead 回合内（run() 的监管前提），预算只在真正重新派发时消耗。
  async retryTeamTask(parent, failedJob, team, member, teamTask, error) {
    if (!team || !teamTask || failedJob.status !== 'failed') return false;
    const rt = this.runtime;
    const reason = String(error?.message ?? error ?? 'unknown failure');
    const budget = teamTask.retry;
    const canRetry = !!budget && budget.used < budget.max && member
      && !this.closing && !this.cancelling.has(parent.id) && rt.execution.isRunning(parent.id)
      && rt.status[member.agent]?.available !== false
      && [...this.jobs.values()].filter(j => j.owner === parent.id && j.status === 'running').length < MAX_CONCURRENT_SUBTASKS;
    this.pushSystemNotice(team, `任务「${teamTask.title}」失败：${reason}${canRetry ? `；将自动重试（第 ${budget.used + 1}/${budget.max} 次）` : budget ? '；重试预算已耗尽' : ''}`, teamTask.id);
    if (!canRetry) return false;
    budget.used += 1;
    const retryJob = { id: randomUUID(), owner: parent.id, agent: failedJob.agent, turnId: rt.execution.lastTurn(parent.id)?.id,
      status: 'running', task: failedJob.task, isolation: failedJob.isolation,
      ...(failedJob.workspace ? { workspace: failedJob.workspace } : {}),
      teamId: team.id, memberId: failedJob.memberId, teamTaskId: teamTask.id,
      ...(failedJob.childId && rt.threads.some(t => t.id === failedJob.childId) ? { childId: failedJob.childId } : {}) };
    this.jobs.set(retryJob.id, retryJob);
    teamTask.status = 'in_progress'; teamTask.jobId = retryJob.id; teamTask.updatedAt = Date.now();
    if (member) member.status = 'working';
    this.refreshTeamStatus(team);
    await this.publishTeam(team, 'task_retry');
    await this.save();
    retryJob.done = this.run(parent, retryJob, this.teamEnvelope(team, member, teamTask,
      `Previous attempt failed: ${reason}\nInspect what was already done; do not repeat completed side effects and avoid the failure path.\n\nOriginal task:\n${retryJob.task}`));
    return true;
  }

  // 所有「作业在运行中被外力终止」的路径（取消工具、lead 停止级联、用户直接停止/
  // 删除 worker 线程、宿主关机）共用的收尾：团队图里不得残留 in_progress 的任务——
  // 否则该成员永远无法被再次委派（delegate_to_agent 会以 already running 拒绝）。
  async settleStoppedJob(job) {
    if (job.teamId) {
      const team = this.teams.get(job.teamId);
      const member = team?.members.find(entry => entry.id === job.memberId);
      const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
      const interrupted = job.status === 'interrupted';
      const memberStatus = interrupted ? 'interrupted' : 'ready';
      let changed = false;
      if (member && member.status !== memberStatus) { member.status = memberStatus; changed = true; }
      if (teamTask?.status === 'in_progress') { teamTask.status = interrupted ? 'interrupted' : 'pending'; teamTask.updatedAt = Date.now(); changed = true; }
      if (team && changed) { this.refreshTeamStatus(team); await this.publishTeam(team, interrupted ? 'task_interrupted' : 'task_cancelled'); }
      // 取消/中断 unwind 后成员空闲：泵送排队消息（lead 已停则按语义降级回邮箱）
      if (team) this.drainTeamMailbox(team);
    }
    await this.save();
  }

  async cancel(job) {
    if (job.status !== 'running') return;
    job.status = this.closing ? 'interrupted' : 'cancelled';
    job.cancelling = true;
    try {
      if (job.childId) {
        await Promise.race([
          this.runtime.cancel(job.childId),
          new Promise(r => setTimeout(r, 3_000)),
        ]).catch(() => {});
      }
    } finally {
      job.cancelling = false;
      await this.settleStoppedJob(job);
    }
  }

  async cancelOwner(owner) {
    const jobs = [...this.jobs.values()].filter(j => j.owner === owner && j.status === 'running');
    if (!jobs.length) return;
    this.cancelling.add(owner);
    try {
      await Promise.race([
        Promise.all(jobs.map(j => this.cancel(j))),
        new Promise(r => setTimeout(r, 5_000)),
      ]).catch(() => {});
    } finally { this.cancelling.delete(owner); }
  }
  isParticipant(thread, owner) { return thread.id === owner || [...this.jobs.values()].some(j => j.owner === owner && j.childId === thread.id); }

  // 线程删除后不得残留悬空的成员会话引用，否则团队视图会永远显示一个
  // 已不存在的 working 成员、消息投递也会反复打到死 id 上
  async forgetThread(threadId) {
    let changed = false;
    for (const team of this.teams.values()) {
      for (const member of team.members) {
        if (member.childId === threadId) { delete member.childId; changed = true; }
      }
    }
    if (changed) await this.saveTeams();
  }
  async close() {
    await this.initialize();
    this.closing = true;
    await Promise.all([...this.jobs.values()].map(j => this.cancel(j)));
    await Promise.all([...this.jobs.values()].map(j => j.done));
    this.keys.clear();
    await this.save();
    await this.saveTeams();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}

function mentionedAgents(text, runtime) {
  // Ignore code and email/package addresses; explicit links survive draft copy/paste.
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  const ids = new Set();
  // CJK ideographs (\u4e00-\u9fff) and fullwidth/halfwidth forms are valid word boundaries,
  // so #agent works in Chinese prose (for example 帮我#pi做这个). @ remains native Codex syntax.
  for (const match of prose.matchAll(/\[[^\]\n]+\]\(harness-mix:\/\/agent\/([\w-]+)\)|(?:^|[\s\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff，。；：、！？""''（）【】])#([\w-]+)(?=$|[\s\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff，。；：、！？""''（）【】])/g)) {
    const id = runtime.resolveHarnessId(match[1] || match[2]);
    if (id) ids.add(id);
  }
  // Natural-language team requests may name Harnesses without using the picker.
  // Require an explicit collaboration intent so ordinary product discussion such
  // as "Codex UI" does not silently authorize cross-Harness delegation.
  const teamIntent = /agent\s*team|团队|组队|协作|委派|调度|分工|成员|队长|主导者|\b(?:team|delegate|delegation|assign|member|teammate)\b/i.test(prose);
  if (teamIntent) {
    for (const adapter of runtime.adapters.values()) {
      const labels = [adapter.manifest.id, adapter.manifest.name, ...(adapter.manifest.aliases ?? [])]
        .filter(label => String(label ?? '').trim().length >= 2)
        .sort((a, b) => String(b).length - String(a).length);
      if (labels.some(label => containsPlainAgentName(prose, label))) ids.add(adapter.manifest.id);
    }
  }
  return [...ids];
}

function containsPlainAgentName(text, label) {
  const haystack = String(text).toLowerCase();
  const needle = String(label).trim().toLowerCase();
  for (let offset = haystack.indexOf(needle); offset !== -1; offset = haystack.indexOf(needle, offset + 1)) {
    const before = offset === 0 ? '' : haystack[offset - 1];
    const afterIndex = offset + needle.length;
    const after = afterIndex === haystack.length ? '' : haystack[afterIndex];
    if (plainNameBoundary(before) && plainNameBoundary(after)) return true;
  }
  return false;
}

function plainNameBoundary(char) {
  return !char || /[\s\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff,;:!?()[\]{}"'，。；：、！？“”‘’]/u.test(char);
}

module.exports = { Collaboration, mentionedAgents, defaultWorkerPermissionMode, teamTaskDepths, teamPhase, teamProgress };
