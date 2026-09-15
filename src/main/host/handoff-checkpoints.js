const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { Store } = require('./store');
const { redactText } = require('../native/redact');

const INTENTS = new Set(['continue', 'execute-plan', 'review', 'reanalyze']);
const INCLUDE_KEYS = ['conversation', 'plan', 'evidence', 'files', 'unresolved'];
const LIMITS = { conversations: 80, conversationChars: 256_000, evidence: 80, excerpt: 8_000, files: 100 };
const secretAssignment = /\b(token|secret|password|passwd|api[_-]?key|authorization|credential|cookie)\b(\s*[=:]\s*|\s+)([^\s,;]+)/gi;
const execFileAsync = promisify(execFile);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeText(value, max = LIMITS.excerpt) {
  if (typeof value !== 'string') return '';
  return redactText(value).replace(secretAssignment, '$1=[redacted]').slice(0, max);
}

function normalizeIncludes(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(INCLUDE_KEYS.map(key => [key, source[key] !== false]));
}

function normalizeIntent(value) { return INTENTS.has(value) ? value : 'continue'; }

function conversationSnapshot(thread) {
  let remaining = LIMITS.conversationChars;
  const result = [];
  const rows = (thread.messages || []).filter(message => ['user', 'assistant'].includes(message.role) && typeof message.text === 'string' && message.text.trim()).slice(-LIMITS.conversations);
  for (let index = rows.length - 1; index >= 0 && remaining > 0; index--) {
    const message = rows[index];
    const text = safeText(message.text.trim(), Math.min(16_000, remaining));
    if (!text) continue;
    const row = { messageId: String(message.id || ''), role: message.role, text, digest: digest({ role: message.role, text }) };
    result.push(row); remaining -= text.length;
  }
  return result.reverse();
}

function evidenceKind(item) {
  if (item.type === 'verification_report') return 'verification';
  const title = String(item.title || '').toLowerCase();
  if (/test|vitest|jest|pytest|测试/.test(title)) return 'test';
  if (/build|compile|tsc|构建|编译/.test(title)) return 'build';
  if (/shell|command|terminal|exec|命令/.test(title)) return 'command';
  return item.state === 'error' || item.status === 'error' ? 'error' : 'tool';
}

function evidenceSnapshot(thread) {
  const items = (thread.messages || []).flatMap(message => message.coreItems || []);
  return items.filter(item => (item.type === 'tool_call' && item.state !== 'running') || item.type === 'verification_report').slice(-LIMITS.evidence).map(item => {
    if (item.type === 'verification_report') {
      const report = redact(item.report ?? {});
      const content = { kind: 'verification', title: 'Verification gate', state: report.status ?? 'unknown', inputExcerpt: report.mode ?? '', outputExcerpt: JSON.stringify(report).slice(0, LIMITS.excerpt), createdAt: item.updatedAt };
      const contentDigest = digest(content);
      return { evidenceId: `evidence_${contentDigest.slice(0, 24)}`, ...content, contentDigest };
    }
    const content = {
      kind: evidenceKind(item),
      sourceHarnessId: thread.harnessId,
      title: safeText(item.title || 'Tool', 300),
      state: item.state === 'error' || item.status === 'error' ? 'error' : item.state === 'interrupted' ? 'interrupted' : 'completed',
      inputExcerpt: safeText(item.input),
      outputExcerpt: safeText(item.output || item.detail),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
    };
    const contentDigest = digest(content);
    return { evidenceId: `evidence_${contentDigest.slice(0, 24)}`, ...content, contentDigest };
  });
}

function planSnapshot(thread) {
  const plan = [...(thread.messages || [])].reverse().flatMap(message => message.coreItems || []).find(item => item.type === 'plan');
  const rows = Array.isArray(plan?.entries) ? plan.entries : [];
  const bucket = { completed: [], inProgress: [], pending: [] };
  for (const entry of rows.slice(0, 100)) {
    const text = safeText(entry.text || entry.title || entry.step, 1000);
    if (!text) continue;
    if (['done', 'completed'].includes(entry.status)) bucket.completed.push(text);
    else if (['in_progress', 'inProgress'].includes(entry.status)) bucket.inProgress.push(text);
    else bucket.pending.push(text);
  }
  return bucket;
}

async function gitSnapshot(cwd) {
  const run = async args => (await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout.trim();
  try {
    const [gitHead, gitStatus, workingDiff, stagedDiff] = await Promise.all([
      run(['rev-parse', 'HEAD']),
      run(['status', '--porcelain=v1', '--branch']),
      run(['diff', '--no-ext-diff', '--stat']),
      run(['diff', '--no-ext-diff', '--cached', '--stat']),
    ]);
    const snapshot = {
      gitHead: safeText(gitHead, 128) || null,
      gitStatus: safeText(gitStatus, 32_000),
      diffSummary: safeText([workingDiff, stagedDiff].filter(Boolean).join('\n'), 32_000),
    };
    return { ...snapshot, gitDigest: digest(snapshot) };
  } catch {
    return { gitHead: null, gitStatus: '', diffSummary: '', gitDigest: null };
  }
}

async function fileSnapshot(thread) {
  const items = (thread.messages || []).flatMap(message => message.coreItems || []).filter(item => item.type === 'file_change' && typeof item.path === 'string').slice(-LIMITS.files);
  const byPath = new Map();
  for (const item of items) {
    const file = {
      path: safeText(item.path, 2048), changeType: item.changeType || 'modified', undone: item.undone === true,
      beforeDigest: typeof item.before === 'string' ? digest(item.before) : null,
      afterDigest: typeof item.after === 'string' ? digest(item.after) : null,
    };
    byPath.set(file.path, file);
  }
  const files = [...byPath.values()];
  const git = await gitSnapshot(thread.cwd);
  return { cwd: path.resolve(thread.cwd), files, ...git, diffDigest: digest({ files, gitDigest: git.gitDigest }) };
}

function unresolvedSnapshot(thread, evidence, plan) {
  const rows = [...plan.inProgress, ...plan.pending];
  if (thread.error) rows.push(safeText(thread.error, 2000));
  for (const item of evidence) if (item.state === 'error' || item.state === 'interrupted') rows.push(`${item.title}: ${item.outputExcerpt || item.state}`.slice(0, 2000));
  return [...new Set(rows)].slice(0, 50);
}

function summaryOf(checkpoint) {
  const include = checkpoint.includes;
  return {
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    status: checkpoint.status,
    contentDigest: checkpoint.contentDigest,
    sourceHarnessId: checkpoint.sourceHarnessId,
    targetHarnessId: checkpoint.targetHarnessId,
    intent: checkpoint.intent,
    note: checkpoint.note,
    task: checkpoint.task,
    ...(include.conversation ? { conversationTail: checkpoint.conversation.slice(-10).map(({ role, text }) => ({ role, text: text.slice(0, role === 'assistant' ? 12_000 : 4_000) })) } : {}),
    ...(include.plan ? { plan: checkpoint.plan } : {}),
    ...(include.evidence ? { evidence: checkpoint.evidence.slice(-8).map(({ evidenceId, kind, title, state, outputExcerpt }) => ({ evidenceId, kind, title, state, outputExcerpt: outputExcerpt.slice(0, 1200) })) } : {}),
    ...(include.files ? { fileState: checkpoint.fileState } : {}),
    ...(include.unresolved ? { unresolved: checkpoint.unresolved } : {}),
    onDemandAccess: checkpoint.onDemandAccess,
  };
}

class HandoffCheckpoints {
  constructor(runtime) {
    this.runtime = runtime;
    this.store = new Store(path.join(runtime.store.directory, 'handoff'), 'checkpoints.json');
    this.checkpoints = new Map();
  }
  async initialize() {
    if (!this.loading) this.loading = this.store.load().then(rows => {
      for (const row of rows) {
        if (!row?.checkpointId || !row.threadId || !row.contentDigest) throw new Error('Invalid Handoff checkpoint store; original file preserved');
        this.checkpoints.set(row.checkpointId, row);
      }
    });
    return this.loading;
  }
  save() { return this.store.save([...this.checkpoints.values()]); }
  async create(thread, targetHarnessId, options = {}) {
    await this.initialize();
    const conversation = conversationSnapshot(thread);
    const evidence = evidenceSnapshot(thread);
    const plan = planSnapshot(thread);
    const fileState = await fileSnapshot(thread);
    const content = {
      threadId: thread.id, sourceHarnessId: thread.harnessId, targetHarnessId,
      intent: normalizeIntent(options.intent), includes: normalizeIncludes(options.includes),
      note: safeText(options.note, 2000) || undefined,
      task: { title: safeText(thread.title, 1000) || null, cwd: path.resolve(thread.cwd), objective: conversation.find(message => message.role === 'user')?.text.slice(0, 4000) || null },
      conversation, evidence, plan, fileState, unresolved: unresolvedSnapshot(thread, evidence, plan),
      onDemandAccess: this.runtime.adapters.get(targetHarnessId)?.manifest.integrations?.mcp === true ? 'mcp' : 'summary-only',
    };
    const contentDigest = digest(content);
    const checkpoint = { checkpointId: `handoff_${contentDigest.slice(0, 24)}`, createdAt: Date.now(), status: 'checkpoint-created', ...content, contentDigest };
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    await this.save();
    return checkpoint;
  }
  owned(threadId, checkpointId) {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint || checkpoint.threadId !== threadId) throw new Error('Handoff checkpoint not found for this task');
    return checkpoint;
  }
  latest(threadId) { return [...this.checkpoints.values()].filter(row => row.threadId === threadId).sort((a, b) => b.createdAt - a.createdAt)[0] || null; }
  get(threadId, checkpointId) { const row = checkpointId ? this.owned(threadId, checkpointId) : this.latest(threadId); return row ? summaryOf(row) : null; }
  conversation(threadId, checkpointId, { offset = 0, limit = 20 } = {}) { const row = this.owned(threadId, checkpointId); const all = row.includes.conversation ? row.conversation : []; return { checkpointId, items: all.slice(offset, offset + Math.min(limit, 50)), total: all.length }; }
  evidence(threadId, checkpointId) { const row = this.owned(threadId, checkpointId); return { checkpointId, items: row.includes.evidence ? row.evidence.map(({ inputExcerpt, outputExcerpt, ...item }) => item) : [] }; }
  readEvidence(threadId, checkpointId, evidenceId) { const row = this.owned(threadId, checkpointId); const item = row.includes.evidence ? row.evidence.find(candidate => candidate.evidenceId === evidenceId) : null; if (!item) throw new Error('Handoff evidence not found'); return item; }
  files(threadId, checkpointId) { const row = this.owned(threadId, checkpointId); return { checkpointId, ...(row.includes.files ? row.fileState : { cwd: row.task.cwd, files: [], diffDigest: null }) }; }
  plan(threadId, checkpointId) { const row = this.owned(threadId, checkpointId); return { checkpointId, plan: row.includes.plan ? row.plan : { completed: [], inProgress: [], pending: [] } }; }
  async mark(threadId, checkpointId, status) { const row = this.owned(threadId, checkpointId); row.status = status; row.statusUpdatedAt = Date.now(); await this.save(); }
  async close() { await this.save(); }
}

module.exports = { HandoffCheckpoints, INTENTS, INCLUDE_KEYS, LIMITS, digest, safeText, summaryOf, gitSnapshot };
