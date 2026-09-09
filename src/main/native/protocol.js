// Projection boundary only. Execution, persistence and native approvals belong
// to Harness Mix HostRuntime / ProtocolCore and their existing adapters.
const { getHarnessSvg } = require('./icons');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { diff } = require('../workspace/diff');
const ALIASES = { 'claude-code': 'claude', 'deepseek-harness': 'dsh' };
const externalId = id => ({ claude: 'claude-code', dsh: 'deepseek-harness' }[id] || id);
const modelRef = model => ({ id: Buffer.from(JSON.stringify({ id: model.id, provider: model.provider })).toString('base64url') });
const routeModel = harnessId => `codexhost/plugin-v1@${Buffer.from(JSON.stringify({ harnessId })).toString('hex')}`;
const terminal = status => ['completed', 'cancelled', 'error', 'failed'].includes(status);
const turnStatus = status => ({ cancelled: 'interrupted', error: 'failed', failed: 'failed', completed: 'completed' }[status] || 'inProgress');

const MODEL_REF_ID = /^[A-Za-z0-9._~-]{1,512}$/;
// Positional suffix contract of the versioned Renderer adapter transport ids.
const LEGACY_SUFFIX_FIELDS = {
  pi: ['model', 'thinkingOptionId'],
  'claude-code': ['model', 'permissionModeId', 'thinkingOptionId'],
  'deepseek-harness': ['model', 'permissionModeId'],
  antigravity: ['model', 'permissionModeId', 'thinkingOptionId'],
};

function decodeLegacySuffix(harnessId, suffix) {
  const fields = LEGACY_SUFFIX_FIELDS[harnessId];
  const parts = suffix.split('@');
  if (parts.length > fields.length) throw new Error('Invalid native Harness route');
  const route = { harnessId };
  parts.forEach((part, index) => {
    // Optional middle slots may be empty (e.g. model@@thinkingOption).
    if (!part) return;
    const field = fields[index];
    if (field === 'model') {
      if (!MODEL_REF_ID.test(part)) throw new Error('Invalid native Harness route');
      route.model = { id: part };
    } else {
      route[field] = part;
    }
  });
  return route;
}

function decodeRoute(model) {
  if (typeof model !== 'string') return null;
  if (model.startsWith('codexhost/plugin-v1@')) {
    const hex = model.slice('codexhost/plugin-v1@'.length);
    if (model.length > 4096 || !/^(?:[a-f0-9]{2})+$/.test(hex)) throw new Error('Invalid native Harness route');
    const route = JSON.parse(Buffer.from(hex, 'hex').toString());
    if (!route.harnessId || route.harnessId === 'codex') throw new Error('Invalid external Harness');
    return route;
  }
  const legacy = /^codexhost\/(pi|claude-code|deepseek-harness|antigravity)-native(?:@(.+))?$/.exec(model);
  if (!legacy) return null;
  return legacy[2] === undefined ? { harnessId: legacy[1] } : decodeLegacySuffix(legacy[1], legacy[2]);
}

function projectItem(item) {
  const base = { id: item.id };
  if (item.type === 'user_message') return { ...base, type: 'userMessage', content: [{ type: 'text', text: item.content || '', text_elements: [] }] };
  if (item.type === 'agent_message' || item.type === 'notice') return { ...base, type: 'agentMessage', text: item.content || '', phase: item.phase || 'final' };
  if (item.type === 'reasoning') return { ...base, type: 'reasoning', summary: [item.content || ''], content: [] };
  if (item.type === 'tool_call') return { ...base, type: 'mcpToolCall', server: 'harness-mix', tool: item.title || 'tool',
    arguments: item.input || {}, status: terminal(item.status) ? (item.state === 'error' ? 'failed' : 'completed') : 'inProgress',
    result: item.output ? { content: [{ type: 'text', text: String(item.output) }], structuredContent: null } : null,
    error: item.state === 'error' ? { message: String(item.output || item.detail || 'Tool failed') } : null, durationMs: null };
  if (item.type === 'file_change') return { ...base, type: 'fileChange', status: terminal(item.status) ? 'completed' : 'inProgress',
    changes: (item.changes || [item]).map(change => ({ path: change.path || change.file || '', kind: change.changeType === 'deleted' ? { type: 'delete' } : change.changeType === 'added' ? { type: 'add' } : { type: 'update', move_path: null }, diff: change.diff || change.patch || diff(change.before || '', change.after || '').rows.map(row => (row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ') + row.text).join('\n') })) };
  return null;
}

class NativeProtocol {
  constructor(runtime, emit) {
    this.runtime = runtime;
    this.emit = emit;
    this.approvals = new Map();
    this.published = new Map();
    this.steering = new Map();      // threadId -> in-flight steer promise
    this.steerReceipts = new Map(); // `${threadId}\0${clientUserMessageId}` -> bounded delivery receipt
    this.unsubscribe = runtime.core.subscribe(({ event, projected }) => this.onCore(event, projected));
  }
  thread(id) { return this.runtime.threads.find(t => t.id === id); }
  owns(id) { return Boolean(this.thread(id)); }
  turn(turn) { return { id: turn.id, status: turnStatus(turn.status), error: turn.error ? { message: String(turn.error), codexErrorInfo: null, additionalDetails: null } : null,
    items: this.runtime.core.getItemsForTurn(turn.id).map(projectItem).filter(Boolean) }; }
  projectThread(thread, includeTurns = true) {
    return { id: thread.id, preview: thread.messages.find(m => m.role === 'user')?.text || thread.title,
      ephemeral: thread.ephemeral === true, modelProvider: 'harness-mix', createdAt: Math.floor(thread.createdAt / 1000),
      updatedAt: Math.floor((thread.updatedAt || thread.createdAt) / 1000), status: { type: thread.status === 'working' ? 'active' : 'idle', ...(thread.status === 'working' ? { activeFlags: [] } : {}) },
      path: null, cwd: thread.cwd, cliVersion: 'harness-mix', source: 'appServer', name: thread.title,
      agentNickname: null, agentRole: null, gitInfo: null,
      turns: includeTurns ? this.runtime.core.turns.turnsForThread(thread.id).map(t => this.turn(t)) : [] };
  }
  capabilities(id, catalog) {
    const cap = this.runtime.getCapabilities(id);
    return { configuration: { selectModel: Boolean(cap.model?.selection), selectThinkingOption: Boolean(cap.model?.thinkingLevel),
      selectPermissionMode: Boolean(catalog.permissionModes?.length), permissionModeScope: 'live' },
    history: { fork: Boolean(cap.session?.fork), forkAcrossCwd: false, rollbackLastTurn: false } };
  }
  async inspect(id) {
    const local = ALIASES[id] || id;
    if (!this.runtime.adapters.has(local)) return { status: 'notInstalled', error: { code: 'UNSUPPORTED', message: `Harness Mix has no adapter for ${id}`, retryable: false } };
    if (!this.runtime.status[local]?.available) return { status: 'unavailable', error: { code: 'UNAVAILABLE', message: this.runtime.status[local]?.detail || 'Harness unavailable', retryable: true } };
    try {
      let catalog = await this.runtime.describe(local);
      if (catalog.models === null) {
        const adapter = this.runtime.adapters.get(local);
        const probe = await adapter.open({ thread: { cwd: os.tmpdir(), nativeSessionId: randomUUID(), options: {} }, emit: () => {}, diagnostic: () => {} });
        try { catalog = await adapter.describeFor(probe); this.runtime.catalogs.set(local, catalog); }
        finally { await adapter.close(probe); }
      }
      const thinkingOptions = (catalog.thinkingLevels || []).map(x => ({ id: x.id, label: x.label || x.id }));
      const sourceModels = catalog.models || [];
      const models = sourceModels.map(m => ({ ref: modelRef(m), label: m.name || m.id }));
      // The renderer draft flow requires a default model for its initial selection.
      const defaultSource = sourceModels.find(m => m && m.isDefault === true) || sourceModels[0];
      const result = { status: 'ready', catalog: { models, ...(defaultSource ? { defaultModel: modelRef(defaultSource) } : {}), thinkingOptions }, capabilities: this.capabilities(local, catalog) };
      if (catalog.permissionModes?.length) result.permissionModes = { modes: catalog.permissionModes.map(m => ({ id: m.id, label: m.label || m.name || m.id, ...(m.description ? { description: m.description } : {}) })), defaultModeId: catalog.permissionModes.find(m => m.default)?.id || catalog.permissionModes[0].id };
      return result;
    } catch (error) { return { status: 'error', error: { code: 'INSPECTION_FAILED', message: error.message, retryable: true } }; }
  }
  configuration(thread) {
    return { ...(thread.model ? { effectiveModel: modelRef(thread.model) } : {}),
      ...(thread.options?.thinking ? { effectiveThinkingOptionId: thread.options.thinking } : {}),
      ...(thread.options?.permissionMode ? { effectivePermissionModeId: thread.options.permissionMode } : {}) };
  }
  async resolveModel(harnessId, ref) {
    if (!ref) return undefined;
    const catalog = await this.runtime.describe(harnessId);
    const model = catalog.models.find(m => modelRef(m).id === ref.id);
    if (!model) throw new Error('Selected model is no longer in the native catalog');
    return model;
  }
  async request(method, params = {}) {
    const thread = this.thread(params.threadId);
    if (method === 'harness-mix/runtime/inspect') return { owner: 'harness-mix', runtime: 'src/main/host/runtime.js', core: 'src/main/protocol-core/protocol-core.js', threads: this.runtime.threads.length };
    // No additional managed accounts: native Codex keeps its own signed-in account.
    if (method === 'codexhost/account/list' || method === 'codexhost/account/refresh') return { accounts: [] };
    if (method === 'codexhost/harness/plugins/list') return { plugins: this.runtime.snapshot().adapters.filter(a => a.id !== 'codex').map(a => ({ id: externalId(a.id), name: a.name, version: '0.1.0', icon: `data:image/svg+xml;base64,${Buffer.from(getHarnessSvg(a.id)).toString('base64')}` })) };
    if (method === 'codexhost/harness/inspect') return this.inspect(params.harnessId);
    if (method === 'codexhost/harness/commands/inspect' || method === 'codexhost/thread/commands/inspect') {
      const commands = await this.runtime.listCommands({ threadId: params.threadId, harnessId: ALIASES[params.harnessId] || params.harnessId });
      return { commands: commands.map(c => ({ id: c.id, invocation: '/' + c.id, label: c.label || c.id, ...(c.description ? { description: c.description.slice(0, 512) } : {}), argumentMode: c.action === 'insert' ? 'text' : 'none' })) };
    }
    if (method === 'codexhost/thread/ownership/list') return { threads: params.threadIds.map(id => ({ threadId: id, owner: this.owns(id) ? 'external' : 'codex', ...(this.owns(id) ? { harnessId: externalId(this.thread(id).harnessId) } : {}) })) };
    if (method === 'codexhost/thread/inspect') {
      if (!thread) return { owner: 'codex', locked: true };
      const catalog = await this.runtime.describe(thread.harnessId);
      return { owner: 'external', harnessId: externalId(thread.harnessId), transportModelId: routeModel(externalId(thread.harnessId)), locked: true,
        ...this.configuration(thread), history: this.capabilities(thread.harnessId, catalog).history };
    }
    if (method === 'thread/start') {
      const route = decodeRoute(params.model);
      if (!route) return undefined;
      const id = ALIASES[route.harnessId] || route.harnessId;
      if (!this.runtime.adapters.has(id)) throw new Error(`Unsupported Harness: ${id}`);
      const created = await this.runtime.createThread({ harnessId: id, cwd: params.cwd, ephemeral: params.ephemeral === true, options: {
        model: await this.resolveModel(id, route.model), thinking: route.thinkingOptionId, permissionMode: route.permissionModeId } });
      if (created.error) throw new Error(created.error);
      const result = { thread: this.projectThread(created), model: params.model, modelProvider: 'harness-mix', cwd: created.cwd,
        approvalPolicy: params.approvalPolicy || 'on-request', sandbox: params.sandbox || { type: 'workspaceWrite', writableRoots: [created.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null };
      this.emit({ method: 'thread/started', params: { thread: result.thread } });
      return result;
    }
    if (!thread) {
      if (method.startsWith('codexhost/')) throw new Error(`Harness Mix does not implement ${method}`);
      return undefined;
    }
    if (method === 'thread/read') return { thread: this.projectThread(thread, params.includeTurns !== false) };
    if (method === 'thread/resume') return { thread: this.projectThread(thread), model: routeModel(externalId(thread.harnessId)), modelProvider: 'harness-mix', cwd: thread.cwd, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null };
    if (method === 'turn/start') {
      const unsupported = (params.input || []).filter(i => i.type !== 'text');
      if (unsupported.length) throw new Error('Native bridge currently accepts text input only');
      const text = (params.input || []).map(i => i.text).join('\n');
      return { turn: this.turn(await this.startNativeTurn(thread, text)) };
    }
    // External steering: cancel the active Turn, wait for it to fully settle, then start
    // the new input as a real new Turn. Never guess a stale target, never auto-start on
    // failure, and never let a concurrent start race the replacement.
    if (method === 'turn/steer') {
      const input = Array.isArray(params.input) ? params.input : [];
      // Reject before touching the active Turn; nothing is silently dropped mid-flight.
      if (!input.length || input.some(i => i.type !== 'text' || typeof i.text !== 'string')) {
        throw new Error('Native steering currently accepts non-empty text input only');
      }
      const text = input.map(i => i.text).join('\n');
      if (!text.trim()) throw new Error('Native steering currently accepts non-empty text input only');
      const expectedTurnId = params.expectedTurnId;
      if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw new Error('Native steering requires the active Turn identity');
      return this.steerThread(thread, {
        expectedTurnId,
        text,
        messageKey: typeof params.clientUserMessageId === 'string' && params.clientUserMessageId
          ? `${thread.id}\0${params.clientUserMessageId}` : null,
        fingerprint: JSON.stringify({ expectedTurnId, input }),
      });
    }
    if (method === 'turn/interrupt') { await this.runtime.cancel(thread.id); return {}; }
    if (method === 'thread/name/set') { await this.runtime.renameThread(thread.id, params.name); return {}; }
    if (method === 'thread/archive' || method === 'thread/unarchive') { await this.runtime.setThreadArchived(thread.id, method === 'thread/archive'); return method === 'thread/archive' ? {} : { thread: this.projectThread(thread) }; }
    if (method === 'thread/loaded/list') return { data: [...this.runtime.sessions.keys()] };
    if (method === 'codexhost/thread/usage/inspect') return { threadId: thread.id, usage: null };
    if (method === 'codexhost/thread/model/select') { await this.runtime.setModel(thread.id, await this.resolveModel(thread.harnessId, params.model)); return this.configuration(thread); }
    if (method === 'codexhost/thread/thinking/select') { await this.runtime.setThinking(thread.id, params.thinkingOptionId); return this.configuration(thread); }
    if (method === 'codexhost/thread/permission-mode/select') { await this.runtime.setOptions(thread.id, { permissionMode: params.permissionModeId }); return this.configuration(thread); }
    if (method === 'thread/fork' || method === 'codexhost/thread/fork') {
      const messageId = params.lastTurnId ? thread.messages.find(m => m.coreTurnId === params.lastTurnId)?.id : params.messageId;
      if (params.lastTurnId && !messageId) throw new Error('Unknown fork turn');
      const fork = await this.runtime.forkThread(thread.id, messageId);
      return method === 'codexhost/thread/fork' ? { threadId: fork.id } : { thread: this.projectThread(fork) };
    }
    throw new Error(`Harness Mix native bridge does not support ${method} for this thread`);
  }
  onCore(event, projected) {
    const { threadId, turnId } = event;
    const item = projected.item;
    const notify = (method, extra) => this.emit({ method, params: { threadId, turnId, ...extra } });
    if (projected.items) {
      for (const file of projected.items) this.onCore({ ...event, type: 'item.updated' }, { item: file });
      notify('turn/diff/updated', { diff: projected.items.map(i => projectItem(i)?.changes?.map(c => `--- a/${c.path}\n+++ b/${c.path}\n${c.diff}`).join('\n')).filter(Boolean).join('\n') });
    }
    if (event.type === 'plan.updated' && item) notify('turn/plan/updated', { explanation: null, plan: (item.entries || []).map(e => ({ step: e.text || e.title || e.step, status: e.status === 'done' || e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'inProgress' : 'pending' })) });
    if (event.type === 'turn.started') notify('turn/started', { turn: this.turn(projected.turn) });
    if (item) {
      const converted = projectItem(item);
      if (converted) {
        const previous = this.published.get(item.id);
        if (!previous) notify('item/started', { item: converted });
        if (item.type === 'agent_message' && item.content?.length > (previous?.content?.length || 0)) notify('item/agentMessage/delta', { itemId: item.id, delta: item.content.slice(previous?.content?.length || 0) });
        if (item.type === 'reasoning' && item.content?.length > (previous?.content?.length || 0)) notify('item/reasoning/summaryTextDelta', { itemId: item.id, summaryIndex: 0, delta: item.content.slice(previous?.content?.length || 0) });
        if (terminal(item.status) && (!terminal(previous?.status) || item.type === 'file_change' && JSON.stringify(item) !== JSON.stringify(previous))) notify('item/completed', { item: converted });
        this.published.set(item.id, structuredClone(item));
      }
      if (['approval', 'question'].includes(item.type) && event.type === 'item.started') {
        const id = `harness-mix:approval:${item.id}`;
        this.approvals.set(id, { threadId, requestId: item.requestId, item });
        const question = item.type === 'question' || item.method === 'select';
        this.emit({ id, method: question ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', params: {
          threadId, turnId, itemId: item.id,
          ...(question ? { questions: [{ id: item.requestId, header: 'Harness', question: item.message || item.title || 'Native Harness input', isOther: true, isSecret: false,
            options: item.options?.map(o => ({ label: typeof o === 'string' ? o : o.label || o.id, description: typeof o === 'string' ? o : o.description || o.label || o.id })) || null }] }
            : { reason: item.message || item.title, command: null, cwd: this.thread(threadId)?.cwd, availableDecisions: ['accept', 'decline'] }) } });
      }
    }
    if (event.type.startsWith('turn.') && projected.turn && terminal(projected.turn.status)) notify('turn/completed', { turn: this.turn(projected.turn) });
  }
  async startNativeTurn(thread, text) {
    const before = thread.currentTurn?.id;
    let failure;
    const running = this.runtime.send(thread.id, text).catch(error => { failure = error; });
    for (let attempt = 0; attempt < 600 && thread.currentTurn?.id === before && !failure; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    if (failure) throw failure;
    if (!thread.currentTurn || thread.currentTurn.id === before) throw new Error('Native turn did not start');
    void running;
    return thread.currentTurn;
  }
  async steerThread(thread, { expectedTurnId, text, messageKey, fingerprint }) {
    if (messageKey) {
      const receipt = this.steerReceipts.get(messageKey);
      // Outcome-unknown retry: identical payload returns the original receipt; a
      // conflicting payload under the same message identity is rejected.
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error('Conflicting steering payload for the same message');
        return { turnId: await receipt.promise };
      }
    }
    if (this.steering.has(thread.id)) throw new Error('This Thread is already changing direction');
    const work = this.steerExclusive(thread, expectedTurnId, text);
    this.steering.set(thread.id, work);
    if (messageKey) {
      if (this.steerReceipts.size >= 200) this.steerReceipts.delete(this.steerReceipts.keys().next().value);
      this.steerReceipts.set(messageKey, { fingerprint, promise: work });
    }
    try {
      return { turnId: await work };
    } finally {
      this.steering.delete(thread.id);
    }
  }
  async steerExclusive(thread, expectedTurnId, text) {
    const active = this.runtime.execution.isRunning(thread.id) ? thread.currentTurn : null;
    if (active) {
      if (active.id !== expectedTurnId) throw new Error('The active Turn no longer matches the steering target');
      await this.runtime.cancel(thread.id);
      // Cancel settles synchronously in Core, but the acknowledgement is not completion:
      // the replacement waits until the old Turn is fully terminal and the file-review
      // snapshot has settled (≤20s, shorter than the Desktop submission timeout).
      const settled = () => !this.runtime.execution.isRunning(thread.id) && !thread.reviewPending;
      const deadline = Date.now() + 20_000;
      while (!settled() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!settled()) throw new Error('Timed out waiting for the previous Turn to settle');
    } else {
      const last = thread.currentTurn;
      // A later Turn already exists, or the target was never this Thread's last Turn: stale.
      if (last && last.id !== expectedTurnId) throw new Error('The active Turn no longer matches the steering target');
    }
    // If a native Turn started on its own in the meantime, send() refuses and the new
    // Turn is left running; a failed replacement never cancels unexpected work.
    const started = await this.startNativeTurn(thread, text);
    return started.id;
  }
  async respond(message) {
    const pending = this.approvals.get(message.id);
    if (!pending) return false;
    if (message.error) throw new Error(message.error.message || 'Approval UI error');
    const answer = message.result?.answers?.[pending.requestId]?.answers?.[0];
    const decision = message.result?.decision;
    const response = pending.item.type === 'question' ? { value: answer || '' } : pending.item.method === 'select' ? { value: answer || '' } : { confirmed: decision === 'accept' || decision === 'acceptForSession' };
    await this.runtime.respondApproval(pending.threadId, pending.requestId, response);
    this.approvals.delete(message.id);
    return true;
  }
  close() { this.unsubscribe(); }
}
module.exports = { NativeProtocol, decodeRoute, projectItem, externalId, routeModel };
