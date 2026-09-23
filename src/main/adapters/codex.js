const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { CodexAppServer } = require('./codex-app-server');
const { cliSpawn } = require('../host/jsonl');
const { recordNative } = require('../harness-adapter/fixture-recorder');
const { codexErrorInfoKey } = require('../harness-adapter/error-kind');

const manifest = {
  id: 'codex',
  name: 'Codex',
  icon: 'codex-color.svg',
  aliases: ['codex', 'codex-harness'],
  capabilities: {
    plan: true, streaming: true, thinking: true, tools: true,
    approvals: true, questions: true, models: true, thinkingLevels: true,
    permissionModes: true, resume: true, fork: true, forkFromMessage: true,
    compaction: true, nativeDiff: true, nativePatch: true,
    usage: true, contextUsage: true, cost: false, attachments: true,
    collaborationTools: true,
  },
};

const MAX_TOOL_TEXT = 24_000;

function text(value) {
  if (value == null) return undefined;
  const result = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return result.length > MAX_TOOL_TEXT ? `${result.slice(0, MAX_TOOL_TEXT)}\n[桌面预览已截断]` : result;
}

function modelView(model) {
  return {
    id: model.model ?? model.id,
    name: model.displayName ?? model.model ?? model.id,
    provider: 'openai',
    description: model.description,
    efforts: (model.supportedReasoningEfforts ?? []).map((entry) => ({
      id: entry.reasoningEffort,
      label: entry.reasoningEffort,
      hint: entry.description,
    })),
    defaultEffort: model.defaultReasoningEffort,
    contextWindow: model.contextWindow,
    isDefault: model.isDefault === true,
  };
}

async function listAll(host, method, params = {}) {
  const data = [];
  let cursor = null;
  do {
    const page = await host.request(method, { ...params, ...(cursor ? { cursor } : {}) });
    data.push(...(page?.data ?? []));
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  return data;
}

const TRANSPORT_PERMISSION_MODE_ID = /^[A-Za-z0-9._~-]+$/;
const DEFAULT_PERMISSION_MODE_ID = 'default';
const CODEX_PROFILE_ID_PREFIX = 'codex-profile-';
const MAX_TRANSPORT_PERMISSION_MODE_ID_LENGTH = 128;
const MAX_TRANSPORT_PERMISSION_MODE_COUNT = 32;

/** The shared Desktop contract's id rule, kept local to avoid a JS→TS import. */
function isTransportSafePermissionModeId(value) {
  return typeof value === 'string'
    && value.length <= MAX_TRANSPORT_PERMISSION_MODE_ID_LENGTH
    && TRANSPORT_PERMISSION_MODE_ID.test(value);
}

/**
 * Convert a native Codex permission-profile id into a deterministic protocol id.
 *
 * Codex accepts arbitrary profile identifiers from configuration, while the
 * Desktop external-harness transport deliberately accepts only URL-safe ids.
 * A SHA-256 base64url digest keeps the public id stable, bounded, and opaque;
 * the original value never has to pass through the transport as an id.
 *
 * Limitation: the digest is not reversible. Callers must retain or refresh the
 * native catalog before sending a selected mode back to Codex.
 */
function opaquePermissionModeId(nativeId) {
  return CODEX_PROFILE_ID_PREFIX + createHash('sha256').update(nativeId, 'utf8').digest('base64url');
}

/**
 * Normalize native display text before it crosses the Desktop strict schema.
 * Native profile data is user-controlled configuration, so malformed labels or
 * descriptions must not make the whole Harness connection diagnostic fail.
 */
function permissionModeText(value, fallback, maximumLength) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().slice(0, maximumLength);
  return normalized || fallback;
}

/**
 * Project Codex's permission profiles into the finite, transport-safe catalog
 * used by Harness Mix. Safe legacy ids remain unchanged for persisted-thread
 * compatibility; unsafe ids use a deterministic opaque id and are mapped back
 * only in this adapter. `default` stays reserved for "use native defaults".
 */
function permissionModeCatalog(profiles) {
  const nativeProfiles = new Map();
  for (const profile of profiles || []) {
    if (!profile?.allowed || typeof profile.id !== 'string' || !profile.id) continue;
    nativeProfiles.set(profile.id, profile);
  }

  // A native profile may legally be named like an opaque id. Reserve every
  // directly exposed legacy id first so an unsafe profile cannot shadow it.
  const reservedIds = new Set([...nativeProfiles.keys()].filter((id) => (
    id !== DEFAULT_PERMISSION_MODE_ID && isTransportSafePermissionModeId(id)
  )));
  const usedIds = new Set([DEFAULT_PERMISSION_MODE_ID]);
  const modes = [{
    id: DEFAULT_PERMISSION_MODE_ID,
    label: '原生默认',
    description: '使用 Codex 当前配置的权限策略',
  }];
  const nativeByTransportId = new Map([[DEFAULT_PERMISSION_MODE_ID, null]]);

  for (const [nativeId, profile] of nativeProfiles) {
    const legacySafeId = nativeId !== DEFAULT_PERMISSION_MODE_ID && isTransportSafePermissionModeId(nativeId);
    const baseId = legacySafeId ? nativeId : opaquePermissionModeId(nativeId);
    let transportId = baseId;
    let suffix = 1;
    while (usedIds.has(transportId) || (!legacySafeId && reservedIds.has(transportId))) {
      transportId = `${baseId}-${suffix++}`;
    }
    usedIds.add(transportId);
    nativeByTransportId.set(transportId, nativeId);
    const description = permissionModeText(profile.description, '', 1_024);
    // The Desktop schema permits 32 total modes, including the reserved default.
    // Keep resolving overflow profiles for persisted threads, but do not expose
    // them as new UI choices until the shared protocol raises that hard limit.
    if (modes.length < MAX_TRANSPORT_PERMISSION_MODE_COUNT) {
      modes.push({
        id: transportId,
        label: permissionModeText(profile.name ?? nativeId, 'Codex 权限配置', 256),
        ...(description ? { description } : {}),
      });
    }
  }

  return { modes, nativeByTransportId, nativeProfiles };
}

/**
 * Resolve a selected external mode id to the exact native Codex profile id.
 * The safe-id lookup is the normal path; the legacy path supports previously
 * persisted safe profile ids from before opaque projection was introduced.
 */
function nativePermissionMode(mode, catalog) {
  if (mode === DEFAULT_PERMISSION_MODE_ID) return null;
  if (typeof mode !== 'string' || !catalog) return undefined;
  if (catalog.nativeByTransportId.has(mode)) return catalog.nativeByTransportId.get(mode);
  return isTransportSafePermissionModeId(mode) && catalog.nativeProfiles.has(mode) ? mode : undefined;
}

function toolTitle(item) {
  if (!item) return 'Codex 工具';
  if (item.type === 'commandExecution') return 'exec_command';
  if (item.type === 'fileChange') return 'edit';
  if (item.type === 'mcpToolCall') return `${item.server}/${item.tool}`;
  if (item.type === 'dynamicToolCall') return [item.namespace, item.tool].filter(Boolean).join('/') || '工具';
  if (item.type === 'collabAgentToolCall') return `Agent · ${item.tool}`;
  if (item.type === 'webSearch') return '搜索网页';
  if (item.type === 'imageView') return '查看图片';
  if (item.type === 'imageGeneration') return '生成图片';
  if (item.type === 'subAgentActivity') return `子 Agent · ${item.kind}`;
  return item.type || 'Codex 工具';
}

function toolState(item) {
  const status = item?.status;
  if (['completed', 'success'].includes(status)) return 'done';
  if (['failed', 'declined', 'error'].includes(status)) return 'error';
  return 'running';
}

function toolInput(item) {
  if (item?.type === 'commandExecution') return item.command;
  if (item?.type === 'fileChange') return (item.changes ?? []).map(change => change.path).filter(Boolean).join('\n') || undefined;
  if (item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall') return text(item.arguments);
  if (item?.type === 'collabAgentToolCall') return item.prompt;
  if (item?.type === 'imageView') return item.path;
  return undefined;
}

function toolOutput(item, session) {
  if (item?.type === 'commandExecution') return item.aggregatedOutput ?? session?.state?.toolOutput.get(item.id);
  if (item?.type === 'mcpToolCall') return text(item.result ?? item.error);
  if (item?.type === 'dynamicToolCall') return text(item.contentItems);
  return session?.state?.toolOutput.get(item?.id);
}

function nativeChanges(item, complete = false) {
  return (item?.changes ?? []).map((change) => ({
    path: change.path,
    patch: change.diff,
    changeType: change.kind?.type ?? change.kind ?? 'modified',
    complete,
    nativeRef: { toolCallId: item.id },
  }));
}

function usageView(tokenUsage) {
  if (!tokenUsage) return undefined;
  const last = tokenUsage.last ?? {};
  const total = tokenUsage.total ?? {};
  const tokens = Number.isFinite(last.totalTokens) ? last.totalTokens : null;
  const contextWindow = Number.isFinite(tokenUsage.modelContextWindow) ? tokenUsage.modelContextWindow : 128_000;
  return {
    tokens,
    contextWindow,
    contextPercent: tokens != null && contextWindow ? 100 * tokens / contextWindow : null,
    inputTokens: total.inputTokens ?? null,
    outputTokens: total.outputTokens ?? null,
    cachedInputTokens: total.cachedInputTokens ?? null,
    reasoningOutputTokens: total.reasoningOutputTokens ?? null,
  };
}

/** Skill name → UI 契约 id（[A-Za-z0-9._:-]+，≤128）；"Agent Browser" → "agent-browser" */
function slugifySkillId(name) {
  if (typeof name !== 'string') return '';
  return name.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128);
}

function emitTool(item, session, emit, state = toolState(item)) {
  emit({
    kind: 'tool', toolCallId: item.id, title: toolTitle(item), state,
    input: toolInput(item), output: toolOutput(item, session),
    nativeRef: { sessionId: session.nativeSessionId, turnId: session.state.nativeTurnId, itemId: item.id, toolCallId: item.id },
  });
}

function projectNotification(message, session, emit) {
  recordNative(manifest.id, message);
  const { method, params = {} } = message ?? {};
  const nativeRef = {
    sessionId: session.nativeSessionId,
    ...(params.turnId || params.turn?.id ? { turnId: params.turnId ?? params.turn.id } : {}),
    ...(params.itemId || params.item?.id ? { itemId: params.itemId ?? params.item.id } : {}),
  };
  switch (method) {
    case 'turn/started':
      session.state.nativeTurnId = params.turn?.id;
      break;
    case 'item/agentMessage/delta':
      session.state.itemText.set(params.itemId, (session.state.itemText.get(params.itemId) ?? '') + params.delta);
      emit({ kind: 'text-delta', text: params.delta, nativeRef });
      break;
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      session.state.reasoningItems.add(params.itemId);
      emit({ kind: 'thinking-delta', text: params.delta, nativeRef });
      break;
    case 'turn/plan/updated':
      emit({ kind: 'plan', entries: (params.plan ?? []).map((entry) => ({
        text: entry.step ?? entry.text ?? '', status: entry.status,
      })), nativeRef });
      break;
    case 'item/started': {
      const item = params.item;
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration', 'subAgentActivity'].includes(item?.type)) {
        emitTool(item, session, emit, 'running');
      }
      break;
    }
    case 'item/commandExecution/outputDelta': {
      const output = (session.state.toolOutput.get(params.itemId) ?? '') + (params.delta ?? '');
      session.state.toolOutput.set(params.itemId, output.slice(-MAX_TOOL_TEXT));
      emit({ kind: 'tool', toolCallId: params.itemId, state: 'running', output: session.state.toolOutput.get(params.itemId), nativeRef });
      break;
    }
    case 'item/fileChange/patchUpdated':
      emit({ kind: 'file-change', source: 'native', changes: nativeChanges({ id: params.itemId, status: 'inProgress', changes: params.changes }), nativeRef });
      break;
    case 'item/completed': {
      const item = params.item;
      if (item?.type === 'agentMessage' && !session.state.itemText.has(item.id) && item.text) {
        emit({ kind: 'text-delta', text: item.text, nativeRef });
      } else if (item?.type === 'reasoning' && Array.isArray(item.summary) && item.summary.length) {
        // Older app-server versions may send only the completed reasoning item.
        if (!session.state.reasoningItems.has(item.id)) emit({ kind: 'thinking-delta', text: item.summary.join('\n'), nativeRef });
      } else if (item?.type === 'fileChange') {
        emitTool(item, session, emit, toolState(item));
        emit({ kind: 'file-change', source: 'native', changes: nativeChanges(item, true), nativeRef });
      } else if (item?.type === 'contextCompaction') {
        emit({ kind: 'compaction', state: 'completed', outcome: 'succeeded', nativeRef });
        session.state.compaction?.resolve();
      } else if (item && !['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction', 'hookPrompt'].includes(item.type)) {
        emitTool(item, session, emit, toolState(item));
      }
      session.state.toolOutput.delete(item?.id);
      break;
    }
    case 'thread/tokenUsage/updated': {
      const usage = usageView(params.tokenUsage);
      if (usage) {
        session.state.usage = usage;
        emit({ kind: 'usage', usage, nativeRef });
      }
      break;
    }
    case 'thread/compacted':
      emit({ kind: 'compaction', state: 'completed', outcome: 'succeeded', nativeRef });
      session.state.compaction?.resolve();
      break;
    case 'warning':
    case 'configWarning':
      emit({ kind: 'notice', level: 'warning', text: params.message, nativeRef });
      break;
    case 'error': {
      // Codex 原生 CodexErrorInfo 随错误透传：分类与桌面原生错误 UX 都以它为准
      const codexErrorInfo = codexErrorInfoKey(params.error?.codexErrorInfo);
      if (!params.willRetry) emit({ kind: 'error', message: params.error?.message ?? 'Codex 回合失败', ...(codexErrorInfo ? { codexErrorInfo } : {}), nativeRef });
      else emit({ kind: 'status', text: `Codex 正在重试：${params.error?.message ?? '请求失败'}`, nativeRef });
      break;
    }
    case 'turn/completed': {
      const turn = params.turn ?? {};
      if (turn.usage || params.usage) {
        const u = turn.usage || params.usage;
        session.state.usage = {
          inputTokens: u.inputTokens ?? u.input_tokens,
          outputTokens: u.outputTokens ?? u.output_tokens,
          cachedInputTokens: u.cachedInputTokens ?? u.cache_read_tokens,
          totalTokens: u.totalTokens ?? u.total_tokens,
        };
        emit({ kind: 'usage', usage: session.state.usage, nativeRef: { ...nativeRef, checkpointId: turn.id } });
      }
      if (session.state.compaction) {
        session.state.compaction.turnId = turn.id;
        if (turn.status === 'failed') session.state.compaction.reject(new Error(turn.error?.message ?? 'Codex 压缩失败'));
        else session.state.compaction.resolve();
        break;
      }
      const failed = turn.status === 'failed';
      if (failed) emit({ kind: 'error', message: turn.error?.message ?? 'Codex 回合失败', ...(codexErrorInfoKey(turn.error?.codexErrorInfo) ? { codexErrorInfo: codexErrorInfoKey(turn.error?.codexErrorInfo) } : {}), nativeRef: { ...nativeRef, checkpointId: turn.id } });
      else emit({
        kind: 'completed', finalAnswer: turn.status === 'completed',
        stopReason: turn.status === 'interrupted' ? 'cancelled' : 'completed',
        nativeRef: { ...nativeRef, checkpointId: turn.id },
      });
      const pending = session.state.turn;
      session.state.turn = null;
      session.state.nativeTurnId = null;
      if (failed) pending?.reject(new Error(turn.error?.message ?? 'Codex 回合失败'));
      else pending?.resolve();
      break;
    }
    default:
      break;
  }
}

function approvalOptions(method, params) {
  if (method === 'item/permissions/requestApproval') {
    return [
      { id: 'accept', label: '允许本轮' },
      { id: 'acceptForSession', label: '本会话允许' },
      { id: 'decline', label: '拒绝', kind: 'reject' },
    ];
  }
  const available = params.availableDecisions ?? ['accept', 'acceptForSession', 'decline'];
  const labels = { accept: '允许', acceptForSession: '本会话允许', decline: '拒绝', cancel: '取消' };
  return available.filter((value) => typeof value === 'string').map((id) => ({ id, label: labels[id] ?? id, ...(id === 'decline' || id === 'cancel' ? { kind: 'reject' } : {}) }));
}

function queueRequest(message, session, emit) {
  const { method, params = {}, id } = message;
  if (method === 'mcpServer/elicitation/request') {
    const requestId = `codex-${id}`;
    return new Promise(resolve => {
      session.pendingApprovals.set(requestId, { method, resolve, params });
      const form = params.mode === 'form' && Object.keys(params.requestedSchema?.properties ?? {}).length > 0;
      emit({ kind: 'approval', requestId, method: form ? 'input' : 'select',
        title: `Codex MCP · ${params.serverName}`, message: [params.message, params.url, form ? JSON.stringify(params.requestedSchema) : ''].filter(Boolean).join('\n'),
        ...(form ? { placeholder: '按原生请求填写 JSON；取消可拒绝' } : { options: [{ id: 'accept', label: '允许' }, { id: 'decline', label: '拒绝', kind: 'reject' }] }),
        nativeRef: { sessionId: session.nativeSessionId, turnId: params.turnId ?? undefined, interactionId: String(id) } });
    });
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = params.questions ?? [];
    return new Promise((resolve) => {
      const group = { method, resolve, answers: {}, remaining: new Set() };
      for (const question of questions) {
        const requestId = `codex-${id}-${question.id}`;
        group.remaining.add(requestId);
        session.pendingApprovals.set(requestId, { group, question });
        emit({
          kind: 'approval', requestId, method: question.options?.length ? undefined : 'input',
          title: question.header || 'Codex 提问', message: question.question,
          options: (question.options ?? []).map((option) => ({ id: option.label, label: option.label })),
          placeholder: question.isSecret ? '请输入（内容将发送给 Codex）' : '请输入…',
          nativeRef: { sessionId: session.nativeSessionId, turnId: params.turnId, itemId: params.itemId, interactionId: String(id) },
        });
      }
      if (!questions.length) resolve({ answers: {} });
    });
  }

  if (method.endsWith('/requestApproval') || method.includes('requestApproval')) {
    const requestId = `codex-${id}`;
    return new Promise((resolve) => {
      session.pendingApprovals.set(requestId, { method, resolve, params });
      const title = method.includes('commandExecution') ? 'Codex 请求运行命令'
        : method.includes('fileChange') ? 'Codex 请求修改文件'
        : (method.includes('mcp') || method.includes('tool')) ? `Codex 请求调用工具 · ${params.tool ?? params.toolName ?? params.serverName ?? 'MCP'}`
        : 'Codex 请求权限审批';
      const messageText = params.reason ?? params.command ?? params.tool ?? (params.grantRoot ? `允许写入 ${params.grantRoot}` : text(params.permissions));
      emit({
        kind: 'approval', requestId, title, message: messageText,
        options: approvalOptions(method, params),
        nativeRef: { sessionId: session.nativeSessionId, turnId: params.turnId, itemId: params.itemId, interactionId: String(id) },
      });
    });
  }
  throw new Error(`Harness Mix 暂不处理 Codex 请求：${method}`);
}

function attachSession(host, nativeSessionId, { emit, diagnostic, model, effort, cwd, permissionModeCatalog } = {}) {
  const session = {
    host, nativeSessionId, model, cwd, permissionModeCatalog,
    pendingApprovals: new Map(),
    state: {
      turn: null, compaction: null, nativeTurnId: null, usage: undefined, effort,
      itemText: new Map(), reasoningItems: new Set(), toolOutput: new Map(),
    },
  };
  session.unwatch = host.watch(nativeSessionId, {
    onEvent: (message) => projectNotification(message, session, emit),
    onRequest: (message) => queueRequest(message, session, emit),
    onExit: (error) => {
      diagnostic?.(error.message);
      session.state.turn?.reject(error);
      session.state.turn = null;
      session.state.compaction?.reject(error);
      session.state.compaction = null;
      for (const pending of session.pendingApprovals.values()) pending.resolve?.(pending.method === 'mcpServer/elicitation/request' ? { action: 'cancel', content: null } : { decision: 'cancel' });
      session.pendingApprovals.clear();
    },
  });
  return session;
}

// 官方 app-server 的两种权限序列化（实测 26.9.x）：
// thread/start 与 thread/resume 的 sandbox 只接受 kebab-case 纯字符串；
// turn/start 的 sandboxPolicy 接受 camelCase type 的对象；approvalsReviewer 枚举有限定。
const SANDBOX_TO_KEBAB = { dangerFullAccess: 'danger-full-access', readOnly: 'read-only', workspaceWrite: 'workspace-write', 'danger-full-access': 'danger-full-access', 'read-only': 'read-only', 'workspace-write': 'workspace-write' };
const SANDBOX_TO_CAMEL = { dangerFullAccess: 'dangerFullAccess', readOnly: 'readOnly', workspaceWrite: 'workspaceWrite', externalSandbox: 'externalSandbox', 'danger-full-access': 'dangerFullAccess', 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite' };
const REVIEWER_TO_WIRE = { user: 'user', auto_review: 'auto_review', guardian_subagent: 'guardian_subagent', guardian: 'guardian_subagent' };

function sandboxToKebabString(sandbox) {
  if (sandbox == null) return null;
  const raw = typeof sandbox === 'string' ? sandbox : sandbox.type;
  return SANDBOX_TO_KEBAB[raw] ?? null;
}

function sandboxPolicyToCamelObject(sandbox) {
  if (!sandbox || typeof sandbox !== 'object') return null;
  const type = SANDBOX_TO_CAMEL[sandbox.type];
  return type ? { ...sandbox, type } : null;
}

function reviewerToWire(reviewer) {
  return typeof reviewer === 'string' ? REVIEWER_TO_WIRE[reviewer] ?? null : null;
}

const APP_SERVER_BUSY = /^Agent is already processing(?:\.|$)/i;
// busy 重试总预算：覆盖同线程 queue-start 的瞬时清槽，也覆盖共享 app-server 上
// 另一线程的短 turn（部分版本按进程串行 turn）；长 turn 仍会超预算失败并如实报错
const BUSY_RETRY_BUDGET_MS = 20_000;

async function startTurnAfterNativeSettlement(host, params) {
  // A queue-start can arrive immediately after turn/completed, while app-server is still
  // clearing its active-turn slot. Keep the same logical Core turn and retry only this
  // narrow transient; other errors must remain visible and must never be duplicated.
  const deadline = Date.now() + BUSY_RETRY_BUDGET_MS;
  for (let delay = 25; ; delay = Math.min(delay * 2, 2_000)) {
    try {
      return await host.request('turn/start', params);
    } catch (error) {
      if (!APP_SERVER_BUSY.test(String(error?.message ?? error)) || Date.now() + delay > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function threadOptions(thread, nativePermissionMode) {
  // turnPermissions 来自 Desktop 权限菜单（thread/settings/update 或 thread/start 参数），
  // 转发给原生 app-server 让显示选择与实际生效一致；permissions 优先级高于旧 permissionMode 档案
  const perms = thread.options?.turnPermissions ?? {};
  const sandbox = sandboxToKebabString(perms.sandboxPolicy);
  const approvalsReviewer = reviewerToWire(perms.approvalsReviewer);
  return {
    cwd: thread.cwd,
    ...(thread.options?.model?.id ? { model: thread.options.model.id } : {}),
    ...(perms.approvalPolicy ? { approvalPolicy: perms.approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(perms.permissions ? { permissions: perms.permissions } : {}),
    ...(nativePermissionMode && !perms.permissions ? { permissions: nativePermissionMode } : {}),
  };
}

function create() {
  return {
    manifest,

    async inspect() {
      const result = await new Promise((resolve) => {
        const { command, args } = cliSpawn('codex', ['--version']);
        execFile(command, args, { windowsHide: true }, (error, stdout) => resolve({ error, stdout }));
      });
      return result.error
        ? { available: false, detail: '未找到 Codex CLI（npm i -g @openai/codex）' }
        : { available: true, detail: String(result.stdout).trim() };
    },

    async open({ thread, emit, diagnostic, collaboration, managedMcp = [] }) {
      const host = await CodexAppServer.acquire(diagnostic, thread.options?.codexHome);
      try {
        // A selected mode may be an opaque transport id. Refresh the native
        // catalog in this cwd before thread/start so Codex receives its exact
        // profile id instead of the UI-safe projection. If discovery fails, we
        // deliberately omit the stale selection and keep the new thread usable.
        const selectedMode = thread.options?.permissionMode;
        let modeCatalog = null;
        if (selectedMode && selectedMode !== DEFAULT_PERMISSION_MODE_ID && !thread.options?.turnPermissions?.permissions) {
          try {
            modeCatalog = permissionModeCatalog(await listAll(host, 'permissionProfile/list', { cwd: thread.cwd }));
          } catch (error) {
            diagnostic?.(`Codex 权限配置目录读取失败，将使用原生默认：${error.message}`);
          }
        }
        const nativeMode = nativePermissionMode(selectedMode, modeCatalog);
        if (selectedMode && selectedMode !== DEFAULT_PERMISSION_MODE_ID && nativeMode === undefined && modeCatalog) {
          diagnostic?.('已选择的 Codex 权限配置不再可用，将使用原生默认');
        }
        const servers = require('./managed-mcp').namedServers(managedMcp, collaboration);
        const options = { ...threadOptions(thread, nativeMode), ...(Object.keys(servers).length ? { config: Object.fromEntries(Object.entries(servers).map(([name, value]) => [`mcp_servers.${name}`, value])) } : {}) };
        let result;
        if (thread.restore) {
          // 旧版 app-server 可能拒绝 resume 上的权限覆盖字段：降级重试不阻塞会话恢复
          try {
            result = await host.request('thread/resume', { threadId: thread.nativeSessionId, ...options });
          } catch (error) {
            const { approvalPolicy, approvalsReviewer, sandbox, ...fallback } = options;
            if (approvalPolicy === undefined && sandbox === undefined && approvalsReviewer === undefined) throw error;
            result = await host.request('thread/resume', { threadId: thread.nativeSessionId, ...fallback });
          }
        } else {
          result = await host.request('thread/start', options);
        }
        const model = { id: result.model, name: result.model, provider: result.modelProvider ?? 'openai' };
        const session = attachSession(host, result.thread.id, { emit, diagnostic, model, effort: result.reasoningEffort, cwd: thread.cwd, permissionModeCatalog: modeCatalog });
        session.turnPermissions = thread.options?.turnPermissions ?? null;
        session.collaborationEnabled = !!collaboration;
        emit({ kind: 'session', nativeSessionId: result.thread.id, model });
        return session;
      } catch (error) {
        host.release();
        throw error;
      }
    },

    async send(session, prompt, _hooks, attachments) {
      if (session.state.turn) throw new Error('Codex 当前回合尚未结束');
      session.state.itemText.clear();
      session.state.reasoningItems.clear();
      const settled = new Promise((resolve, reject) => { session.state.turn = { resolve, reject }; });
      try {
        // UserInput 原生项：text + image（data URL）；文本附件由 Host 内联进 prompt
        const input = [
          ...(prompt ? [{ type: 'text', text: prompt }] : []),
          ...(attachments?.images ?? []).map((a) => ({ type: 'image', url: `data:${a.mime};base64,${a.data}` })),
        ];
        // 回合级权限覆盖优先于线程级（Desktop 每个回合都可能推送最新选择）
        const perms = attachments?.turnPermissions ?? session.turnPermissions ?? {};
        const sandboxPolicy = sandboxPolicyToCamelObject(perms.sandboxPolicy);
        const approvalsReviewer = reviewerToWire(perms.approvalsReviewer);
        const result = await startTurnAfterNativeSettlement(session.host, {
          threadId: session.nativeSessionId,
          input,
          ...(session.model?.id ? { model: session.model.id } : {}),
          ...(session.state.effort ? { effort: session.state.effort } : {}),
          ...(perms.approvalPolicy ? { approvalPolicy: perms.approvalPolicy } : {}),
          ...(approvalsReviewer ? { approvalsReviewer } : {}),
          ...(sandboxPolicy ? { sandboxPolicy } : {}),
        });
        session.state.nativeTurnId = result.turn.id;
      } catch (error) {
        session.state.turn = null;
        throw error;
      }
      return settled;
    },

    async cancel(session) {
      // 三类原生请求各有 wire 形状（与 close() 对齐）；requestUserInput 条目没有自身 resolve，
      // 只能经由 group 结算，直接调 pending.resolve 会 TypeError 并吞掉后续的 interrupt
      for (const pending of session.pendingApprovals?.values() ?? []) {
        if (pending.group) pending.group.resolve({ answers: pending.group.answers });
        else if (pending.method === 'mcpServer/elicitation/request') pending.resolve({ action: 'cancel', content: null });
        else if (pending.method === 'item/permissions/requestApproval') pending.resolve({ permissions: {}, scope: 'turn' });
        else pending.resolve({ decision: 'decline' });
      }
      session.pendingApprovals?.clear();
      if (session.state.nativeTurnId) {
        await Promise.race([
          session.host.request('turn/interrupt', { threadId: session.nativeSessionId, turnId: session.state.nativeTurnId }).catch(() => {}),
          new Promise((r) => setTimeout(r, 2_000)),
        ]);
      }
      // turn/start 往返期间 nativeTurnId 还没写入，此时取消也必须结算本地回合，否则线程被永久卡住
      if (session.state.turn) {
        session.state.turn.resolve();
        session.state.turn = null;
      }
    },

    async respond(session, requestId, response) {
      const pending = session.pendingApprovals.get(requestId);
      if (!pending) throw new Error('Codex 原生请求已经结束');
      if (pending.method === 'mcpServer/elicitation/request') {
        const action = response?.cancelled ? 'cancel' : response?.optionId ?? (response?.confirmed === false ? 'decline' : 'accept');
        if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error('Invalid MCP elicitation response');
        let content = null;
        if (action === 'accept' && pending.params.mode === 'form') {
          content = response?.value ? JSON.parse(response.value) : {};
          require('zod').z.fromJSONSchema(pending.params.requestedSchema).parse(content);
        }
        session.pendingApprovals.delete(requestId);
        pending.resolve({ action, content });
        return;
      }
      session.pendingApprovals.delete(requestId);
      if (pending.group) {
        const answer = response?.cancelled ? [] : [String(response?.optionId ?? response?.value ?? '')];
        pending.group.answers[pending.question.id] = { answers: answer };
        pending.group.remaining.delete(requestId);
        if (!pending.group.remaining.size) pending.group.resolve({ answers: pending.group.answers });
        return;
      }
      const decision = response?.cancelled ? 'cancel' : response?.optionId ?? (response?.confirmed === false ? 'decline' : 'accept');
      if (pending.method === 'item/permissions/requestApproval') {
        const requested = pending.params.permissions ?? {};
        pending.resolve({
          permissions: ['accept', 'acceptForSession'].includes(decision)
            ? { ...(requested.network ? { network: requested.network } : {}), ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}) }
            : {},
          scope: decision === 'acceptForSession' ? 'session' : 'turn',
        });
      } else pending.resolve({ decision });
    },

    // 原生 app-server 的 skills/list 即斜杠命令目录（/<skill-name> 触发插入）；
    // 旧版 app-server 无该 RPC 时回落静态目录。无会话（session==null）不拉起进程。
    async listCommands(session) {
      const base = [{ id: 'compact', label: '压缩上下文', description: '由 Codex 原生 app-server 压缩当前 Thread', action: 'execute' }];
      if (!session) return base;
      try {
        const rows = await listAll(session.host, 'skills/list', { cwds: [session.cwd] });
        const seen = new Set(['compact']);
        const skills = [];
        for (const row of rows) {
          for (const skill of row?.skills ?? []) {
            if (skill?.enabled === false) continue;
            const id = slugifySkillId(skill.name);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            skills.push({
              id,
              label: '/' + (skill.interface?.displayName || skill.name),
              description: `${String(skill.shortDescription || skill.description || '').slice(0, 512)}（Codex 技能·${skill.scope || 'user'}）`,
              action: 'insert',
              text: '/' + id + ' ',
            });
          }
        }
        return [...base, ...skills];
      } catch { return base; }
    },

    async executeCommand(session, id, { emit }) {
      if (id !== 'compact') throw new Error('未知 Codex 指令');
      if (session.state.compaction) throw new Error('Codex 正在压缩上下文');
      const completed = new Promise((resolve, reject) => { session.state.compaction = { resolve, reject }; });
      try {
        await session.host.request('thread/compact/start', { threadId: session.nativeSessionId });
        await completed;
        const turnId = session.state.compaction?.turnId ?? session.state.nativeTurnId;
        session.state.compaction = null;
        session.state.nativeTurnId = null;
        const nativeRef = { sessionId: session.nativeSessionId, ...(turnId ? { turnId, checkpointId: turnId } : {}) };
        emit({ kind: 'text-delta', text: '上下文已由 Codex 压缩。', nativeRef });
        emit({ kind: 'completed', finalAnswer: true, nativeRef });
      } catch (error) {
        session.state.compaction = null;
        throw error;
      }
    },

    async describe() {
      const host = await CodexAppServer.acquire();
      try {
        const [rawModels, profiles] = await Promise.all([
          listAll(host, 'model/list', { includeHidden: false }),
          listAll(host, 'permissionProfile/list').catch(() => []),
        ]);
        const models = rawModels.map(modelView);
        const selected = models.find((model) => model.isDefault) ?? models[0];
        const modes = permissionModeCatalog(profiles);
        return {
          models,
          thinkingLevels: selected?.efforts ?? [],
          permissionModes: modes.modes,
        };
      } finally { host.release(); }
    },

    async describeFor(session) {
      const rawModels = await listAll(session.host, 'model/list', { includeHidden: false });
      const models = rawModels.map(modelView);
      const selected = models.find((model) => model.id === session.model?.id) ?? models.find((model) => model.isDefault) ?? models[0];
      const profiles = await listAll(session.host, 'permissionProfile/list', { cwd: session.cwd }).catch(() => []);
      const modes = permissionModeCatalog(profiles);
      session.permissionModeCatalog = modes;
      return {
        models,
        thinkingLevels: selected?.efforts ?? [],
        permissionModes: modes.modes,
      };
    },

    async listModelsFor(session) {
      return (await listAll(session.host, 'model/list', { includeHidden: false })).map(modelView);
    },

    async setModel(session, model) {
      await session.host.request('thread/settings/update', { threadId: session.nativeSessionId, model: model.id });
      session.model = { id: model.id, name: model.name ?? model.id, provider: model.provider ?? 'openai' };
      return session.model;
    },

    async setThinkingLevel(session, level) {
      await session.host.request('thread/settings/update', { threadId: session.nativeSessionId, effort: level });
      session.state.effort = level;
    },

    async setPermissionMode(session, mode) {
      let nativeMode = nativePermissionMode(mode, session.permissionModeCatalog);
      if (nativeMode === undefined) {
        const profiles = await listAll(session.host, 'permissionProfile/list', { cwd: session.cwd });
        session.permissionModeCatalog = permissionModeCatalog(profiles);
        nativeMode = nativePermissionMode(mode, session.permissionModeCatalog);
      }
      if (nativeMode === undefined) throw new Error('Native permission mode unavailable');
      await session.host.request('thread/settings/update', { threadId: session.nativeSessionId, permissions: nativeMode });
    },

    async getContextUsage(session) { return session.state.usage; },

    async fork(source, { emit, diagnostic, message }) {
      const lastTurnId = message?.coreTurn?.nativeTurnRef?.turnId ?? message?.coreTurn?.nativeTurnRef?.checkpointId;
      if (message && !lastTurnId) throw new Error('这条回复缺少 Codex 原生 Turn ID，无法精确分支');
      const host = await CodexAppServer.acquire(diagnostic, source.options?.codexHome);
      try {
        const result = await host.request('thread/fork', {
          threadId: source.nativeSessionId,
          ...(lastTurnId ? { lastTurnId } : {}),
          cwd: source.cwd,
          ...(source.model?.id ? { model: source.model.id } : {}),
        });
        const model = { id: result.model, name: result.model, provider: result.modelProvider ?? 'openai' };
        return { session: attachSession(host, result.thread.id, { emit, diagnostic, model, effort: result.reasoningEffort, cwd: source.cwd }) };
      } catch (error) {
        host.release();
        throw error;
      }
    },

    async close(session) {
      session.unwatch?.();
      if (session.state.nativeTurnId) {
        await session.host.request('turn/interrupt', { threadId: session.nativeSessionId, turnId: session.state.nativeTurnId }).catch(() => {});
      }
      for (const pending of session.pendingApprovals.values()) {
        if (pending.group) pending.group.resolve({ answers: pending.group.answers });
        else if (pending.method === 'mcpServer/elicitation/request') pending.resolve({ action: 'cancel', content: null });
        else if (pending.method === 'item/permissions/requestApproval') pending.resolve({ permissions: {}, scope: 'turn' });
        else pending.resolve({ decision: 'cancel' });
      }
      session.pendingApprovals.clear();
      session.state.compaction?.reject(new Error('Codex 会话已关闭'));
      session.state.compaction = null;
      session.host.release();
    },
  };
}

// Global discovery: ~/.agents/skills is the recommended location; $CODEX_HOME/skills
// (~/.codex/skills) is deprecated upstream but still loaded for backwards compatibility.
// https://developers.openai.com/codex/skills
manifest.integrations = { mcp: true, skills: {
  global: ['.agents/skills', '.codex/skills'],
  project: ['.agents/skills'],
  overrides: { '.codex/skills': { env: 'CODEX_HOME', suffix: 'skills' } },
} };
module.exports = {
  manifest, create, projectNotification, queueRequest, usageView, modelView,
  startTurnAfterNativeSettlement, permissionModeCatalog, nativePermissionMode,
};
