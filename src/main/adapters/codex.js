const { execFile } = require('node:child_process');
const { CodexAppServer } = require('./codex-app-server');
const { cliSpawn } = require('../host/jsonl');
const { recordNative } = require('../harness-adapter/fixture-recorder');

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
  const contextWindow = Number.isFinite(tokenUsage.modelContextWindow) ? tokenUsage.modelContextWindow : null;
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
        emit({ kind: 'status', text: '上下文已压缩', nativeRef });
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
      emit({ kind: 'status', text: '上下文已压缩', nativeRef });
      session.state.compaction?.resolve();
      break;
    case 'warning':
    case 'configWarning':
      emit({ kind: 'notice', level: 'warning', text: params.message, nativeRef });
      break;
    case 'error':
      if (!params.willRetry) emit({ kind: 'error', message: params.error?.message ?? 'Codex 回合失败', nativeRef });
      else emit({ kind: 'status', text: `Codex 正在重试：${params.error?.message ?? '请求失败'}`, nativeRef });
      break;
    case 'turn/completed': {
      const turn = params.turn ?? {};
      if (session.state.compaction) {
        session.state.compaction.turnId = turn.id;
        if (turn.status === 'failed') session.state.compaction.reject(new Error(turn.error?.message ?? 'Codex 压缩失败'));
        else session.state.compaction.resolve();
        break;
      }
      const failed = turn.status === 'failed';
      if (failed) emit({ kind: 'error', message: turn.error?.message ?? 'Codex 回合失败', nativeRef: { ...nativeRef, checkpointId: turn.id } });
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

  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
    const requestId = `codex-${id}`;
    return new Promise((resolve) => {
      session.pendingApprovals.set(requestId, { method, resolve, params });
      const title = method.includes('commandExecution') ? 'Codex 请求运行命令'
        : method.includes('fileChange') ? 'Codex 请求修改文件' : 'Codex 请求额外权限';
      const messageText = params.reason ?? params.command ?? (params.grantRoot ? `允许写入 ${params.grantRoot}` : text(params.permissions));
      emit({
        kind: 'approval', requestId, title, message: messageText,
        options: approvalOptions(method, params),
        nativeRef: { sessionId: session.nativeSessionId, turnId: params.turnId, itemId: params.itemId, interactionId: String(id) },
      });
    });
  }
  throw new Error(`Harness Mix 暂不处理 Codex 请求：${method}`);
}

function attachSession(host, nativeSessionId, { emit, diagnostic, model, effort, cwd } = {}) {
  const session = {
    host, nativeSessionId, model, cwd,
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

function threadOptions(thread) {
  return {
    cwd: thread.cwd,
    ...(thread.options?.model?.id ? { model: thread.options.model.id } : {}),
    ...(thread.options?.permissionMode && thread.options.permissionMode !== 'default' ? { permissions: thread.options.permissionMode } : {}),
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

    async open({ thread, emit, diagnostic, collaboration }) {
      const host = await CodexAppServer.acquire(diagnostic);
      try {
        const options = { ...threadOptions(thread), ...(collaboration ? { config: { 'mcp_servers.harness-mix': collaboration } } : {}) };
        const result = thread.restore
          ? await host.request('thread/resume', { threadId: thread.nativeSessionId, ...options })
          : await host.request('thread/start', options);
        const model = { id: result.model, name: result.model, provider: result.modelProvider ?? 'openai' };
        const session = attachSession(host, result.thread.id, { emit, diagnostic, model, effort: result.reasoningEffort, cwd: thread.cwd });
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
        const result = await session.host.request('turn/start', {
          threadId: session.nativeSessionId,
          input,
          ...(session.model?.id ? { model: session.model.id } : {}),
          ...(session.state.effort ? { effort: session.state.effort } : {}),
        });
        session.state.nativeTurnId = result.turn.id;
      } catch (error) {
        session.state.turn = null;
        throw error;
      }
      return settled;
    },

    async cancel(session) {
      if (!session.state.nativeTurnId) return;
      await session.host.request('turn/interrupt', { threadId: session.nativeSessionId, turnId: session.state.nativeTurnId });
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

    listCommands() {
      return [{ id: 'compact', label: '压缩上下文', description: '由 Codex 原生 app-server 压缩当前 Thread', action: 'execute' }];
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
        return {
          models,
          thinkingLevels: selected?.efforts ?? [],
          permissionModes: [
            { id: 'default', label: '原生默认', hint: '使用 Codex 当前配置的权限策略' },
            ...profiles.filter((profile) => profile.allowed).map((profile) => ({ id: profile.id, label: profile.id, hint: profile.description })),
          ],
        };
      } finally { host.release(); }
    },

    async describeFor(session) {
      const rawModels = await listAll(session.host, 'model/list', { includeHidden: false });
      const models = rawModels.map(modelView);
      const selected = models.find((model) => model.id === session.model?.id) ?? models.find((model) => model.isDefault) ?? models[0];
      const profiles = await listAll(session.host, 'permissionProfile/list', { cwd: session.cwd }).catch(() => []);
      return {
        models,
        thinkingLevels: selected?.efforts ?? [],
        permissionModes: [
          { id: 'default', label: '原生默认', hint: '使用 Codex 当前配置的权限策略' },
          ...profiles.filter((profile) => profile.allowed).map((profile) => ({ id: profile.id, label: profile.id, hint: profile.description })),
        ],
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
      await session.host.request('thread/settings/update', { threadId: session.nativeSessionId, permissions: mode === 'default' ? null : mode });
    },

    async getContextUsage(session) { return session.state.usage; },

    async fork(source, { emit, diagnostic, message }) {
      const lastTurnId = message?.coreTurn?.nativeTurnRef?.turnId ?? message?.coreTurn?.nativeTurnRef?.checkpointId;
      if (message && !lastTurnId) throw new Error('这条回复缺少 Codex 原生 Turn ID，无法精确分支');
      const host = await CodexAppServer.acquire(diagnostic);
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

module.exports = { manifest, create, projectNotification, queueRequest, usageView, modelView };
