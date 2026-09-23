// Projection boundary only. Execution, persistence and native approvals belong
// to Harness Mix HostRuntime / ProtocolCore and their existing adapters.
const { getHarnessSvg } = require('./icons');
const { prepareInput } = require('./input');
const { projectUsage, projectAccountCredits } = require('./usage');
const { exec, spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { diff } = require('../workspace/diff');
const {
  fetchLatestVersion,
  remoteState,
  makeGit,
  asyncRun,
  resolveRegistry,
} = require('./updater');
const {
  detectChannel,
  compareVersions,
  readState,
} = require('./update-state');
const { nativeEnvironment } = require('./config');
const { CodexAccountManager } = require('./codex-accounts');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

const ALIASES = { workbuddy: 'codebuddy', 'claude-code': 'claude', 'deepseek-harness': 'dsh', 'codex-harness': 'codex' };
const externalId = id => ({ workbuddy: 'codebuddy', claude: 'claude-code', dsh: 'deepseek-harness', codex: 'codex-harness' }[id] || id);
const { errorActions } = require('../harness-adapter/error-kind');
const modelRef = model => ({ id: Buffer.from(JSON.stringify({ id: model.id, provider: model.provider })).toString('base64url') });
const routeModel = harnessId => ['pi', 'claude-code', 'deepseek-harness', 'antigravity', 'omp', 'opencode', 'grok'].includes(harnessId)
  ? `harnessmix/${harnessId}-native`
  : `harnessmix/plugin-v1@${Buffer.from(JSON.stringify({ harnessId })).toString('hex')}`;
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
  grok: { win32: 'powershell -NoProfile -ExecutionPolicy Bypass -Command iex (irm https://x.ai/cli/install.ps1)', default: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
  omp: { win32: 'npm install -g @oh-my-pi/pi-coding-agent', default: 'npm install -g @oh-my-pi/pi-coding-agent' },
  antigravity: { win32: 'powershell -NoProfile -ExecutionPolicy Bypass -Command iex (irm https://antigravity.google/cli/install.ps1)', default: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
  openclaw: { win32: 'npm install -g openclaw', default: 'npm install -g openclaw' },
  hermes: { win32: 'pip install hermes-agent', default: 'pip3 install hermes-agent' },
  cline: { win32: 'npm install -g cline', default: 'npm install -g cline' },
};

const HARNESS_AUTH_INFO = {
  codex: { name: 'Codex', plan: 'OpenAI / Codex Desktop', label: 'Codex Desktop 内置登录', loginCommand: 'codex login', configHint: 'Codex 官方桌面客户端内置登录状态' },
  'claude-code': { name: 'Claude Code', plan: 'Anthropic Claude', label: 'Claude Code 授权', loginCommand: 'claude login', configHint: '~/.claude.json 或环境变量 ANTHROPIC_API_KEY' },
  'deepseek-harness': { name: 'DeepSeek Harness', plan: 'DeepSeek API', label: 'DeepSeek API Key', loginCommand: null, configHint: '环境变量 DEEPSEEK_API_KEY' },
  antigravity: { name: 'Antigravity CLI', plan: 'Google Gemini', label: 'Google Cloud ADC 认证', loginCommand: 'gcloud auth application-default login', configHint: 'Google Application Default Credentials (ADC) 或 gcloud 认证' },
  pi: { name: 'Pi', plan: 'Pi Multi-Provider', label: 'Pi 模型凭据配置', loginCommand: null, configHint: '~/.pi/agent/settings.json 或各模型提供商 API Key' },
  omp: { name: 'Oh My Pi', plan: 'Oh My Pi', label: 'OMP 模型凭据配置', loginCommand: null, configHint: '~/.omp/ 配置文件或各 Provider API 密钥' },
  grok: { name: 'Grok', plan: 'xAI Grok', label: 'xAI API Key', loginCommand: null, configHint: '环境变量 XAI_API_KEY' },
  opencode: { name: 'OpenCode', plan: 'OpenCode Providers', label: 'OpenCode Provider 配置', loginCommand: null, configHint: '~/.opencode/ 配置文件' },
  openclaw: { name: 'OpenClaw', plan: 'OpenClaw Gateway', label: 'OpenClaw Token 认证', loginCommand: null, configHint: '环境变量 OPENCLAW_TOKEN 或 gateway.auth 配置' },
  'kiro-cli': { name: 'Kiro', plan: 'AWS / Kiro CLI', label: 'Kiro CLI 授权', loginCommand: 'kiro auth login', configHint: '命令行 kiro auth login 或 ~/.kiro/ 目录' },
  'cursor-cli': { name: 'Cursor', plan: 'Cursor Account', label: 'Cursor 账号认证', loginCommand: 'cursor-cli auth login', configHint: 'Cursor 客户端或 cursor-cli auth 登录' },
  qoder: { name: 'Qoder', plan: 'Qoder AI', label: 'Qoder CLI 认证', loginCommand: 'qoder auth login', configHint: '命令行 qoder auth login 或 ~/.qoder/ 配置' },
  codebuddy: { name: 'CodeBuddy', plan: 'CodeBuddy AI', label: 'CodeBuddy 凭据', loginCommand: null, configHint: 'CodeBuddy 客户端或环境变量配置' },
  hermes: { name: 'Hermes', plan: 'Nous Hermes', label: 'Hermes Agent 配置', loginCommand: null, configHint: '~/.hermes/ 配置文件或各模型 API Key' },
  zcode: { name: 'ZCode', plan: 'ZCode AI', label: 'ZCode 账号与配置', loginCommand: null, configHint: 'ZCode 客户端或配置文件' },
  trae: { name: 'Trae', plan: 'Trae AI', label: 'Trae 账号与配置', loginCommand: null, configHint: 'Trae 客户端登录状态' },
  cline: { name: 'Cline', plan: 'Cline Providers', label: 'Cline CLI 认证', loginCommand: 'cline auth', configHint: '命令行 cline auth 或 ~/.cline/data 配置' },
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
  if (model.startsWith('harnessmix/plugin-v1@')) {
    const hex = model.slice('harnessmix/plugin-v1@'.length);
    if (model.length > 4096 || !/^(?:[a-f0-9]{2})+$/.test(hex)) throw new Error('Invalid native Harness route');
    const route = JSON.parse(Buffer.from(hex, 'hex').toString());
    if (!route.harnessId || route.harnessId === 'codex') throw new Error('Invalid external Harness');
    return route;
  }
  const legacy = /^harnessmix\/(pi|claude-code|deepseek-harness|antigravity|omp|opencode|grok)-native(?:@(.+))?$/.exec(model);
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

// 各 harness 终端工具的命名集合；命中即把该工具调用投影为原生 commandExecution，
// 让 Desktop 显示「正在运行/运行了命令」而不是笼统的「已使用 Harness Mix 集成」。
const SHELL_TOOL_TITLE = /bash|shell|terminal|console|exec|powershell|pwsh|\bcmd\b|command|命令|终端/i;

function shellCommandText(item) {
  if (!SHELL_TOOL_TITLE.test(String(item.title || ''))) return null;
  const input = item.input;
  if (typeof input !== 'string' || !input.trim()) return String(item.title || 'command');
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      const cmd = parsed.command ?? parsed.cmd ?? parsed.script ?? parsed.input;
      if (typeof cmd === 'string' && cmd.trim()) return cmd;
    }
  } catch {}
  return input;
}

// 官方 app-server 由 Rust 把命令解析成 commandActions；这里只对无引号/管道/重定向的
// 简单单命令做保守分类（读取/搜索/列目录），其余一律 unknown，不臆造命令行为。
function classifyCommandAction(command) {
  if (/["'`|;&<>()[\]{}$]/.test(command)) return { type: 'unknown', command };
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const exe = (tokens[0] || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
  const args = tokens.slice(1).filter(t => !t.startsWith('-'));
  if (['cat', 'head', 'tail', 'type', 'get-content', 'more'].includes(exe) && args.length === 1)
    return { type: 'read', command, name: args[0].split(/[\\/]/).pop(), path: args[0] };
  if (['rg', 'grep', 'egrep', 'fgrep', 'findstr'].includes(exe) && args.length >= 1)
    return { type: 'search', command, query: args[0] };
  if (['ls', 'dir', 'tree'].includes(exe))
    return { type: 'listFiles', command, ...(args[0] ? { path: args[0] } : {}) };
  return { type: 'unknown', command };
}

// Desktop 权限菜单/回合参数中的权限字段（thread/settings/update 与 turn/start 用 sandboxPolicy，
// thread/start 用 sandbox），统一存为 turnPermissions { approvalPolicy, approvalsReviewer, sandboxPolicy, permissions }
function pickTurnPermissions(params = {}) {
  const picked = {};
  if (typeof params.approvalPolicy === 'string') picked.approvalPolicy = params.approvalPolicy;
  if (typeof params.approvalsReviewer === 'string') picked.approvalsReviewer = params.approvalsReviewer;
  const sandbox = params.sandboxPolicy ?? params.sandbox;
  if (sandbox && typeof sandbox === 'object') picked.sandboxPolicy = sandbox;
  if (typeof params.permissions === 'string') picked.permissions = params.permissions;
  return Object.keys(picked).length ? picked : null;
}

// Desktop 渲染层按字面量匹配 agentMessage 的 phase 词表（commentary / final_answer）：
// split-items-into-render-groups 只在 phase==='final_answer' 时把末段提取为回合结论，
// 其余 assistant-message 随执行区折叠进「用时」栏。内部 CoreEvent 词表是 progress / final，
// 在此 Codex 投影边界翻译；历史持久化数据（progress/final）也经此映射，无需迁移。
function agentMessagePhase(phase) {
  if (phase === 'progress' || phase === 'commentary') return 'commentary';
  if (phase === 'final' || phase === 'final_answer' || phase == null) return 'final_answer';
  return phase;
}

function projectItem(item) {
  const base = { id: item.id };
  if (item.type === 'user_message') return { ...base, type: 'userMessage', content: [
    { type: 'text', text: item.content || '', text_elements: [] },
    ...(item.attachments || []).filter(a => a.kind === 'image').map(a => a.data
      ? { type: 'image', url: `data:${a.mime || 'image/png'};base64,${a.data}` }
      : a.path ? { type: 'localImage', path: a.path } : { type: 'text', text: `[图片：${a.name}]`, text_elements: [] }),
  ] };
  if (item.type === 'agent_message' || item.type === 'notice') return { ...base, type: 'agentMessage', text: item.content || '', phase: agentMessagePhase(item.phase) };
  if (item.type === 'reasoning') return { ...base, type: 'reasoning', summary: [item.content || ''], content: [] };
  if (item.type === 'tool_call' && item.collaboration) {
    const job = item.collaboration;
    const status = ({ completed: 'completed', failed: 'errored', cancelled: 'interrupted', interrupted: 'interrupted' })[job.status] || 'running';
    return { ...base, type: 'collabAgentToolCall', tool: job.operation || 'spawnAgent',
      status: terminal(item.status) ? (item.state === 'error' ? 'failed' : 'completed') : 'inProgress',
      senderThreadId: job.parent_thread_id, receiverThreadIds: job.child_thread_id ? [job.child_thread_id] : [],
      prompt: job.task || null, model: null, reasoningEffort: null,
      childThreadId: job.child_thread_id || null, agentType: job.agent_type || null,
      diff: job.diff || null, digest: job.digest || null,
      branch: job.branch || job.workspace?.branch || null,
      workspaceMode: job.workspace?.mode || 'shared',
      applied: !!job.appliedDigest || !!job.applied,
      agentsStates: job.child_thread_id ? { [job.child_thread_id]: { status,
        message: job.attention?.message || job.attention?.title || job.result || job.error || null } } : {} };
  }
  if (item.type === 'tool_call') {
    const status = terminal(item.status) ? (item.state === 'error' ? 'failed' : 'completed') : 'inProgress';
    const command = shellCommandText(item);
    if (command != null) {
      // 退出码未知不臆造（exitCode: null）；durationMs 来自 Core 真实时间戳
      return { ...base, type: 'commandExecution', command, cwd: null, status,
        commandActions: [classifyCommandAction(command)],
        aggregatedOutput: item.output ? String(item.output) : null,
        exitCode: null, durationMs: terminal(item.status) ? Math.max(0, (item.updatedAt ?? 0) - (item.createdAt ?? 0)) : null, processId: null };
    }
    return { ...base, type: 'dynamicToolCall', namespace: 'harness-mix', tool: item.title || 'tool',
      arguments: item.input || {}, contentItems: item.output ? [{ type: 'inputText', text: String(item.output) }] : null,
      status, success: terminal(item.status) ? item.state !== 'error' : null };
  }
  if (item.type === 'file_change') return { ...base, type: 'fileChange', status: terminal(item.status) ? 'completed' : 'inProgress',
    changes: (item.changes || [item]).map(change => {
      const kind = change.changeType === 'deleted' ? { type: 'delete' } : change.changeType === 'added' ? { type: 'add' } : { type: 'update', move_path: null };
      return { path: change.path || change.file || '', kind, diff: unifiedDiff(change, kind.type) };
    }) };
  if (item.type === 'context_compaction' || item.type === 'contextCompaction') return { ...base, type: 'contextCompaction' };
  if (item.type === 'verification_report') {
    const report = item.report ?? {};
    const failed = report.status === 'failed';
    return { ...base, type: 'mcpToolCall', server: 'harness-mix', tool: 'verification_gate',
      arguments: { mode: report.mode ?? 'off' }, result: { content: [{ type: 'text', text: JSON.stringify(report) }], structuredContent: report },
      status: failed ? 'failed' : 'completed', error: failed ? { message: 'Verification gate failed' } : null, durationMs: Math.max(0, (report.completedAt ?? 0) - (report.startedAt ?? 0)) };
  }
  return null;
}

class NativeProtocol {
  constructor(runtime, emit, requestOfficial = null) {
    this.runtime = runtime;
    this.emit = emit;
    this.requestOfficial = requestOfficial;
    this.codexAccounts = new CodexAccountManager({
      dataDirectory: nativeEnvironment().HARNESSMIX_DATA_DIR,
      requestOfficial,
      emit,
    });
    this.approvals = new Map();
    this.pets = require('./pets').createPetMarket();
    this.published = new Map();
    this.steering = new Map();      // threadId -> in-flight steer promise
    this.steerReceipts = new Map(); // `${threadId}\0${clientUserMessageId}` -> bounded delivery receipt
    this.queues = new Map();        // threadId -> Array<{ id, input, clientUserMessageId, createdAt }>
    this.queueNotifications = new Map(); // response-first queue notifications, coalesced per thread
    this.queueStarts = new Set();   // queued submission ids currently being accepted by a native harness
    this.closed = false;
    this.turnDiffs = new Map(); // `${threadId}\0${turnId}` -> last pushed diff text (dedupe)
    this.unsubscribe = runtime.core.subscribe(({ event, projected }) => this.onCore(event, projected));
    // Host 侧新建的线程（协作子任务等）也要通知 Desktop 侧栏，与 thread/start 同一契约
    this.unsubscribeRuntime = runtime.subscribe(event => {
      if (event?.type === 'thread-created' && event.thread) this.emit({ method: 'thread/started', params: { thread: this.projectThread(event.thread) } });
      if (event?.type === 'thread-updated' && event.thread) {
        this.emit({ method: 'thread/name/updated', params: { threadId: event.thread.id, threadName: event.thread.title } });
      }
    });
  }
  getQueue(threadId) {
    if (!this.queues.has(threadId)) this.queues.set(threadId, []);
    return this.queues.get(threadId);
  }
  emitQueueChanged(threadId) {
    // Desktop mutates its local queue cache after the request promise resolves. Emitting
    // synchronously lets its refresh replace that cache first; an edit then holds the old
    // message id and fails with "queued follow-up no longer exists". Match app-server
    // ordering: return the mutation response first, then notify this and other windows.
    if (this.closed || this.queueNotifications.has(threadId)) return;
    const timer = setTimeout(() => {
      this.queueNotifications.delete(threadId);
      this.emit({ method: 'thread/queue/changed', params: { threadId } });
    }, 0);
    timer.unref?.();
    this.queueNotifications.set(threadId, timer);
  }
  thread(id) {
    if (!id) return undefined;
    return this.runtime.threads.some(t => t.id === id) ? this.runtime.getThread(id) : undefined;
  }
  owns(id) { return Boolean(this.thread(id)); }
  turn(turn) {
    // 官方 Turn 合约的时间字段：startedAt/completedAt（epoch 秒，Desktop 恢复线程时经
    // kBt(x*1e3) 还原）与 durationMs（turn/completed 处理器直接采用）。缺失时 Desktop
    // 无法合成 worked-for 计时项，完成回合只回退显示“已使用 Harness Mix 集成”。
    const startedAt = turn.startedAt ?? turn.createdAt ?? null;
    const completedAt = turn.completedAt ?? null;
    return { id: turn.id, status: turnStatus(turn.status), error: turn.error ? { message: String(turn.error), codexErrorInfo: turn.codexErrorInfo ?? null, additionalDetails: null } : null,
      startedAt: startedAt != null ? Math.floor(startedAt / 1000) : null,
      completedAt: completedAt != null ? Math.floor(completedAt / 1000) : null,
      durationMs: startedAt != null && completedAt != null ? Math.max(0, completedAt - startedAt) : null,
      items: this.runtime.core.getItemsForTurn(turn.id).map(projectItem).filter(Boolean) };
  }
  projectThread(thread, includeTurns = true) {
    // Projection shape mirrors the upstream harnessmix external-thread contract: every
    // field the Desktop sidebar/composer reads must be present with the same defaults.
    const updatedAt = Math.floor((thread.updatedAt || thread.createdAt) / 1000);
    return { id: thread.id, preview: thread.messages?.find(m => m.role === 'user')?.text || thread.preview || thread.title,
      ephemeral: thread.ephemeral === true, modelProvider: 'harnessmix', model: routeModel(externalId(thread.harnessId)), reasoningEffort: null,
      section: thread.section ?? null, sectionEnteredAt: thread.sectionEnteredAt ?? null, projectId: thread.projectId ?? null,
      createdAt: Math.floor(thread.createdAt / 1000),
      updatedAt, recencyAt: updatedAt,
      status: { type: thread.status === 'working' ? 'active' : 'idle', ...(thread.status === 'working' ? { activeFlags: [] } : {}) },
      path: null, cwd: thread.cwd, cliVersion: 'harnessmix', source: thread.parentThreadId ? 'subAgentThreadSpawn' : 'vscode', threadSource: null,
      name: thread.title || null, agentNickname: thread.parentThreadId ? this.runtime.adapters.get(thread.harnessId)?.manifest.name || thread.harnessId : null,
      agentRole: thread.parentThreadId ? 'worker' : null, gitInfo: thread.gitInfo || null,
      sessionId: thread.id, forkedFromId: thread.forkedFrom ?? null, parentThreadId: thread.parentThreadId ?? null,
      // 跨 Harness 原地切换血缘：链上每条是某 Harness 曾用的原生会话引用（切回可 resume）
      harnessChain: (thread.harnessChain ?? []).map(e => ({ harnessId: externalId(e.harnessId), at: e.at })),
      pendingHarnessSwitch: thread.pendingHandoff ? {
        checkpointId: thread.pendingHandoff.checkpointId,
        fromHarnessId: externalId(thread.pendingHandoff.fromHarnessId),
        toHarnessId: externalId(thread.pendingHandoff.toHarnessId || thread.harnessId),
        phase: thread.pendingHandoff.phase || 'ready',
        intent: thread.pendingHandoff.intent || 'continue',
        note: thread.pendingHandoff.note ?? null,
      } : null,
      canAcceptDirectInput: true, historyMode: 'legacy', isPinned: false, extra: null,
      isolation: thread.isolation ?? 'shared',
      workspace: thread.workspace ? { mode: thread.workspace.mode, branch: thread.workspace.branch, root: thread.workspace.root } : null,
      turns: includeTurns ? this.runtime.core.turns.turnsForThread(thread.id).map(t => this.turn(t)) : [] };
  }
  capabilities(id, catalog) {
    const cap = this.runtime.getCapabilities(id);
    return { configuration: { selectModel: Boolean(cap.model?.selection), selectThinkingOption: Boolean(cap.model?.thinkingLevel),
      selectPermissionMode: Boolean(catalog.permissionModes?.length), permissionModeScope: 'live' },
    history: { fork: Boolean(cap.session?.fork), forkAcrossCwd: false, rollbackLastTurn: Boolean(cap.session?.forkFromMessage) },
    workspace: { git: true, worktree: true, finalDiff: true, nativeDiff: Boolean(cap.workspace?.nativeDiff), nativePatch: Boolean(cap.workspace?.nativePatch) } };
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
      if (catalog.permissionModes?.length) result.permissionModes = { modes: catalog.permissionModes.map(m => ({ id: m.id, label: m.label || m.name || m.id, ...((m.description || m.hint) ? { description: m.description || m.hint } : {}), ...(m.dangerous ? { dangerous: true } : {}) })), defaultModeId: catalog.permissionModes.find(m => m.default)?.id || catalog.permissionModes[0].id };
      return result;
    } catch (error) {
      // A harness binary that exited mid-probe is deterministic misconfiguration:
      // retrying immediately would re-spawn it (possibly a full GUI) in a loop.
      // The renderer only keeps polling agents whose error is retryable.
      return { status: 'error', error: { code: 'INSPECTION_FAILED', message: error.message, retryable: !error.harnessExited } };
    }
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
    const selectedLabel = selectedEntry ? (selectedEntry.name || selectedEntry.id) : (typeof selected === 'object' && selected ? (selected.name || selected.id) : selected);
    return { ...(selected ? { effectiveModel: modelRef(selected) } : {}),
      // 渲染端目录未命中时兜底显示模型名（composer 优先用 resolvedModelLabel）
      ...(selectedLabel ? { resolvedModelLabel: String(selectedLabel) } : {}),
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
    if (method === 'harnessmix/integrations/catalog') return this.runtime.integrations.catalog();
    if (method === 'harnessmix/integrations/list') return this.runtime.integrations.list(params);
    if (method === 'harnessmix/integrations/mcp/save') return this.runtime.integrations.save(params);
    if (method === 'harnessmix/integrations/mcp/remove') return this.runtime.integrations.remove(params);
    if (method === 'harnessmix/integrations/skill/change') return this.runtime.integrations.skillChange(params);
    if (method === 'harnessmix/harness/session-import/sources') return this.runtime.history.sources();
    if (method === 'harnessmix/harness/session-import/list') return this.runtime.history.list(params);
    if (method === 'harnessmix/harness/session-import/import') return this.runtime.history.import(params);
    if (method === 'harnessmix/collaboration/agents') return [...this.runtime.adapters.values()].map(a => ({ id: externalId(a.manifest.id), name: a.manifest.name, available: !!this.runtime.status[a.manifest.id]?.available, lead: a.manifest.capabilities?.collaborationTools === true }));
    if (method === 'harnessmix/collaboration/preferences') return this.runtime.collaboration.getPreferences();
    if (method === 'harnessmix/collaboration/preferences/save') return this.runtime.collaboration.setPreferences(params);
    // 桌宠市场：官方预载（Codex 安装包 asar 提取）与 ~/.codex/pets 安装管理
    if (method === 'harnessmix/pets/catalog') return this.pets.catalog();
    if (method === 'harnessmix/pets/community') return this.pets.community(params);
    if (method === 'harnessmix/pets/preview') return this.pets.preview(params);
    if (method === 'harnessmix/pets/install') return this.pets.install(params);
    if (method === 'harnessmix/pets/uninstall') return this.pets.uninstall(params);
    // Harness Mix 本地桌宠选择（仅驱动 Harness Mix 自有展示面，不触碰账号级 accessory_id）
    if (method === 'harnessmix/pets/selection') return this.pets.selection();
    if (method === 'harnessmix/pets/select') return this.pets.select(params);
    const thread = this.thread(params.threadId);
    // 失败回合分类查询：Renderer 据此在输入框下方渲染只真正帮得上忙的动作按钮
    if (method === 'harnessmix/harness/turn-error') {
      if (!thread) throw new Error('Unknown thread');
      const kind = thread.errorKind ?? null;
      const meta = HARNESS_AUTH_INFO[externalId(thread.harnessId)] || HARNESS_AUTH_INFO[thread.harnessId];
      return {
        threadId: thread.id,
        error: thread.error ?? null,
        errorKind: kind,
        actions: kind ? errorActions(kind, { canLogin: Boolean(meta?.loginCommand) }) : [],
      };
    }
    if (method === 'harness-mix/runtime/inspect') return {
      owner: 'harness-mix',
      runtime: 'src/main/host/runtime.js',
      core: 'src/main/protocol-core/protocol-core.js',
      threads: this.runtime.threads.length,
      codex: {
        mode: 'official-passthrough',
        // `codex` remains owned by the stock app-server. Only the explicit
        // `codex-harness` route creates a HostRuntime-managed Codex worker.
        managedRoute: 'codex-harness',
      },
    };
    if (method === 'harness-mix/runtime/version') {
      let version = '0.0.0';
      try { version = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version || version; } catch {}
      return { version };
    }
    // Updates
    if (method === 'harnessmix/update/check') {
      const dataDir = nativeEnvironment().HARNESSMIX_DATA_DIR;
      let currentVersion = '0.1.2';
      try {
        currentVersion = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version || '0.1.2';
      } catch { /* fallback */ }
      const channel = detectChannel(REPO_ROOT);
      let latestVersion = currentVersion;
      let updateAvailable = false;
      let checkError = null;

      if (channel === 'git') {
        try {
          // Async runner: a sync git fetch here would freeze the whole host
          // (heartbeats, approvals, every thread) for the fetch timeout.
          const remote = await remoteState(REPO_ROOT, makeGit(REPO_ROOT, asyncRun()));
          if (remote.state === 'available') {
            updateAvailable = true;
            latestVersion = `${currentVersion}+git.${remote.remote.slice(0, 7)}`;
          } else {
            latestVersion = currentVersion;
          }
        } catch (err) {
          checkError = err.message;
        }
      } else {
        try {
          const fetched = await fetchLatestVersion({
            registry: await resolveRegistry({ run: asyncRun() }),
            dataDir,
            timeoutMs: 6000,
          });
          if (fetched) {
            latestVersion = fetched;
            updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
          }
        } catch (err) {
          checkError = err.message;
        }
      }

      return {
        currentVersion,
        installation: channel === 'npm' ? 'npm' : 'windows-installer',
        latestVersion,
        updateAvailable,
        installationAvailable: true,
        releaseNotes: updateAvailable ? `发现新版本 ${latestVersion}，支持自动快进更新与安全回滚。` : null,
        releaseNotesUrl: `https://github.com/emo-xiaoyu/harness-mix/releases/tag/v${currentVersion}`,
        status: null,
        error: checkError ? `更新检查失败: ${checkError.slice(0, 450)}` : null,
      };
    }
    if (method === 'harnessmix/update/start') {
      const dataDir = nativeEnvironment().HARNESSMIX_DATA_DIR;
      const channel = detectChannel(REPO_ROOT);
      let currentVersion = '0.1.2';
      try { currentVersion = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version || '0.1.2'; } catch {}
      const installation = channel === 'npm' ? 'npm' : 'windows-installer';
      // The heavy flow must run in a detached helper, never in this host:
      // 1) process.stdout here is the JSONL protocol channel to the Desktop —
      //    updater/npm/cargo output would corrupt it;
      // 2) minutes of synchronous git/npm/cargo work would freeze the event
      //    loop (heartbeats, approvals, every thread);
      // 3) the host lives inside the shim's kill-on-close job — it cannot
      //    stop the Desktop without killing itself mid-update.
      // The helper defers what the running Desktop locks and stops it last;
      // the Desktop keeps polling harnessmix/update/status from the state file.
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const logFile = path.join(dataDir, 'update.log');
        const fd = fs.openSync(logFile, 'a');
        try {
          const helper = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'native-update.cjs')], {
            stdio: ['ignore', fd, fd],
            detached: true,
            windowsHide: true,
            env: process.env,
          });
          helper.unref();
        } finally {
          fs.closeSync(fd);
        }
        return {
          status: {
            version: currentVersion,
            installation,
            phase: 'installing',
            updatedAt: Date.now(),
            error: null,
          },
        };
      } catch (err) {
        return {
          status: {
            version: currentVersion,
            installation,
            phase: 'failed',
            updatedAt: Date.now(),
            error: `无法启动更新助手：${err.message}`.slice(0, 450),
          },
        };
      }
    }
    if (method === 'harnessmix/update/status') {
      const dataDir = nativeEnvironment().HARNESSMIX_DATA_DIR;
      const state = readState(dataDir);
      const channel = detectChannel(REPO_ROOT);
      let currentVersion = '0.1.2';
      try { currentVersion = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version || '0.1.2'; } catch {}
      if (state.phase && state.phase !== 'idle') {
        return {
          status: {
            version: state.pendingVersion || state.appliedVersion || currentVersion,
            installation: channel === 'npm' ? 'npm' : 'windows-installer',
            phase: state.phase === 'applying' ? 'installing' : 'succeeded',
            updatedAt: state.appliedAt || Date.now(),
            error: null,
          },
        };
      }
      return { status: null };
    }

    // Each extra Account is an isolated native CODEX_HOME. Harness Mix stores
    // only the profile label/path; auth.json and token refresh remain owned by Codex.
    if (method === 'harnessmix/account/list') return this.codexAccounts.list(false);
    if (method === 'harnessmix/account/refresh') return this.codexAccounts.list(true);
    if (method === 'harnessmix/account/create') return this.codexAccounts.create(params.label);
    if (method === 'harnessmix/account/delete') return this.codexAccounts.delete(params.accountId);
    if (method === 'harnessmix/account/activate') return this.codexAccounts.activate(params.accountId);
    if (method === 'harnessmix/account/usage/inspect') return this.codexAccounts.usage(params.accountId);
    if (method === 'harnessmix/account/login/start') return this.codexAccounts.startLogin(params.accountId);
    if (method === 'harnessmix/account/login/cancel') return this.codexAccounts.cancelLogin(params.loginId);
    if (method === 'harnessmix/account/logout') {
      if (!this.requestOfficial) throw new Error('Official Codex logout is unavailable');
      await this.requestOfficial('account/logout', undefined);
      return this.codexAccounts.signedOutOfficial();
    }
    if (method === 'harnessmix/account/rate-limit-reset/consume') return this.codexAccounts.consumeReset(params.accountId, params.idempotencyKey);
    if (method === 'harnessmix/harness/account/login') {
      const extId = params.harnessId;
      const meta = HARNESS_AUTH_INFO[extId] || HARNESS_AUTH_INFO[ALIASES[extId]];
      const cmd = meta?.loginCommand;
      if (!cmd) throw new Error(`Harness ${extId} 暂不支持命令行直接登录，请参考凭据配置指引进行配置`);
      const title = `登录 ${meta.name || extId}`;
      const execCmd = `cmd.exe /c start "${title}" cmd.exe /k "echo 正在为 ${meta.name} 启动登录认证... && echo 执行命令: ${cmd} && echo. && ${cmd} && echo. && echo [Harness Mix] 登录操作已完成，请关闭此窗口并返回 Harness Mix 刷新状态"`;
      exec(execCmd, { windowsHide: false });
      return { success: true, command: cmd };
    }
    if (method === 'harnessmix/harness/accounts/list') {
      const accounts = [];
      for (const adapter of this.runtime.adapters.values()) {
        const id = adapter.manifest.id;
        const extId = externalId(id);
        const meta = HARNESS_AUTH_INFO[extId] || HARNESS_AUTH_INFO[id] || { name: adapter.manifest.name };
        const isAvailable = !!this.runtime.status[id]?.available;

        let email = undefined;
        let label = meta.label;
        let plan = meta.plan;
        let credits = undefined;
        let status = isAvailable ? 'ready' : 'not_installed';

        if (typeof adapter.inspectAccount === 'function') {
          try {
            const raw = await Promise.race([
              Promise.resolve().then(() => adapter.inspectAccount()),
              new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
            ]);
            if (raw && typeof raw === 'object') {
              if (raw.email && typeof raw.email === 'string') email = raw.email.trim();
              if (raw.label && typeof raw.label === 'string') label = raw.label.trim();
              if (raw.plan && typeof raw.plan === 'string') plan = raw.plan.trim();
              if (raw.credits) credits = projectAccountCredits(raw.credits) || undefined;
              status = 'ready';
            }
          } catch {
            // keep default
          }
        }

        if (!email) {
          if (id === 'codex') {
            status = 'ready';
            email = 'Codex Desktop 会话已就绪';
          } else if (id === 'dsh') {
            if (process.env.DEEPSEEK_API_KEY) {
              status = 'ready';
              email = 'API Key (已设置)';
            } else {
              status = isAvailable ? 'unconfigured' : 'not_installed';
            }
          } else if (id === 'grok') {
            if (process.env.XAI_API_KEY) {
              status = 'ready';
              email = 'xAI API Key (已设置)';
            } else {
              status = isAvailable ? 'unconfigured' : 'not_installed';
            }
          } else if (id === 'openclaw') {
            if (process.env.OPENCLAW_TOKEN) {
              status = 'ready';
              email = 'Gateway Token (已配置)';
            } else {
              status = isAvailable ? 'unconfigured' : 'not_installed';
            }
          } else if (!isAvailable) {
            status = 'not_installed';
          }
        }

        accounts.push({
          harnessId: extId,
          harnessName: meta.name || adapter.manifest.name,
          status,
          ...(email ? { email } : {}),
          ...(label ? { label } : {}),
          ...(plan ? { plan } : {}),
          ...(meta.configHint ? { configHint: meta.configHint } : {}),
          ...(meta.loginCommand ? { loginCommand: meta.loginCommand } : {}),
          ...(credits ? { credits } : {}),
        });
      }
      return { accounts };
    }
    if (method === 'harnessmix/harness/plugins/list') return { plugins: this.runtime.snapshot().adapters.map(a => ({ id: externalId(a.id), name: a.id === 'codex' ? 'Codex（协作）' : a.name, version: '0.1.0', icon: `data:image/svg+xml;base64,${Buffer.from(getHarnessSvg(a.id)).toString('base64')}` })) };
    if (method === 'harnessmix/storage/inspect') return this.runtime.inspectStorage();
    if (method === 'harnessmix/storage/optimize') return this.runtime.optimizeStorage();
    if (method === 'harnessmix/harness/inspect') return this.inspect(params.harnessId);
    if (method === 'harnessmix/harness/install') {
      const local = ALIASES[params.harnessId] || params.harnessId;
      const entry = HARNESS_INSTALL_COMMANDS[params.harnessId] || HARNESS_INSTALL_COMMANDS[local];
      if (!entry) throw new Error(`No installation command available for harness: ${params.harnessId}`);
      const command = (process.platform === 'win32' ? entry.win32 : entry.default) || entry.default;

      if (params.terminal) {
        const title = `安装 ${params.harnessId}`;
        const cmd = `cmd.exe /c start "${title}" cmd.exe /k "echo 正在安装 ${params.harnessId} (${command})... && ${command} && echo. && echo [Harness Mix] 安装执行完毕，请关闭此窗口并返回 Harness Mix 点击【刷新检测】"`;
        exec(cmd, { windowsHide: false });
        return { success: true, command, stdout: '已在独立终端窗口中启动安装' };
      }

      return new Promise((resolve) => {
        exec(command, { timeout: 600000, shell: true, maxBuffer: 10 * 1024 * 1024 }, async (err, stdout, stderr) => {
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
    if (method === 'harnessmix/harness/commands/inspect' || method === 'harnessmix/thread/commands/inspect') {
      const commands = await this.runtime.listCommands({ threadId: params.threadId, harnessId: ALIASES[params.harnessId] || params.harnessId });
      return { commands: commands.map(c => ({ id: c.id, invocation: '/' + c.id, label: c.label || c.id, ...(c.description ? { description: c.description.slice(0, 512) } : {}), argumentMode: c.action === 'insert' ? 'text' : 'none' })) };
    }
    if (method === 'harnessmix/thread/ownership/list') return { threads: params.threadIds.map(id => ({ threadId: id, owner: this.owns(id) ? 'external' : 'codex', ...(this.owns(id) ? { harnessId: externalId(this.thread(id).harnessId) } : {}) })) };
    if (method === 'harnessmix/thread/team/inspect') return this.runtime.collaboration.inspectTeam(params.threadId, params.teamId);
    // 看板操作面：principal 是用户（授权在 collaboration.userAction 内统一裁决）。
    // cancel/message 任意时刻可执行；reassign/continue 由 Host 向 lead 线程注入指令回合。
    if (method === 'harnessmix/thread/team/task/cancel') return this.runtime.collaboration.userAction(params.threadId, 'task/cancel', { teamId: params.teamId, taskId: params.taskId });
    if (method === 'harnessmix/thread/team/task/reassign') return this.runtime.collaboration.userAction(params.threadId, 'task/reassign', { teamId: params.teamId, taskId: params.taskId, memberId: params.memberId, ...(params.note ? { note: params.note } : {}) });
    if (method === 'harnessmix/thread/team/message/send') return this.runtime.collaboration.userAction(params.threadId, 'message/send', { teamId: params.teamId, to: params.to ?? '*', message: params.message, ...(params.kind ? { kind: params.kind } : {}) });
    if (method === 'harnessmix/thread/collaboration/continue') return this.runtime.collaboration.userAction(params.threadId, 'continue', params.taskId ? { taskId: params.taskId } : {});
    if (method === 'harnessmix/thread/inspect') {
      if (!thread) return { owner: 'codex', locked: true };
      const catalog = await this.runtime.describe(thread.harnessId);
      const usage = typeof this.runtime.core?.getThread === 'function' ? this.runtime.core.getThread(thread.id)?.usage : undefined;
      const adapter = this.runtime.adapters && typeof this.runtime.adapters.get === 'function' ? this.runtime.adapters.get(thread.harnessId) : null;
      const rawCredits = adapter && typeof adapter.credits === 'function' ? adapter.credits() : null;
      const credits = projectAccountCredits(rawCredits);
      // projectUsage() returns null for an empty source (harnesses that never
      // report usage, e.g. qodercli). The external inspection schema accepts an
      // absent usage but not an explicit null: emitting "usage": null made the
      // renderer's strict parse fail and wedge the whole ownership restore.
      const projectedUsage = usage ? projectUsage(usage) : null;
      return { owner: 'external', harnessId: externalId(thread.harnessId), transportModelId: routeModel(externalId(thread.harnessId)), locked: true,
        ...this.configuration(thread), history: this.capabilities(thread.harnessId, catalog).history,
        workspace: await this.runtime.inspectThreadWorkspace(thread.id),
        ...(projectedUsage ? { usage: projectedUsage } : {}),
        ...(credits ? { accountCredits: credits } : {}) };
    }
    if (method === 'thread/start') {
      const route = decodeRoute(params.model);
      const accountContext = typeof params.__harnessmixAccountId === 'string'
        ? this.codexAccounts.executionContext(params.__harnessmixAccountId) : null;
      if (!route && !accountContext) return undefined;
      const effectiveRoute = route || { harnessId: 'codex-harness', ...(typeof params.model === 'string' ? { model: { id: params.model } } : {}) };
      const id = ALIASES[effectiveRoute.harnessId] || effectiveRoute.harnessId;
      if (!this.runtime.adapters.has(id)) throw new Error(`Unsupported Harness: ${id}`);
      // Desktop 26.917 的草稿预热带 threadSource:"user" + ephemeral；runtime 本就支持
      // ephemeral 外部线程（首个真实输入转正）。仍然拒绝真正的后台来源（标题生成、
      // 插件宿主等）——它们不属于 Harness Mix 的托管范围。拒绝用户预热会迫使
      // Desktop 回退到自己的原生执行路径，同一条消息双执行、侧边栏出现重复会话。
      if (params.ephemeral && params.threadSource && params.threadSource !== 'user') throw new Error('Ephemeral background thread is not supported');
      const isWorktree = params.worktree === true || params.options?.worktree === true;
      const selectedModel = accountContext && typeof params.model === 'string'
        ? (await this.runtime.describe(id)).models.find(model => model.id === params.model)
        : await this.resolveModel(id, effectiveRoute.model);
      const created = await this.runtime.createThread({ harnessId: id, cwd: params.cwd, ephemeral: params.ephemeral === true,
        worktree: isWorktree,
        options: {
          model: selectedModel, thinking: effectiveRoute.thinkingOptionId, permissionMode: effectiveRoute.permissionModeId,
          ...(accountContext || {}),
          ...(isWorktree ? { worktree: true } : {}),
          ...(pickTurnPermissions(params) ? { turnPermissions: pickTurnPermissions(params) } : {}),
        } });
      if (created.error) throw new Error(created.error);
      const result = { thread: this.projectThread(created), model: params.model, modelProvider: 'harness-mix', cwd: created.cwd,
        approvalPolicy: params.approvalPolicy || 'on-request', sandbox: params.sandbox || { type: 'workspaceWrite', writableRoots: [created.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null };
      // thread/started 已由 runtime 的 thread-created 监听统一发出（含协作子任务路径）
      return result;
    }
    if (method === 'harnessmix/thread/workspace/review') return this.runtime.reviewThreadWorkspace(params.threadId);
    if (method === 'harnessmix/thread/workspace/apply') return this.runtime.applyThreadWorkspace(params.threadId, params.digest);
    if (method === 'harnessmix/thread/workspace/discard') return this.runtime.discardThreadWorkspace(params.threadId);
    if (method === 'harnessmix/thread/workspace/push') return this.runtime.pushThreadWorkspace(params.threadId, params);
    if (method === 'harnessmix/thread/verification/get') return this.runtime.verificationState(params.threadId);
    if (method === 'harnessmix/thread/verification/configure') return this.runtime.configureVerification(params.threadId, params.policy);
    if (method === 'harnessmix/thread/verification/run') return this.runtime.runVerification(params.threadId);
    if (!thread) {
      if (method.startsWith('harnessmix/')) throw new Error(`Harness Mix does not implement ${method}`);
      return undefined;
    }
    if (method === 'thread/read') return { thread: this.projectThread(thread, params.includeTurns !== false) };
    if (method === 'thread/queue/list') {
      const queue = this.getQueue(thread.id);
      return {
        data: queue.map(item => ({
          id: item.id,
          input: item.input,
          clientUserMessageId: item.clientUserMessageId,
          createdAt: item.createdAt,
        })),
        nextCursor: null,
      };
    }
    if (method === 'thread/queue/add') {
      const input = Array.isArray(params.input) ? params.input : [];
      if (!input.length) throw new Error('Queue submission requires non-empty input');
      const queue = this.getQueue(thread.id);
      const submission = {
        id: randomUUID(),
        input,
        clientUserMessageId: typeof params.clientUserMessageId === 'string' && params.clientUserMessageId ? params.clientUserMessageId : null,
        createdAt: Date.now(),
      };
      queue.push(submission);
      this.emitQueueChanged(thread.id);
      return { queuedSubmission: submission };
    }
    if (method === 'thread/queue/delete') {
      const queue = this.getQueue(thread.id);
      const idx = queue.findIndex(item => item.id === params.queuedSubmissionId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        this.emitQueueChanged(thread.id);
        return { deleted: true };
      }
      return { deleted: false };
    }
    if (method === 'thread/queue/update') {
      const queue = this.getQueue(thread.id);
      const item = queue.find(it => it.id === params.queuedSubmissionId);
      if (!item) throw new Error('Queued submission not found');
      if (Array.isArray(params.input)) item.input = params.input;
      this.emitQueueChanged(thread.id);
      return { queuedSubmission: item };
    }
    if (method === 'thread/queue/reorder') {
      const queue = this.getQueue(thread.id);
      const ids = Array.isArray(params.queuedSubmissionIds) ? params.queuedSubmissionIds : [];
      const map = new Map(queue.map(item => [item.id, item]));
      const reordered = ids.map(id => map.get(id)).filter(Boolean);
      for (const item of queue) {
        if (!ids.includes(item.id)) reordered.push(item);
      }
      this.queues.set(thread.id, reordered);
      this.emitQueueChanged(thread.id);
      return {};
    }
    if (method === 'thread/queue/start') {
      const queue = this.getQueue(thread.id);
      const idx = params.queuedSubmissionId
        ? queue.findIndex(item => item.id === params.queuedSubmissionId)
        : 0;
      if (idx === -1 || !queue[idx]) throw new Error('Queued submission not found');
      return { turn: this.turn(await this.startQueuedSubmission(thread, queue[idx])) };
    }
    if (method === 'thread/metadata/update') return { thread: this.projectThread(await this.runtime.updateThreadMetadata(thread.id, params.gitInfo)) };
    // Desktop 权限菜单（请求批准/帮我批准/完全访问）推送的线程级设置：原样存储并持久化，
    // 后续回合经 codex 适配器转发到原生 app-server，让显示选择与实际生效一致
    if (method === 'thread/settings/update') {
      const picked = pickTurnPermissions(params);
      if (picked) await this.runtime.setOptions(thread.id, { turnPermissions: { ...(thread.options?.turnPermissions ?? {}), ...picked } });
      return {};
    }
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
    if (method === 'thread/resume') {
      // 回显线程实际生效的权限（Desktop 据此渲染 composer 权限指示），而不是硬编码默认值
      const perms = thread.options?.turnPermissions ?? null;
      return { thread: this.projectThread(thread), model: routeModel(externalId(thread.harnessId)), modelProvider: 'harness-mix', cwd: thread.cwd,
        approvalPolicy: perms?.approvalPolicy ?? 'on-request', approvalsReviewer: perms?.approvalsReviewer ?? null,
        sandbox: perms?.sandboxPolicy ?? { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null };
    }
    if (method === 'turn/start') {
      const { text, attachments } = await prepareInput(params.input, thread.cwd);
      // Desktop fallback 路径在每个回合都携带完整权限参数；缺失时由适配器回退到线程级设置
      return { turn: this.turn(await this.startNativeTurn(thread, text, attachments, undefined, pickTurnPermissions(params))) };
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
    if (method === 'harnessmix/thread/delegate' || method === 'harnessmix/thread/message') {
      const task = params.task ?? params.text;
      if (typeof task !== 'string' || !task.trim()) throw new Error('Delegation requires a non-empty task');
      const { child, turn } = await this.runtime.delegateTask({
        fromThreadId: thread.id,
        harnessId: method === 'harnessmix/thread/delegate' ? (ALIASES[params.harnessId] || params.harnessId) : undefined,
        childThreadId: method === 'harnessmix/thread/message' ? params.childThreadId : undefined,
        task,
      });
      return { turn: this.turn(turn), childThreadId: child.id };
    }
    if (method === 'thread/rollback') return { thread: this.projectThread(await this.runtime.rollbackThread(thread.id, params.numTurns)) };
    if (method === 'thread/name/set') { await this.runtime.renameThread(thread.id, params.name); return {}; }
    if (method === 'thread/archive' || method === 'thread/unarchive') {
      const isArchive = method === 'thread/archive';
      await this.runtime.setThreadArchived(thread.id, isArchive);
      if (isArchive) {
        this.emit({ method: 'thread/archived', params: { threadId: thread.id } });
        return {};
      }
      const projected = this.projectThread(thread);
      this.emit({ method: 'thread/unarchived', params: { thread: projected } });
      return { thread: projected };
    }
    if (method === 'thread/loaded/list') return { data: [...this.runtime.sessions.keys()] };
    if (method === 'harnessmix/thread/usage/inspect') {
      const usage = params.refresh === 'exact' ? await this.runtime.refreshUsage(thread.id) : this.runtime.core.getThread(thread.id)?.usage;
      const adapter = this.runtime.adapters.get(thread.harnessId);
      let rawCredits = adapter && typeof adapter.credits === 'function' ? adapter.credits() : null;
      if (!rawCredits && adapter && typeof adapter.refreshCredits === 'function') {
        try { rawCredits = await adapter.refreshCredits(); } catch {}
      } else if (adapter && params.refresh === 'exact' && typeof adapter.refreshCredits === 'function') {
        try { await adapter.refreshCredits(); } catch {}
        rawCredits = adapter && typeof adapter.credits === 'function' ? adapter.credits() : null;
      }
      const credits = projectAccountCredits(rawCredits);
      return {
        threadId: thread.id,
        usage: projectUsage(usage),
        ...(credits ? { accountCredits: credits } : {}),
      };
    }
    if (method === 'harnessmix/thread/command/execute') {
      if (params.arguments && Object.keys(params.arguments).length) throw new Error('This command does not accept arguments');
      const turn = await this.startNativeTurn(thread, '', undefined, params.commandId);
      return { accepted: true, turnId: turn.id };
    }
    if (method === 'harnessmix/thread/model/select') { await this.runtime.setModel(thread.id, await this.resolveModel(thread.harnessId, params.model)); return this.configuration(thread); }
    if (method === 'harnessmix/thread/thinking/select') { await this.runtime.setThinking(thread.id, params.thinkingOptionId); return this.configuration(thread); }
    if (method === 'harnessmix/thread/permission-mode/select') {
      await this.runtime.setOptions(thread.id, { permissionMode: params.permissionModeId });
      const session = this.runtime.sessions.get(thread.id);
      const adapter = this.runtime.adapters.get(thread.harnessId);
      if (session && adapter && typeof adapter.setPermissionMode === 'function') {
        try { await adapter.setPermissionMode(session, params.permissionModeId); } catch {}
      }
      return this.configuration(thread);
    }
    // 原地切换 Harness：会话历史保留，下条消息携带一次性上下文信封（/switch 指令的 RPC 等价物）
    if (method === 'harnessmix/thread/harness/switch') {
      const result = await this.runtime.switchHarness(thread.id, ALIASES[params.harnessId] || params.harnessId, {
        note: typeof params.note === 'string' ? params.note : undefined,
        intent: params.intent,
        includes: params.includes,
      });
      return { ...result, fromHarnessId: externalId(result.fromHarnessId), toHarnessId: externalId(result.toHarnessId) };
    }
    if (method === 'thread/fork' || method === 'harnessmix/thread/fork') {
      if (params.ephemeral || params.threadSource || params.excludeTurns) {
        throw new Error('Ephemeral fork is not supported');
      }
      const messageId = params.lastTurnId ? thread.messages.find(m => m.coreTurnId === params.lastTurnId)?.id : params.messageId;
      if (params.lastTurnId && !messageId) throw new Error('Unknown fork turn');
      const fork = await this.runtime.forkThread(thread.id, messageId);
      return method === 'harnessmix/thread/fork' ? { threadId: fork.id } : { thread: this.projectThread(fork) };
    }
    throw new Error(`Harness Mix native bridge does not support ${method} for this thread`);
  }
  onCore(event, projected) {
    const { threadId, turnId } = event;
    const item = projected.item;
    const notify = (method, extra) => this.emit({ method, params: { threadId, turnId, ...extra } });
    if (event.type === 'usage.updated') this.emit({ method: 'harnessmix/thread/usage/updated', params: { threadId, usage: projectUsage(projected.thread?.usage) } });
    if (projected.items) {
      for (const file of projected.items) this.onCore({ ...event, type: 'item.updated' }, { item: file });
      // 去重：内容未变（含初始空态的 3s 轮询）不重复推送，避免刷屏与页脚抖动；
      // 变化被完全还原时仍需推送一次空 diff 让 Desktop 清空页脚。
      const diffText = projected.items.map(i => projectItem(i)?.changes?.map(c => c.diff).filter(Boolean).join('\n')).filter(Boolean).join('\n');
      const diffKey = `${threadId}\0${turnId}`;
      const lastDiff = this.turnDiffs.get(diffKey);
      if (diffText !== lastDiff && (diffText || lastDiff !== undefined)) {
        if (this.turnDiffs.size > 200) this.turnDiffs.delete(this.turnDiffs.keys().next().value);
        this.turnDiffs.set(diffKey, diffText);
        notify('turn/diff/updated', { diff: diffText });
      }
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
        if (!previous) notify('item/started', { item: converted, startedAtMs: item.createdAt ?? Date.now() });
        if (item.type === 'agent_message' && item.content?.length > (previous?.content?.length || 0)) notify('item/agentMessage/delta', { itemId: item.id, delta: item.content.slice(previous?.content?.length || 0) });
        if (item.type === 'reasoning' && item.content?.length > (previous?.content?.length || 0)) notify('item/reasoning/summaryTextDelta', { itemId: item.id, summaryIndex: 0, delta: item.content.slice(previous?.content?.length || 0) });
        if (terminal(item.status) && (!terminal(previous?.status) || ['file_change', 'tool_call'].includes(item.type) && JSON.stringify(converted) !== JSON.stringify(projectItem(previous)))) notify('item/completed', { item: converted, completedAtMs: item.updatedAt ?? item.createdAt ?? Date.now() });
        this.published.set(item.id, structuredClone(item));
        if (this.published.size > 200) {
          const oldest = this.published.keys().next().value;
          if (oldest) this.published.delete(oldest);
        }
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
      if (Array.isArray(projected.turn.itemIds)) {
        for (const id of projected.turn.itemIds) this.published.delete(id);
      }
      for (const [id, app] of this.approvals.entries()) {
        if (app.threadId === threadId) this.approvals.delete(id);
      }
      if (projected.turn.status === 'completed') {
        setTimeout(async () => {
          const queue = this.getQueue(threadId);
          const currentThread = this.thread(threadId);
          if (queue.length > 0 && currentThread && !this.runtime.execution.isRunning(threadId) && !this.steering.has(threadId) && !this.runtime.sending?.has(threadId)) {
            try {
              await this.startQueuedSubmission(currentThread, queue[0]);
            } catch (err) {
              console.error(`Failed to auto-drain queued submission for thread ${threadId}:`, err);
            }
          }
        }, 2500);
      }
    }
  }
  async startQueuedSubmission(thread, submission) {
    if (this.queueStarts.has(submission.id)) throw new Error('Queued submission is already starting');
    this.queueStarts.add(submission.id);
    try {
      // Keep the item addressable until the native harness has accepted a real Turn. If
      // input preparation or turn startup fails, Desktop can still edit/retry/delete it.
      const { text, attachments } = await prepareInput(submission.input, thread.cwd);
      if (attachments.length && !this.runtime.getCapabilities(thread.harnessId).conversation.attachments) {
        throw new Error('当前 Harness 不支持图片附件');
      }
      let started;
      if (this.runtime.execution.isRunning(thread.id)) {
        const turnId = await this.steerExclusive(thread, thread.currentTurn?.id, text, attachments);
        started = this.runtime.core.getTurn(turnId) || thread.currentTurn;
      } else {
        started = await this.startNativeTurn(thread, text, attachments);
      }
      const queue = this.getQueue(thread.id);
      const idx = queue.findIndex(item => item.id === submission.id);
      if (idx !== -1) {
        queue.splice(idx, 1);
        this.emitQueueChanged(thread.id);
      }
      return started;
    } finally {
      this.queueStarts.delete(submission.id);
    }
  }
  async startNativeTurn(thread, text, attachments, commandId, turnPermissions) {
    const before = thread.currentTurn?.id;
    for (let i = 0; i < 100 && this.runtime.sending?.has(thread.id) && !this.runtime.execution.isRunning(thread.id); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    let failure;
    const running = (commandId ? this.runtime.executeCommand(thread.id, commandId) : this.runtime.send(thread.id, text, { attachments, turnPermissions })).catch(error => { failure = error; });
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
      const settled = () => !this.runtime.execution.isRunning(thread.id) && !thread.reviewPending && !this.runtime.sending?.has(thread.id);
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
    // Desktop 的 answers 为 string[]：多选提问（如 ACP/OpenCode multiple）勾选多项时
    // 只取 [0] 会无声吞掉其余选项，且 opencode 对 multiple 题执行 JSON.parse(response.value)，
    // 单值字符串会直接抛 SyntaxError——多答案 JSON 编码全量保留，单答案维持原字符串。
    const rawAnswers = message.result?.answers?.[pending.requestId]?.answers;
    const answer = Array.isArray(rawAnswers) && rawAnswers.length > 1 ? JSON.stringify(rawAnswers) : (rawAnswers?.[0] ?? '');
    const decision = message.result?.decision;
    const response = pending.item.type === 'question' ? { value: answer || '' } : pending.item.method === 'select' ? { value: answer || '' } : { confirmed: decision === 'accept' || decision === 'acceptForSession' };
    await this.runtime.respondApproval(pending.threadId, pending.requestId, response);
    this.approvals.delete(message.id);
    return true;
  }
  close() {
    this.closed = true;
    this.codexAccounts.close();
    this.unsubscribe();
    this.unsubscribeRuntime();
    for (const timer of this.queueNotifications.values()) clearTimeout(timer);
    this.queueNotifications.clear();
  }
}
module.exports = { NativeProtocol, decodeRoute, projectItem, externalId, routeModel };
