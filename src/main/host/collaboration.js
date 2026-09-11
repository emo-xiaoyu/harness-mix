const http = require('node:http');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { tools } = require('./collaboration-tools');
const { z } = require('zod');
const { Store } = require('./store');
const { createWorkspace, reviewWorkspace, applyWorkspace } = require('./collaboration-worktree');
const validators = new Map(tools.map(tool => [tool.name, z.fromJSONSchema(tool.inputSchema)]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A session-scoped local bridge. Native models/credentials and approvals stay in adapters.
class Collaboration {
  constructor(runtime) {
    this.runtime = runtime;
    this.keys = new Map();
    this.jobs = new Map();
    this.cancelling = new Set();
    this.closing = false;
    this.store = new Store(path.join(runtime.store.directory, 'collaboration'));
  }

  async initialize() {
    if (!this.loading) this.loading = this.store.load().then(async rows => {
      for (const row of rows) {
        if (!row.id || !row.owner || !row.agent) throw new Error('Invalid collaboration history');
        this.jobs.set(row.id, { ...row, ...(row.status === 'running' ? { status: 'interrupted', error: 'Host restarted; resume this native session explicitly.' } : {}) });
      }
      await this.save();
    });
    return this.loading;
  }

  save() {
    return this.store.save([...this.jobs.values()].map(({ done, cancelling, followupPending, applying, ...job }) => job));
  }

  list(owner) { return [...this.jobs.values()].filter(j => !owner || j.owner === owner).map(j => this.view(j)); }

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
    job.applying = true;
    try {
      const result = await applyWorkspace(job.workspace, digest);
      job.appliedDigest = result.digest;
      await this.save();
      return result;
    } finally { delete job.applying; }
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
      env: { HARNESS_MIX_COLLAB_URL: `http://127.0.0.1:${this.server.address().port}`, HARNESS_MIX_COLLAB_KEY: key } };
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

  view(job) {
    const pending = job.childId ? this.runtime.core.interactions?.pending(job.childId)?.[0] : null;
    return { task_id: job.id, parent_thread_id: job.owner, child_thread_id: job.childId, agent_type: job.agent, status: job.status,
      display_status: pending ? 'waiting_approval' : job.status, attention: pending ? { type: pending.type, title: pending.title, message: pending.message } : undefined,
      task: job.task, workspace: job.workspace, applied: !!job.appliedDigest, result: job.result, error: job.error };
  }

  async call(owner, name, args) {
    await this.initialize();
    if (this.closing) throw new Error('Host is closing');
    if (!validators.has(name)) throw new Error('Unknown collaboration tool');
    args = validators.get(name).parse(args);
    const rt = this.runtime;
    const parent = rt.threads.find(t => t.id === owner);
    if (!parent || parent.parentThreadId) throw new Error('Only lead tasks can delegate');
    if (!rt.execution.isRunning(owner) || this.cancelling.has(owner)) throw new Error('Lead turn is no longer active');
    if (name === 'list_agents') return [...rt.adapters.values()].map(a => ({ agent_type: a.manifest.id, name: a.manifest.name, available: !!rt.status[a.manifest.id]?.available }));
    if (name === 'list_delegations') return this.list(owner);
    if (name === 'update_agent_plan') {
      rt.emitCollaboration(owner, { kind: 'plan', entries: args.steps });
      return { steps: args.steps };
    }
    if (name === 'delegate_to_agent') {
      const agent = rt.resolveHarnessId(args.agent_type);
      if (!agent || !rt.status[agent]?.available) throw new Error('Target Harness unavailable');
      const jobs = [...this.jobs.values()].filter(j => j.owner === owner);
      if (jobs.filter(j => j.status === 'running').length >= 4) throw new Error('At most four concurrent subtasks; collect existing results first');
      if (jobs.filter(j => j.turnId === rt.execution.lastTurn(owner)?.id).length >= 16) throw new Error('At most sixteen subtasks per lead turn');
      const job = { id: randomUUID(), owner, agent, turnId: rt.execution.lastTurn(owner).id, status: 'running', task: args.task, isolation: args.isolation || 'shared' };
      this.jobs.set(job.id, job);
      await this.save();
      job.done = this.run(parent, job, args.task);
      return this.view(job);
    }
    if (name === 'get_delegation_status') {
      const jobs = args.task_ids.map(id => this.owned(owner, id));
      const until = Date.now() + (args.wait_ms ?? 0);
      while (jobs.every(j => j.status === 'running') && Date.now() < until && !this.closing) await delay(Math.min(100, until - Date.now()));
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
    if ([...this.jobs.values()].filter(j => j.owner === owner && j.status === 'running').length >= 4) throw new Error('At most four concurrent subtasks');
    job.status = 'running'; job.result = undefined; job.error = undefined;
    job.turnId = rt.execution.lastTurn(owner).id;
    const task = name === 'resume_delegation' ? `Continue the interrupted task in this existing workspace. Inspect existing progress before acting; do not repeat completed side effects. Original task:\n${job.task}` : args.task;
    if (name !== 'resume_delegation') job.task = task;
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
      if (job.status !== 'running' || this.closing) return;
      const child = job.childId ? rt.threads.find(t => t.id === job.childId) : await rt.createThread({ harnessId: job.agent, cwd: job.workspace.cwd, title: `${parent.title} › ${task.slice(0, 40)}`, parentThreadId: parent.id,
        onCreated: async thread => { job.childId = thread.id; await this.save(); } });
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
      while (job.status === 'running' && (!sendDone || rt.execution.isRunning(child.id) || child.reviewPending)) {
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
    } catch (error) { if (job.status === 'running') { job.status = 'failed'; job.error = error.message; } }
    finally { await this.save(); emit({ kind: 'tool', toolCallId, state: job.status === 'completed' ? 'done' : 'error', output: JSON.stringify(this.view(job)) }); }
  }

  async cancel(job) {
    if (job.status !== 'running') return;
    job.status = this.closing ? 'interrupted' : 'cancelled';
    job.cancelling = true;
    try { if (job.childId) await this.runtime.cancel(job.childId); }
    finally { job.cancelling = false; await this.save(); }
  }

  async cancelOwner(owner) {
    const jobs = [...this.jobs.values()].filter(j => j.owner === owner && j.status === 'running');
    if (!jobs.length) return;
    this.cancelling.add(owner);
    try { await Promise.all(jobs.map(j => this.cancel(j))); }
    finally { this.cancelling.delete(owner); }
  }
  isParticipant(thread, owner) { return thread.id === owner || [...this.jobs.values()].some(j => j.owner === owner && j.childId === thread.id); }
  async close() {
    await this.initialize();
    this.closing = true;
    await Promise.all([...this.jobs.values()].map(j => this.cancel(j)));
    await Promise.all([...this.jobs.values()].map(j => j.done));
    this.keys.clear();
    await this.save();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}

function mentionedAgents(text, runtime) {
  // Ignore code and email/package addresses; explicit links survive draft copy/paste.
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  const ids = new Set();
  for (const match of prose.matchAll(/\[[^\]\n]+\]\(harness-mix:\/\/agent\/([\w-]+)\)|(?:^|[\s，。；：])@([\w-]+)(?=$|[\s，。；：])/g)) {
    const id = runtime.resolveHarnessId(match[1] || match[2]);
    if (id) ids.add(id);
  }
  return [...ids];
}

module.exports = { Collaboration, mentionedAgents };
