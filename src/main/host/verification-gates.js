const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { redactText } = require('../native/redact');
const { terminateTree } = require('../native/process-utils');

const MODES = new Set(['off', 'advisory', 'required']);
const DEFAULT_CHECKS = Object.freeze({
  turnCompleted: true,
  noPendingInteractions: true,
  noRunningTools: true,
  noReviewErrors: true,
  cleanWorkingTree: false,
});

function normalizePolicy(input = {}) {
  const mode = MODES.has(input.mode) ? input.mode : 'off';
  const checks = { ...DEFAULT_CHECKS };
  for (const key of Object.keys(checks)) if (typeof input.checks?.[key] === 'boolean') checks[key] = input.checks[key];
  const commands = (Array.isArray(input.commands) ? input.commands : []).slice(0, 8).map((entry, index) => {
    const command = typeof entry === 'string' ? entry : entry?.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 512) throw new Error(`Invalid verification command at index ${index}`);
    if (redactText(command) !== command) throw new Error(`Verification command at index ${index} contains credential-like data; use the native process environment instead`);
    const timeoutMs = typeof entry === 'object' && Number.isSafeInteger(entry.timeoutMs)
      ? Math.min(600_000, Math.max(1_000, entry.timeoutMs)) : 120_000;
    return { id: typeof entry === 'object' && entry.id ? String(entry.id).slice(0, 64) : `command-${index + 1}`, command: command.trim(), timeoutMs };
  });
  return { schemaVersion: 1, mode, autoRun: input.autoRun === true, checks, commands };
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    let stdout = '', stderr = '', timedOut = false;
    const append = (current, chunk) => (current + chunk.toString()).slice(-16_000);
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; void terminateTree(child.pid); }, timeoutMs);
    child.on('error', error => { stderr = append(stderr, error.message); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ command, status: !timedOut && code === 0 ? 'passed' : 'failed', exitCode: code, signal, timedOut, stdout: redactText(stdout), stderr: redactText(stderr), durationMs: Date.now() - startedAt });
    });
  });
}

class VerificationGates {
  constructor(runtime) { this.runtime = runtime; this.running = new Map(); }
  policy(thread) { return normalizePolicy(thread.verificationGate?.policy); }
  configure(thread, policy) {
    const normalized = normalizePolicy(policy);
    thread.verificationGate = { policy: normalized, latestReport: null };
    return normalized;
  }
  inspect(thread) {
    const policy = this.policy(thread);
    const report = thread.verificationGate?.latestReport ?? null;
    const latestTurnId = this.runtime.execution.lastTurn(thread.id)?.id ?? null;
    const current = report !== null && report.turnId === latestTurnId;
    return { policy, report, current, satisfied: policy.mode !== 'required' || (current && report?.status === 'passed') };
  }
  assertSatisfied(thread, operation) {
    const state = this.inspect(thread);
    if (!state.satisfied) throw new Error(`验证门禁未通过，不能${operation}；请先运行验证`);
  }
  invalidate(thread, reason = 'A newer turn changed the task state') {
    const gate = thread.verificationGate;
    const report = gate?.latestReport;
    if (!report || report.status === 'stale') return null;
    const invalidatedAt = Date.now();
    const stale = { ...report, status: 'stale', invalidatedAt, invalidationReason: reason };
    thread.verificationGate = { policy: this.policy(thread), latestReport: stale };
    if (stale.turnId && this.runtime.core.getTurn(stale.turnId)) {
      this.runtime.core.dispatch({ threadId: thread.id, turnId: stale.turnId, type: 'verification.updated', payload: { report: stale }, timestamp: invalidatedAt });
      this.runtime.execution.sync(thread);
    }
    return stale;
  }
  run(thread, { turnId } = {}) {
    if (this.running.has(thread.id)) return this.running.get(thread.id);
    const task = this.#run(thread, turnId).finally(() => this.running.delete(thread.id));
    this.running.set(thread.id, task);
    return task;
  }
  async #run(thread, turnId) {
    const policy = this.policy(thread);
    const startedAt = Date.now();
    const turn = turnId ? this.runtime.core.getTurn(turnId) : this.runtime.execution.lastTurn(thread.id);
    const items = turn ? this.runtime.core.getItemsForTurn(turn.id) : [];
    const checks = [];
    const add = (id, enabled, passed, detail) => { if (enabled) checks.push({ id, status: passed ? 'passed' : 'failed', detail }); };
    add('turnCompleted', policy.checks.turnCompleted, turn?.status === 'completed', turn ? `Turn status: ${turn.status}` : 'No completed Turn');
    add('noPendingInteractions', policy.checks.noPendingInteractions, !(thread.interactions?.length), `${thread.interactions?.length ?? 0} pending interaction(s)`);
    add('noRunningTools', policy.checks.noRunningTools, !items.some(item => item.type === 'tool_call' && item.state === 'running'), 'No running tools');
    add('noReviewErrors', policy.checks.noReviewErrors, !(thread.messages ?? []).some(message => message.coreTurnId === turn?.id && message.reviewError), 'Workspace review settled without error');
    if (policy.checks.cleanWorkingTree) {
      const git = await runCommand('git status --porcelain', thread.cwd, 30_000);
      checks.push({ id: 'cleanWorkingTree', status: git.status === 'passed' && !git.stdout.trim() ? 'passed' : 'failed', detail: git.status === 'passed' ? (git.stdout.trim() || 'Working tree clean') : (git.stderr || 'git status failed') });
    }
    const commands = [];
    for (const entry of policy.commands) commands.push({ id: entry.id, ...await runCommand(entry.command, thread.cwd, entry.timeoutMs) });
    const failed = [...checks, ...commands].some(result => result.status !== 'passed');
    const report = {
      schemaVersion: 1, reportId: `verification_${randomUUID()}`, threadId: thread.id,
      turnId: turn?.id ?? null, mode: policy.mode, status: failed ? 'failed' : 'passed',
      startedAt, completedAt: Date.now(), checks, commands,
    };
    report.contentDigest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    thread.verificationGate = { policy, latestReport: report };
    if (turn) {
      this.runtime.core.dispatch({ threadId: thread.id, turnId: turn.id, type: 'verification.updated', payload: { report }, timestamp: report.completedAt });
      this.runtime.execution.sync(thread);
    }
    return report;
  }
}

module.exports = { VerificationGates, normalizePolicy, DEFAULT_CHECKS };
