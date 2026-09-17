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

  teamView(team) {
    const leadThread = this.runtime.threads.find(thread => thread.id === team.owner);
    const leadAgent = leadThread?.harnessId ?? 'codex';
    const leadName = this.runtime.adapters.get(leadAgent)?.manifest?.name ?? leadAgent;
    const depths = teamTaskDepths(team.tasks);
    return {
      team_id: team.id, name: team.name, goal: team.goal, status: team.status, lead_thread_id: team.owner,
      phase: teamPhase(team), progress: teamProgress(team.tasks),
      lead: { id: 'lead', name: 'Team Lead', role: `${leadName} · 协调与验收`, agent: leadAgent, display_status: this.runtime.execution.isRunning(team.owner) ? 'working' : 'ready' },
      members: team.members.map(member => ({ ...member, display_status: member.childId && this.runtime.execution.isRunning(member.childId) ? 'working' : member.status })),
      tasks: team.tasks.map(task => ({ ...task, depth: depths.get(task.id) ?? 0 })), messages: team.messages.slice(-40).map(message => ({ ...message })),
      updated_at: team.updatedAt,
    };
  }

  emitTeam(team, action) {
    if (!this.runtime.execution.isRunning(team.owner)) return;
    this.runtime.emitCollaboration(team.owner, {
      kind: 'tool', toolCallId: `agent-team:${team.id}`, title: `Agent Team · ${team.name}`,
      state: 'running', input: team.goal, output: JSON.stringify({ action, ...this.teamView(team) }),
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
    if (!parent || this.runtime.threads.some(t => (this.runtime.execution.isRunning(t.id) || t.reviewPending) && [parent.cwd, job.workspace?.cwd].includes(t.cwd))) throw new Error('请等待主任务和工作区任务结算后再应用');
    if (job.childId) this.runtime.verificationGates.assertSatisfied(this.runtime.getThread(job.childId), '应用子任务改动');
    job.applying = true;
    try {
      const result = await applyWorkspace(job.workspace, digest);
      job.appliedDigest = result.digest;
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
      const taskEntry = { id: randomUUID(), title: args.title.trim(), description: args.description, assignee: assignee.id, dependsOn: dependencies, status: dependencies.length ? 'blocked' : 'pending', createdAt: Date.now(), updatedAt: Date.now() };
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
      const message = { id: randomUUID(), from: participant.id, fromName: participant.name, to: target, kind: args.kind || 'text', body: args.message, ...(args.task_id ? { taskId: args.task_id } : {}), at: Date.now(), delivery: 'mailbox' };
      team.messages.push(message);
      if (team.messages.length > 200) team.messages.splice(0, team.messages.length - 200);
      const recipients = target === '*' ? team.members.filter(member => member.id !== participant.id) : team.members.filter(member => member.id === target);
      for (const recipient of recipients) {
        if (!recipient.childId || rt.execution.isRunning(recipient.childId)) continue;
        const envelope = `[Harness Mix Agent Team message]\nTeam: ${team.name} (${team.id})\nFrom: ${participant.name}\nType: ${message.kind}\n${args.task_id ? `Task: ${args.task_id}\n` : ''}Message: ${args.message}\n\nTreat this as teammate input. Inspect shared team state with get_team_state, coordinate through send_team_message, and update only your assigned tasks.`;
        message.delivery = 'native_session';
        const recipientJob = [...this.jobs.values()].reverse().find(job => job.teamId === team.id && job.memberId === recipient.id && job.childId === recipient.childId);
        void rt.send(recipient.childId, envelope, { collaborationOf: team.owner, isolated: recipientJob?.workspace?.mode === 'worktree' }).catch(error => {
          message.delivery = 'mailbox'; message.deliveryError = error.message; void this.saveTeams();
        });
      }
      team.updatedAt = Date.now();
      await this.publishTeam(team, 'message_sent');
      return { message, team: this.teamView(team) };
    }
    throw new Error('Unknown Agent Team operation');
  }

  view(job) {
    const pending = job.childId ? this.runtime.core.interactions?.pending(job.childId)?.[0] : null;
    return { task_id: job.id, parent_thread_id: job.owner, child_thread_id: job.childId, agent_type: job.agent, status: job.status,
      team_id: job.teamId, member_id: job.memberId, team_task_id: job.teamTaskId,
      display_status: pending ? 'waiting_approval' : job.status, attention: pending ? { type: pending.type, title: pending.title, message: pending.message } : undefined,
      task: job.task, workspace: job.workspace, applied: !!job.appliedDigest, result: job.result, error: job.error,
      diff: job.diff, digest: job.digest, branch: job.workspace?.branch };
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
      const teamPrompt = team ? `${args.task}\n\n[Harness Mix Agent Team]\nTeam: ${team.name} (${team.id})\nShared goal: ${team.goal}\nYou are ${member.name}. Role: ${member.role}\nAssigned task: ${teamTask.title} (${teamTask.id})\nYou are a persistent teammate, not a one-shot subagent. Read shared state with get_team_state, update your assigned task with update_team_task, and coordinate directly with teammates through send_team_message. Do not create or assign team members.` : args.task;
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
    const toolCallId = `collaboration:${randomUUID()}`;
    const operation = job.childId ? 'sendInput' : 'spawnAgent';
    const emit = event => {
      if (rt.execution.lastTurn(parent.id)?.id === turnId) rt.emitCollaboration(parent.id, { ...event,
        collaboration: { ...this.view(job), operation } });
    };
    try {
      if (!job.workspace) {
        job.workspace = await createWorkspace(parent.cwd, job.id, job.isolation);
        await this.save();
      }
      const workerPermMode = defaultWorkerPermissionMode(job.agent);
      const child = job.childId ? rt.threads.find(t => t.id === job.childId) : await rt.createThread({
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
      if (!child) throw new Error('Native child history is missing; no replacement session was created');
      job.childId = child.id;
      await this.save();
      emit({ kind: 'tool', toolCallId, title: `Agent 协作 · ${rt.adapters.get(job.agent).manifest.name}`, input: task, state: 'running', output: JSON.stringify(this.view(job)) });
      if (job.status !== 'running' || this.closing || !rt.execution.isRunning(parent.id)) { job.status = 'cancelled'; return; }
      // Child native file events remain visible; only the lead snapshots the shared workspace.
      const sending = rt.send(child.id, task, { collaborationOf: parent.id, isolated: job.workspace.mode === 'worktree' });
      let sendDone = false, sendError;
      void sending.then(() => { sendDone = true; }, error => { sendDone = true; sendError = error; });
      const until = Date.now() + 30 * 60 * 1000;
      let displayedStatus = 'running';
      let turnInactiveSince = null;
      while (job.status === 'running' && !this.closing && !this.cancelling.has(parent.id) && rt.execution.isRunning(parent.id)) {
        const childRunning = rt.execution.isRunning(child.id) || child.reviewPending;
        if (!childRunning) {
          if (!turnInactiveSince) turnInactiveSince = Date.now();
          if (sendDone || Date.now() - turnInactiveSince > 2000) break;
        } else {
          turnInactiveSince = null;
        }
        const current = this.view(job).display_status;
        if (current !== displayedStatus) { displayedStatus = current; emit({ kind: 'tool', toolCallId, state: 'running', output: JSON.stringify(this.view(job)) }); }
        if (Date.now() > until) { await rt.cancel(child.id); throw new Error('Subtask timed out after 30 minutes'); }
        await delay(100);
      }
      if (job.status !== 'running') return;
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
        if (team) { this.refreshTeamStatus(team); await this.publishTeam(team, 'task_settled'); }
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
        if (member) member.status = 'ready';
        if (teamTask) { teamTask.status = 'failed'; teamTask.result = error.message; teamTask.updatedAt = Date.now(); }
        if (team) { this.refreshTeamStatus(team); await this.publishTeam(team, 'task_failed'); }
      }
    }
    finally { await this.save(); emit({ kind: 'tool', toolCallId, state: job.status === 'completed' ? 'done' : 'error', output: JSON.stringify(this.view(job)) }); }
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
      if (job.teamId) {
        const team = this.teams.get(job.teamId);
        const member = team?.members.find(entry => entry.id === job.memberId);
        const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
        if (member) member.status = this.closing ? 'interrupted' : 'ready';
        if (teamTask?.status === 'in_progress') { teamTask.status = this.closing ? 'interrupted' : 'pending'; teamTask.updatedAt = Date.now(); }
        if (team) { this.refreshTeamStatus(team); await this.publishTeam(team, this.closing ? 'task_interrupted' : 'task_cancelled'); }
      }
      await this.save();
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
