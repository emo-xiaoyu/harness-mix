// Projection boundary only. Execution, persistence and native approvals belong
// to Harness Mix HostRuntime / ProtocolCore and their existing adapters.
const { getHarnessSvg } = require('./icons');
const { prepareInput } = require('./input');
const { projectUsage } = require('./usage');
const { exec } = require('node:child_process');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { diff } = require('../workspace/diff');
const ALIASES = { workbuddy: 'codebuddy', 'claude-code': 'claude', 'deepseek-harness': 'dsh', 'codex-harness': 'codex' };
const externalId = id => ({ workbuddy: 'codebuddy', claude: 'claude-code', dsh: 'deepseek-harness', codex: 'codex-harness' }[id] || id);
const modelRef = model => ({ id: Buffer.from(JSON.stringify({ id: model.id, provider: model.provider })).toString('base64url') });
const routeModel = harnessId => ['pi', 'claude-code', 'deepseek-harness', 'antigravity', 'omp', 'opencode', 'grok'].includes(harnessId)
  ? `codexhost/${harnessId}-native`
  : `codexhost/plugin-v1@${Buffer.from(JSON.stringify({ harnessId })).toString('hex')}`;
const terminal = status => ['completed', 'cancelled', 'error', 'failed'].includes(status);
const turnStatus = status => ({ cancelled: 'interrupted', error: 'failed', failed: 'failed', completed: 'completed' }[status] || 'inProgress');

const HARNESS_INSTALL_COMMANDS = {
  qoder: { win32: 'npm install -g @qoder-ai/qodercli', default: 'npm install -g @qoder-ai/qodercli' },
  codex: { win32: 'npm install -g @openai/codex', default: 'npm install -g @openai/codex' },
  'codex-harness': { win32: 'npm install -g @openai/codex', default: 'npm install -g @openai/codex' },
  pi: { win32: 'npm install -g @mariozechner/pi-coding-agent', default: 'npm install -g @mariozechner/pi-coding-agent' },
  'claude-code': { win32: 'npm install -g @anthropic-ai/claude-code', default: 'npm install -g @anthropic-ai/claude-code' },
  'deepseek-harness': { win32: 'pip install deepseek-harness', default: 'pip3 install deepseek-harness' },
  opencode: { win32: 'npm install -g opencode-ai', default: 'npm install -g opencode-ai' },
  grok: { win32: 'npm install -g @xai/grok-cli', default: 'npm install -g @xai/grok-cli' },
  omp: { win32: 'npm install -g @oh-my-prompt/omp', default: 'npm install -g @oh-my-prompt/omp' },
  antigravity: { win32: 'npm install -g @google/antigravity-cli', default: 'npm install -g @google/antigravity-cli' },
  openclaw: { win32: 'npm install -g openclaw', default: 'npm install -g openclaw' },
  hermes: { win32: 'pip install hermes-agent', default: 'pip3 install hermes-agent' },
};

const MODEL_REF_ID = /^[A-Za-z0-9._~-]{1,512}$/;
// Positional suffix contract of the versioned Renderer adapter transport ids.
// Mirrors transportModelId()/decode*TransportModelId() in
// src/native-ui/renderer-extension/src/versioned-renderer-adapter.ts exactly.
const LEGACY_SUFFIX_FIELDS = {
  pi: ['model', 'thinkingOptionId'],
  'claude-code': ['model', 'permissionModeId', 'thinkingOptionId'],
  'deepseek-harness': ['model', 'permissionModeId'],
  antigravity: ['model', 'permissionModeId', 'thinkingOptionId'],
  opencode: ['model', 'permissionModeId', 'thinkingOptionId'],
  grok: ['model', 'permissionModeId', 'thinkingOptionId'],
  // OMP（Pi 家族）：两段式是 model@thinking，三段式才是 model@permission@thinking
  omp: ['model', 'thinkingOptionId'],
};

function decodeLegacySuffix(harnessId, suffix) {
  const fields = LEGACY_SUFFIX_FIELDS[harnessId];
  const parts = suffix.split('@');
  if (parts.length > 3) throw new Error('Invalid native Harness route');
  // OMP 特例：三段式 model@permission@thinking（中间槽可为空），两段式 model@thinking
  if (harnessId === 'omp' && parts.length === 3) return decodePositional(harnessId, ['model', 'permissionModeId', 'thinkingOptionId'], parts);
  if (parts.length > fields.length) throw new Error('Invalid native Harness route');
  return decodePositional(harnessId, fields, parts);
}

function decodePositional(harnessId, fields, parts) {
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
  const legacy = /^codexhost\/(pi|claude-code|deepseek-harness|antigravity|omp|opencode|grok)-native(?:@(.+))?$/.exec(model);
  if (!legacy) return null;
  return legacy[2] === undefined ? { harnessId: legacy[1] } : decodeLegacySuffix(legacy[1], legacy[2]);
}

// file_change 的 diff 载体有三种形态：字符串 unified diff（codex 原生）、
// workspace/diff 的结果对象 {rows}（canonicalChanges/审查快照）、或裸 before/after。
// 统一规范化为完整 git 风格 unified diff：Desktop 以 `diff --git a/x b/x` 头切分文件并
// 提取干净路径，且只在 `@@` hunk 头之后才开始计数增删行——两者缺失都会显示 +0 -0。
function unifiedBody(change) {
  if (typeof change.diff === 'string' && change.diff.trim()) return change.diff;
  if (typeof change.patch === 'string' && change.patch.trim()) return change.patch;
  const rows = Array.isArray(change.patch?.rows) ? change.patch.rows
    : (typeof change.before === 'string' || typeof change.after === 'string') ? diff(change.before || '', change.after || '').rows
      : null;
  if (!rows?.length) return '';
  const removed = rows.filter(row => row.kind !== 'add').length;
  const added = rows.filter(row => row.kind !== 'remove').length;
  const hunk = `@@ -${removed ? `1,${removed}` : '0,0'} +${added ? `1,${added}` : '0,0'} @@`;
  return [hunk, ...rows.map(row => (row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ') + row.text)].join('\n');
}

function unifiedDiff(change, kindType) {
  const body = unifiedBody(change);
  if (/^diff --git /m.test(body)) return body; // 已是完整 unified diff，原样透传
  const file = change.path || change.file || '';
  const headers = kindType === 'add' ? ['--- /dev/null', `+++ b/${file}`]
    : kindType === 'delete' ? [`--- a/${file}`, '+++ /dev/null']
      : [`--- a/${file}`, `+++ b/${file}`];
  return [`diff --git a/${file} b/${file}`, ...(/^---\s/m.test(body) ? [] : headers), body].filter(Boolean).join('\n');
}

function projectItem(item) {
  const base = { id: item.id };
  if (item.type === 'user_message') return { ...base, type: 'userMessage', content: [
    { type: 'text', text: item.content || '', text_elements: [] },
    ...(item.attachments || []).filter(a => a.kind === 'image').map(a => a.data
      ? { type: 'image', url: `data:${a.mime || 'image/png'};base64,${a.data}` }
      : a.path ? { type: 'localImage', path: a.path } : { type: 'text', text: `[图片：${a.name}]`, text_elements: [] }),
  ] };
  if (item.type === 'agent_message' || item.type === 'notice') return { ...base, type: 'agentMessage', text: item.content || '', phase: item.phase || 'final' };
  if (item.type === 'reasoning') return { ...base, type: 'reasoning', summary: [item.content || ''], content: [] };
  if (item.type === 'tool_call' && item.collaboration) {
    const job = item.collaboration;
    const status = ({ completed: 'completed', failed: 'errored', cancelled: 'interrupted', interrupted: 'interrupted' })[job.status] || 'running';
    return { ...base, type: 'collabAgentToolCall', tool: job.operation || 'spawnAgent',
      status: terminal(item.status) ? (item.state === 'error' ? 'failed' : 'completed') : 'inProgress',
      senderThreadId: job.parent_thread_id, receiverThreadIds: job.child_thread_id ? [job.child_thread_id] : [],
      prompt: job.task || null, model: null, reasoningEffort: null,
      agentsStates: job.child_thread_id ? { [job.child_thread_id]: { status,
        message: job.attention?.message || job.attention?.title || job.result || job.error || null } } : {} };
  }
  if (item.type === 'tool_call') return { ...base, type: 'mcpToolCall', server: 'harness-mix', tool: item.title || 'tool',
    arguments: item.input || {}, status: terminal(item.status) ? (item.state === 'error' ? 'failed' : 'completed') : 'inProgress',
    result: item.output ? { content: [{ type: 'text', text: String(item.output) }], structuredContent: null } : null,
    error: item.state === 'error' ? { message: String(item.output || item.detail || 'Tool failed') } : null, durationMs: null };
  if (item.type === 'file_change') return { ...base, type: 'fileChange', status: terminal(item.status) ? 'completed' : 'inProgress',
    changes: (item.changes || [item]).map(change => {
      const kind = change.changeType === 'deleted' ? { type: 'delete' } : change.changeType === 'added' ? { type: 'add' } : { type: 'update', move_path: null };
      return { path: change.path || change.file || '', kind, diff: unifiedDiff(change, kind.type) };
    }) };
  return null;
}

class NativeProtocol {
  constructor(runtime, emit, requestOfficial = null) {
    this.runtime = runtime;
    this.emit = emit;
    this.requestOfficial = requestOfficial;
    this.approvals = new Map();
    this.published = new Map();
    this.steering = new Map();      // threadId -> in-flight steer promise
    this.steerReceipts = new Map(); // `${threadId}\0${clientUserMessageId}` -> bounded delivery receipt
    this.unsubscribe = runtime.core.subscribe(({ event, projected }) => this.onCore(event, projected));
    // Host 侧新建的线程（协作子任务等）也要通知 Desktop 侧栏，与 thread/start 同一契约
    this.unsubscribeRuntime = runtime.subscribe(event => {
      if (event?.type === 'thread-created' && event.thread) this.emit({ method: 'thread/started', params: { thread: this.projectThread(event.thread) } });
    });
  }
  thread(id) { return this.runtime.threads.find(t => t.id === id); }
  owns(id) { return Boolean(this.thread(id)); }
  turn(turn) { return { id: turn.id, status: turnStatus(turn.status), error: turn.error ? { message: String(turn.error), codexErrorInfo: null, additionalDetails: null } : null,
    items: this.runtime.core.getItemsForTurn(turn.id).map(projectItem).filter(Boolean) }; }
  projectThread(thread, includeTurns = true) {
    // Projection shape mirrors the upstream codexhost external-thread contract: every
    // field the Desktop sidebar/composer reads must be present with the same defaults.
    const updatedAt = Math.floor((thread.updatedAt || thread.createdAt) / 1000);
    return { id: thread.id, preview: thread.messages.find(m => m.role === 'user')?.text || thread.title,
      ephemeral: thread.ephemeral === true, modelProvider: 'codexhost', model: routeModel(externalId(thread.harnessId)), reasoningEffort: null,
      section: thread.section ?? null, sectionEnteredAt: thread.sectionEnteredAt ?? null, projectId: thread.projectId ?? null,
      createdAt: Math.floor(thread.createdAt / 1000),
      updatedAt, recencyAt: updatedAt,
      status: { type: thread.status === 'working' ? 'active' : 'idle', ...(thread.status === 'working' ? { activeFlags: [] } : {}) },
      path: null, cwd: thread.cwd, cliVersion: 'codexhost', source: 'vscode', threadSource: null,
      name: thread.title || null, agentNickname: thread.parentThreadId ? this.runtime.adapters.get(thread.harnessId)?.manifest.name || thread.harnessId : null,
      agentRole: thread.parentThreadId ? 'worker' : null, gitInfo: thread.gitInfo || null,
      sessionId: thread.id, forkedFromId: thread.forkedFrom ?? null, parentThreadId: thread.parentThreadId ?? null,
      // 跨 Harness 原地切换血缘：链上每条是某 Harness 曾用的原生会话引用（切回可 resume）
      harnessChain: (thread.harnessChain ?? []).map(e => ({ harnessId: externalId(e.harnessId), at: e.at })),
      pendingHarnessSwitch: thread.pendingHandoff ? { fromHarnessId: externalId(thread.pendingHandoff.fromHarnessId), note: thread.pendingHandoff.note ?? null } : null,
      canAcceptDirectInput: true, historyMode: 'legacy', isPinned: false, extra: null,
      isolation: thread.isolation ?? 'shared',
      workspace: thread.workspace ? { mode: thread.workspace.mode, branch: thread.workspace.branch, root: thread.workspace.root } : null,
      turns: includeTurns ? this.runtime.core.turns.turnsForThread(thread.id).map(t => this.turn(t)) : [] };
  }
  capabilities(id, catalog) {
    const cap = this.runtime.getCapabilities(id);
    return { configuration: { selectModel: Boolean(cap.model?.selection), selectThinkingOption: Boolean(cap.model?.thinkingLevel),
      selectPermissionMode: Boolean(catalog.permissionModes?.length), permissionModeScope: 'live' },
    history: { fork: Boolean(cap.session?.fork), forkAcrossCwd: false, rollbackLastTurn: Boolean(cap.session?.forkFromMessage) } };
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
      const levelId = entry => (typeof entry === 'string' ? entry : entry?.id);
      // 模型级 efforts（Claude/DSH/OpenCode 按模型声明）并入全局档位表（共享契约要求 supported ⊆ thinkingOptions）
      for (const sourceModel of catalog.models || []) {
        for (const entry of sourceModel.efforts || []) {
          const id = levelId(entry);
          if (id && !thinkingOptions.some(o => o.id === id)) {
            thinkingOptions.push({ id, label: (typeof entry === 'object' && entry?.label) || id });
          }
        }
      }
      // adapter 可在 thinkingLevels 某一项上声明 default: true（如 Antigravity 的 high），
      // 作为该 Harness 的安全预选档；未声明则不预选，由原生会话自身默认档生效。
      const defaultThinking = (catalog.thinkingLevels || []).find(x => x.default === true)?.id;
      const thinkingIds = thinkingOptions.map(o => o.id);
      const sourceModels = catalog.models || [];
      const models = sourceModels.map(m => {
        // 模型显式声明了 efforts（含空数组）以模型为准；未声明则适用全部全局档位
        const supported = Array.isArray(m.efforts)
          ? m.efforts.map(levelId).filter(id => id && thinkingIds.includes(id))
          : thinkingIds;
        return { ref: modelRef(m), label: m.name || m.id,
          ...(supported.length ? { supportedThinkingOptionIds: supported } : {}) };
      });
      // The renderer draft flow requires a default model for its initial selection.
      const defaultSource = sourceModels.find(m => m && m.isDefault === true) || sourceModels[0];
      const result = { status: 'ready', catalog: { models, ...(defaultSource ? { defaultModel: modelRef(defaultSource) } : {}), thinkingOptions,
        ...(defaultThinking ? { defaultThinkingOptionId: defaultThinking } : {}) }, capabilities: this.capabilities(local, catalog) };
      if (catalog.permissionModes?.length) result.permissionModes = { modes: catalog.permissionModes.map(m => ({ id: m.id, label: m.label || m.name || m.id, ...(m.description ? { description: m.description } : {}) })), defaultModeId: catalog.permissionModes.find(m => m.default)?.id || catalog.permissionModes[0].id };
      return result;
    } catch (error) { return { status: 'error', error: { code: 'INSPECTION_FAILED', message: error.message, retryable: true } }; }
  }
  configuration(thread) {
    const catalogEntry = this.runtime.catalogs?.get(thread.harnessId);
    const models = catalogEntry?.models || thread.models || [];
    const configured = thread.options?.model;
    const actual = thread.model;
    const exact = candidate => candidate && models.find(model => modelRef(model).id === modelRef(candidate).id);
    // Native runtime names can be resolved aliases, and older Pi records omitted
    // their provider. Prefer the explicitly selected catalog identity, then a
    // unique native match; never guess between providers with the same model id.
    const matches = actual ? models.filter(model => model.id === actual.id && (!actual.provider || model.provider === actual.provider)) : [];
    const selected = exact(configured) || exact(actual) || (matches.length === 1 ? matches[0] : null) || actual || configured;
    // 当前模型适用的思考档位：模型声明了 efforts 以模型为准，否则适用全局目录
    const levelId = entry => (typeof entry === 'string' ? entry : entry?.id);
    const globalLevels = (catalogEntry?.thinkingLevels || []).map(l => ({ id: l.id, label: l.label || l.id }));
    const selectedEntry = selected ? models.find(m => m.id === selected.id && (!selected.provider || !m.provider || m.provider === selected.provider)) : null;
    const thinkingOptions = Array.isArray(selectedEntry?.efforts)
      ? selectedEntry.efforts.map(entry => {
        const id = levelId(entry);
        return id ? { id, label: (typeof entry === 'object' && entry?.label) || id } : null;
      }).filter(Boolean)
      : globalLevels;
    const thinking = thread.options?.thinking;
    return { ...(selected ? { effectiveModel: modelRef(selected) } : {}),
      // 可选集合存在时，生效档位必须属于其中（共享契约校验）；目录未加载时保留原样
      ...(thinking && (!thinkingOptions.length || thinkingOptions.some(o => o.id === thinking)) ? { effectiveThinkingOptionId: thinking } : {}),
      ...(thinkingOptions.length ? { availableThinkingOptions: thinkingOptions } : {}),
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
    if (method === 'codexhost/harness/session-import/sources') return this.runtime.history.sources();
    if (method === 'codexhost/harness/session-import/list') return this.runtime.history.list(params);
    if (method === 'codexhost/harness/session-import/import') return this.runtime.history.import(params);
    if (method === 'codexhost/collaboration/agents') return [...this.runtime.adapters.values()].map(a => ({ id: externalId(a.manifest.id), name: a.manifest.name, available: !!this.runtime.status[a.manifest.id]?.available, lead: a.manifest.capabilities?.collaborationTools === true }));
    const thread = this.thread(params.threadId);
    if (method === 'harness-mix/runtime/inspect') return { owner: 'harness-mix', runtime: 'src/main/host/runtime.js', core: 'src/main/protocol-core/protocol-core.js', threads: this.runtime.threads.length };
    // No additional managed accounts: native Codex keeps its own signed-in account.
    if (method === 'codexhost/account/list' || method === 'codexhost/account/refresh') return { accounts: [] };
    if (method === 'codexhost/harness/plugins/list') return { plugins: this.runtime.snapshot().adapters.map(a => ({ id: externalId(a.id), name: a.id === 'codex' ? 'Codex（协作）' : a.name, version: '0.1.0', icon: `data:image/svg+xml;base64,${Buffer.from(getHarnessSvg(a.id)).toString('base64')}` })) };
    if (method === 'codexhost/harness/inspect') return this.inspect(params.harnessId);
    if (method === 'codexhost/harness/install') {
      const local = ALIASES[params.harnessId] || params.harnessId;
      const entry = HARNESS_INSTALL_COMMANDS[params.harnessId] || HARNESS_INSTALL_COMMANDS[local];
      if (!entry) throw new Error(`No installation command available for harness: ${params.harnessId}`);
      const command = (process.platform === 'win32' ? entry.win32 : entry.default) || entry.default;
      return new Promise((resolve) => {
        exec(command, { timeout: 180000, shell: true }, async (err, stdout, stderr) => {
          const adapter = this.runtime.adapters.get(local);
          if (adapter) {
            try {
              const inspection = await adapter.inspect();
              this.runtime.status[local] = inspection;
              if (inspection.available) this.runtime.catalogs.delete(local);
            } catch (e) {
              this.runtime.status[local] = { available: false, detail: e.message };
            }
          }
          if (err) {
            resolve({ success: false, command, error: err.message, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
          } else {
            resolve({ success: true, command, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
          }
        });
      });
    }
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
      const isWorktree = params.worktree === true || params.options?.worktree === true;
      const created = await this.runtime.createThread({ harnessId: id, cwd: params.cwd, ephemeral: params.ephemeral === true,
        worktree: isWorktree,
        options: {
          model: await this.resolveModel(id, route.model), thinking: route.thinkingOptionId, permissionMode: route.permissionModeId,
          ...(isWorktree ? { worktree: true } : {}),
        } });
      if (created.error) throw new Error(created.error);
      const result = { thread: this.projectThread(created), model: params.model, modelProvider: 'harness-mix', cwd: created.cwd,
        approvalPolicy: params.approvalPolicy || 'on-request', sandbox: params.sandbox || { type: 'workspaceWrite', writableRoots: [created.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null };
      // thread/started 已由 runtime 的 thread-created 监听统一发出（含协作子任务路径）
      return result;
    }
    if (method === 'codexhost/thread/workspace/review') return this.runtime.reviewThreadWorkspace(params.threadId);
    if (method === 'codexhost/thread/workspace/apply') return this.runtime.applyThreadWorkspace(params.threadId, params.digest);
    if (!thread) {
      if (method.startsWith('codexhost/')) throw new Error(`Harness Mix does not implement ${method}`);
      return undefined;
    }
    if (method === 'thread/read') return { thread: this.projectThread(thread, params.includeTurns !== false) };
    // External sessions currently accept immediate turns only, so their Desktop
    // submission queue is empty. Do not forward their IDs to the stock server.
    if (method === 'thread/queue/list') return { data: [], nextCursor: null };
    if (method === 'thread/metadata/update') return { thread: this.projectThread(await this.runtime.updateThreadMetadata(thread.id, params.gitInfo)) };
    if (method === 'thread/section/move') {
      if (params.sectionId !== null && (typeof params.sectionId !== 'string' || !params.sectionId)) throw new Error('Invalid sectionId');
      let section = null;
      if (params.sectionId !== null) {
        if (!this.requestOfficial) throw new Error('Official section catalog unavailable');
        let cursor = null;
        do {
          const page = await this.requestOfficial('threadSection/list', { cursor, limit: 100 });
          section = page.data.find(entry => entry.id === params.sectionId) || null;
          cursor = page.nextCursor;
        } while (!section && cursor);
        if (!section) throw new Error('Unknown thread section');
      }
      await this.runtime.setThreadSection(thread.id, section, params.beforeThreadId);
      return {};
    }
    if (method === 'thread/resume') return { thread: this.projectThread(thread), model: routeModel(externalId(thread.harnessId)), modelProvider: 'harness-mix', cwd: thread.cwd, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null };
    if (method === 'turn/start') {
      const { text, attachments } = await prepareInput(params.input, thread.cwd);
      return { turn: this.turn(await this.startNativeTurn(thread, text, attachments)) };
    }
    // External steering: cancel the active Turn, wait for it to fully settle, then start
    // the new input as a real new Turn. Never guess a stale target, never auto-start on
    // failure, and never let a concurrent start race the replacement.
    if (method === 'turn/steer') {
      const input = Array.isArray(params.input) ? params.input : [];
      // Reject before touching the active Turn; nothing is silently dropped mid-flight.
      if (!input.length) {
        throw new Error('Native steering currently accepts non-empty text input only');
      }
      const { text, attachments } = await prepareInput(input, thread.cwd);
      if (!text.trim() && !attachments.length) throw new Error('Native steering requires non-empty text or images');
      if (attachments.length && !this.runtime.getCapabilities(thread.harnessId).conversation.attachments) throw new Error('当前 Harness 不支持图片附件');
      const expectedTurnId = params.expectedTurnId;
      if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw new Error('Native steering requires the active Turn identity');
      return this.steerThread(thread, {
        expectedTurnId,
        text,
        attachments,
        messageKey: typeof params.clientUserMessageId === 'string' && params.clientUserMessageId
          ? `${thread.id}\0${params.clientUserMessageId}` : null,
        fingerprint: JSON.stringify({ expectedTurnId, input }),
      });
    }
    if (method === 'turn/interrupt') { await this.runtime.cancel(thread.id); return {}; }
    // 跨 Harness 任务协作：委派新子任务 / 跟进既有子任务，等待链由父线程协作 Turn 承载
    if (method === 'codexhost/thread/delegate' || method === 'codexhost/thread/message') {
      const task = params.task ?? params.text;
      if (typeof task !== 'string' || !task.trim()) throw new Error('Delegation requires a non-empty task');
      const { child, turn } = await this.runtime.delegateTask({
        fromThreadId: thread.id,
        harnessId: method === 'codexhost/thread/delegate' ? (ALIASES[params.harnessId] || params.harnessId) : undefined,
        childThreadId: method === 'codexhost/thread/message' ? params.childThreadId : undefined,
        task,
      });
      return { turn: this.turn(turn), childThreadId: child.id };
    }
    if (method === 'thread/rollback') return { thread: this.projectThread(await this.runtime.rollbackThread(thread.id, params.numTurns)) };
    if (method === 'thread/name/set') { await this.runtime.renameThread(thread.id, params.name); return {}; }
    if (method === 'thread/archive' || method === 'thread/unarchive') { await this.runtime.setThreadArchived(thread.id, method === 'thread/archive'); return method === 'thread/archive' ? {} : { thread: this.projectThread(thread) }; }
    if (method === 'thread/loaded/list') return { data: [...this.runtime.sessions.keys()] };
    if (method === 'codexhost/thread/usage/inspect') {
      const usage = params.refresh === 'exact' ? await this.runtime.refreshUsage(thread.id) : this.runtime.core.getThread(thread.id)?.usage;
      return { threadId: thread.id, usage: projectUsage(usage) };
    }
    if (method === 'codexhost/thread/command/execute') {
      if (params.arguments && Object.keys(params.arguments).length) throw new Error('This command does not accept arguments');
      const turn = await this.startNativeTurn(thread, '', undefined, params.commandId);
      return { accepted: true, turnId: turn.id };
    }
    if (method === 'codexhost/thread/model/select') { await this.runtime.setModel(thread.id, await this.resolveModel(thread.harnessId, params.model)); return this.configuration(thread); }
    if (method === 'codexhost/thread/thinking/select') { await this.runtime.setThinking(thread.id, params.thinkingOptionId); return this.configuration(thread); }
    if (method === 'codexhost/thread/permission-mode/select') { await this.runtime.setOptions(thread.id, { permissionMode: params.permissionModeId }); return this.configuration(thread); }
    // 原地切换 Harness：会话历史保留，下条消息携带一次性上下文信封（/switch 指令的 RPC 等价物）
    if (method === 'codexhost/thread/harness/switch') {
      await this.runtime.switchHarness(thread.id, ALIASES[params.harnessId] || params.harnessId, { note: typeof params.note === 'string' ? params.note : undefined });
      return { threadId: thread.id };
    }
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
    if (event.type === 'usage.updated') this.emit({ method: 'codexhost/thread/usage/updated', params: { threadId, usage: projectUsage(projected.thread?.usage) } });
    if (projected.items) {
      for (const file of projected.items) this.onCore({ ...event, type: 'item.updated' }, { item: file });
      notify('turn/diff/updated', { diff: projected.items.map(i => projectItem(i)?.changes?.map(c => c.diff).filter(Boolean).join('\n')).filter(Boolean).join('\n') });
    }
    if (event.type === 'plan.updated' && item) notify('turn/plan/updated', { explanation: null, plan: (item.entries || []).map(e => ({ step: e.text || e.title || e.step, status: e.status === 'done' || e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'inProgress' : 'pending' })) });
    if (event.type === 'turn.started') {
      notify('turn/started', { turn: this.turn(projected.turn) });
      // The Desktop sidebar spinner is driven by thread/status/changed, not by
      // turn lifecycle events alone — mirror the official app-server contract.
      notify('thread/status/changed', { status: { type: 'active', activeFlags: [] } });
    }
    if (item) {
      const converted = projectItem(item);
      if (converted) {
        const previous = this.published.get(item.id);
        if (!previous) notify('item/started', { item: converted });
        if (item.type === 'agent_message' && item.content?.length > (previous?.content?.length || 0)) notify('item/agentMessage/delta', { itemId: item.id, delta: item.content.slice(previous?.content?.length || 0) });
        if (item.type === 'reasoning' && item.content?.length > (previous?.content?.length || 0)) notify('item/reasoning/summaryTextDelta', { itemId: item.id, summaryIndex: 0, delta: item.content.slice(previous?.content?.length || 0) });
        if (terminal(item.status) && (!terminal(previous?.status) || ['file_change', 'tool_call'].includes(item.type) && JSON.stringify(converted) !== JSON.stringify(projectItem(previous)))) notify('item/completed', { item: converted });
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
    if (event.type === 'turn.waiting') notify('thread/status/changed', { status: { type: 'active', activeFlags: [] } });
    if (event.type === 'turn.resumed') notify('thread/status/changed', { status: { type: 'active', activeFlags: [] } });
    if (event.type.startsWith('turn.') && projected.turn && terminal(projected.turn.status)) {
      notify('turn/completed', { turn: this.turn(projected.turn) });
      notify('thread/status/changed', { status: { type: 'idle' } });
    }
  }
  async startNativeTurn(thread, text, attachments, commandId) {
    const before = thread.currentTurn?.id;
    let failure;
    const running = (commandId ? this.runtime.executeCommand(thread.id, commandId) : this.runtime.send(thread.id, text, { attachments })).catch(error => { failure = error; });
    for (let attempt = 0; attempt < 600 && thread.currentTurn?.id === before && !failure; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    if (failure) throw failure;
    if (!thread.currentTurn || thread.currentTurn.id === before) throw new Error('Native turn did not start');
    void running;
    return thread.currentTurn;
  }
  async steerThread(thread, { expectedTurnId, text, attachments, messageKey, fingerprint }) {
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
    const work = this.steerExclusive(thread, expectedTurnId, text, attachments);
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
  async steerExclusive(thread, expectedTurnId, text, attachments) {
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
    const started = await this.startNativeTurn(thread, text, attachments);
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
  close() { this.unsubscribe(); this.unsubscribeRuntime(); }
}
module.exports = { NativeProtocol, decodeRoute, projectItem, externalId, routeModel };
