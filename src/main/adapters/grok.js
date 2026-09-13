const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { JsonlProcess, cliSpawn } = require('../host/jsonl');

const textOf = content => Array.isArray(content) ? content.map(c => c.text ?? c.content?.text ?? '').filter(Boolean).join('\n') : content?.text || '';
function catalog(session) {
  const options = session.state.configOptions || [];
  const modelConfig = options.find(o => o.category === 'model');
  const modeConfig = options.find(o => o.category === 'mode');
  const nativeModels = session.state.models?.availableModels || [];
  const models = modelConfig ? (modelConfig.options || []).filter(o => o.value).map(o => ({ id: o.value, name: o.name, isDefault: o.value === modelConfig.currentValue }))
    : nativeModels.map(m => ({ id: m.modelId, name: m.name || m.modelId, isDefault: m.modelId === session.state.models?.currentModelId }));
  const current = nativeModels.find(m => m.modelId === session.state.models?.currentModelId);
  return { models,
    thinkingLevels: (current?._meta?.reasoningEfforts || []).map(e => ({ id: e.id, label: e.label || e.id })),
    permissionModes: modeConfig ? (modeConfig.options || []).map(o => ({ id: o.value, label: o.name, description: o.description, default: o.value === modeConfig.currentValue }))
      : (session.state.modes?.availableModes || []).map(m => ({ id: m.id, label: m.name, default: m.id === session.state.modes.currentModeId })),
  };
}

function grokAdapter() {
  const id = 'grok', name = 'Grok', bin = process.env.HARNESS_MIX_GROK_EXECUTABLE || 'grok.exe', args = ['agent', 'stdio'], executable = true, images = true, fork = true, thinking = true, permissions = false;
  const manifest = { id, name, icon: `${id}-color.svg`, aliases: [id], capabilities: { collaborationTools: true, streaming: true, thinking: true, tools: true, approvals: true,
    questions: false, models: true, thinkingLevels: thinking, permissionModes: permissions, resume: true, fork, forkFromMessage: false,
    compaction: true, usage: true, contextUsage: false, attachments: images } };
  const command = argv => executable ? { command: bin, args: argv } : cliSpawn(bin, argv);
  function create() {
    const adapter = {
      async inspect() {
        const cli = command(['--version']);
        return new Promise(resolve => execFile(cli.command, cli.args, { windowsHide: true, timeout: 10000 }, (error, out) => resolve({ available: !error, detail: error ? `${name} CLI 不可用` : out.trim() })));
      },
      async describe() { return { models: null, thinkingLevels: [], permissionModes: [] }; },
      async open({ thread, emit, diagnostic = () => {}, collaboration }) {
        const cli = command(args);
        const session = { cwd: thread.cwd, nativeSessionId: null, collaborationEnabled: !!collaboration, state: { configOptions: [], models: null, modes: null, commands: [], usage: undefined, loading: true }, pendingApprovals: new Map(), tools: new Map(), emit };
        session.process = new JsonlProcess(cli.command, cli.args, { cwd: thread.cwd }, {
          onDiagnostic: diagnostic,
          onExit: error => { for (const pending of session.pendingApprovals.values()) pending.reject(error); session.pendingApprovals.clear(); },
          onRequest: request => {
            if (request.method !== 'session/request_permission') throw new Error(`Unsupported ACP client request: ${request.method}`);
            const requestId = randomUUID();
            return new Promise((resolve, reject) => {
              const options = request.params.options || [];
              session.pendingApprovals.set(requestId, { resolve, reject, options });
              emit({ kind: 'approval', requestId, method: 'select', title: request.params.toolCall?.title || 'Native tool permission', options: options.map(o => ({ id: o.optionId, label: o.name, kind: o.kind.startsWith('reject') ? 'reject' : undefined })) });
            });
          },
          onEvent: event => {
            if (event.method === '_x.ai/models/update') { session.state.models = event.params; return; }
            const isSessionEvent = event.method === 'session/update'
              || event.method === '_x.ai/session/update'
              || event.method === 'x.ai/session_notification'
              || event.method === '_x.ai/session_notification';
            if (!isSessionEvent) return;
            if (session.nativeSessionId && event.params?.sessionId && event.params.sessionId !== session.nativeSessionId) return;
            const u = event.params?.update || event.params;
            if (!u || typeof u !== 'object') return;
            if (!session.state.loading && u.usage) {
              session.state.usage = projectUsage(u.usage);
              emit({ kind: 'usage', usage: session.state.usage });
            }
            const compactEvent = parseGrokCompactionUpdate(u);
            if (compactEvent) {
              if (compactEvent.type === 'started') {
                emit({ kind: 'compaction', state: 'running', ...compactEvent });
              } else if (compactEvent.type === 'completed') {
                if (compactEvent.tokensAfter != null) {
                  session.state.usage = {
                    ...(session.state.usage || {}),
                    tokens: compactEvent.tokensAfter,
                    totalTokens: compactEvent.tokensAfter,
                    inputTokens: compactEvent.tokensAfter,
                    ...(compactEvent.contextWindowTokens != null ? { contextWindow: compactEvent.contextWindowTokens } : {}),
                  };
                  emit({ kind: 'usage', usage: session.state.usage });
                }
                emit({ kind: 'compaction', state: 'completed', ...compactEvent });
              }
              return;
            }
            if (u.sessionUpdate === 'compaction_checkpoint') return;
            if (u.sessionUpdate === 'config_option_update') session.state.configOptions = u.configOptions;
            if (u.sessionUpdate === 'available_commands_update') session.state.commands = u.availableCommands || [];
            if (u.sessionUpdate === 'current_mode_update' && session.state.modes) session.state.modes.currentModeId = u.currentModeId;
            if (session.state.loading) return;
            if (u.sessionUpdate === 'agent_message_chunk') emit({ kind: 'text-delta', text: textOf(u.content) });
            if (u.sessionUpdate === 'agent_thought_chunk') emit({ kind: 'thinking-delta', text: textOf(u.content) });
            if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
              const tool = { ...session.tools.get(u.toolCallId), ...u };
              session.tools.set(u.toolCallId, tool);
              emit({ kind: 'tool', toolCallId: tool.toolCallId, title: tool.title || tool.kind || 'tool', state: tool.status === 'completed' ? 'completed' : tool.status === 'failed' ? 'error' : 'running', input: tool.rawInput, output: textOf(tool.content) || tool.rawOutput });
              const changes = (tool.content || []).filter(c => c.type === 'diff').map(c => ({ path: c.path, before: c.oldText ?? '', after: c.newText, changeType: c.oldText == null ? 'added' : 'modified', complete: true }));
              if (tool.status === 'completed' && changes.length) emit({ kind: 'file-change', source: 'native', changes });
            }
            if (u.sessionUpdate === 'plan') emit({ kind: 'plan', entries: u.entries });
            if (u.sessionUpdate === 'usage_update') {
              session.state.usage = { tokens: u.used, contextWindow: u.size, ...(u.cost?.currency === 'USD' ? { cost: u.cost.amount } : {}) };
              emit({ kind: 'usage', usage: session.state.usage });
            }
          },
        });
        try {
          const init = await session.process.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'harness-mix', version: '0.1.0' } });
          session.state.agentCapabilities = init.agentCapabilities;
          session.state.commands = init._meta?.availableCommands || [];
          // L1 会话级注入：Grok 原生协议的 session/new 自带 mcpServers 槽（ACP 形态 stdio 定义）
          const mcpServers = collaboration ? [{ name: 'harness-mix', command: collaboration.command, args: collaboration.args, env: Object.entries(collaboration.env).map(([envName, value]) => ({ name: envName, value })) }] : [];
          const result = await session.process.request(thread.restore ? 'session/load' : 'session/new', { cwd: thread.cwd, mcpServers, ...(thread.restore ? { sessionId: thread.nativeSessionId } : {}) });
          session.nativeSessionId = result.sessionId || thread.nativeSessionId;
          session.state.configOptions = result.configOptions || result._meta?.['x.ai/sessionConfig']?.options || [];
          session.state.models = result.models || init._meta?.modelState;
          session.state.modes = result.modes;
          session.state.loading = false;
          const models = catalog(session).models;
          session.model = models.find(m => m.isDefault) || models[0];
          if (thread.options?.model) await adapter.setModel(session, thread.options.model);
          if (thread.options?.thinking) await adapter.setThinkingLevel(session, thread.options.thinking);
          if (thread.options?.permissionMode) await adapter.setPermissionMode(session, thread.options.permissionMode);
          emit({ kind: 'session', nativeSessionId: session.nativeSessionId, model: session.model });
          return session;
        } catch (error) { session.process.stop(); throw error; }
      },
      async describeFor(session) { return catalog(session); },
      // Grok catalogs and vendor events remain owned by its native stdio process.
      async listModelsFor(session) { return catalog(session).models; },
      async send(session, text, hooks, attachments) {
        if (typeof text === 'string' && /^\/compact(?:\s+([\s\S]*))?$/.test(text.trim())) {
          const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
          const userContext = match && match[1] ? match[1].trim() : undefined;
          await doGrokCompact(session, userContext, hooks);
          return;
        }
        const prompt = [...(text ? [{ type: 'text', text }] : []), ...(attachments?.images || []).map(i => ({ type: 'image', data: i.data, mimeType: i.mime }))];
        const result = await session.process.request('session/prompt', { sessionId: session.nativeSessionId, prompt });
        if (result._meta?.usage) { session.state.usage = projectUsage(result._meta.usage); hooks.emit({ kind: 'usage', usage: session.state.usage }); }
        hooks.emit({ kind: 'completed', finalAnswer: result.stopReason !== 'cancelled', nativeRef: { checkpointId: result._meta?.promptId } });
      },
      async cancel(session) { session.process.notify('session/cancel', { sessionId: session.nativeSessionId }); },
      async respond(session, requestId, response) {
        const pending = session.pendingApprovals.get(requestId);
        if (!pending) throw new Error('Unknown native approval');
        const selected = response.optionId ?? response.value;
        const option = pending.options.find(o => o.optionId === selected);
        if (!response.cancelled && !option) throw new Error('Select an option offered by Grok');
        pending.resolve({ outcome: response.cancelled ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option.optionId } });
        session.pendingApprovals.delete(requestId);
      },
      async setModel(session, model) {
        const config = session.state.configOptions.find(c => c.category === 'model');
        if (config) {
          const result = await session.process.request('session/set_config_option', { sessionId: session.nativeSessionId, configId: config.id, value: model.id });
          session.state.configOptions = result.configOptions || session.state.configOptions;
        } else await session.process.request('session/set_model', { sessionId: session.nativeSessionId, modelId: model.id });
        if (session.state.models) session.state.models.currentModelId = model.id;
        session.model = model; return model;
      },
      async setThinkingLevel(session, level) {
        if (!catalog(session).thinkingLevels.some(l => l.id === level)) throw new Error('Native reasoning level unavailable');
        await session.process.request('session/set_mode', { sessionId: session.nativeSessionId, modeId: level });
      },
      async setPermissionMode(session, mode) {
        if (!catalog(session).permissionModes.some(m => m.id === mode)) throw new Error('Native permission mode unavailable');
        const config = session.state.configOptions.find(c => c.category === 'mode');
        if (config) {
          const result = await session.process.request('session/set_config_option', { sessionId: session.nativeSessionId, configId: config.id, value: mode });
          session.state.configOptions = result.configOptions || session.state.configOptions;
        } else await session.process.request('session/set_mode', { sessionId: session.nativeSessionId, modeId: mode });
      },
      async listCommands(session) {
        const nativeCommands = (session?.state.commands || []).map(c => ({ id: c.name, label: '/' + c.name, description: c.description, action: 'insert' }));
        const hasCompact = nativeCommands.some(c => c.id === 'compact');
        return [
          ...nativeCommands,
          ...(hasCompact ? [] : [{ id: 'compact', label: '/compact', description: '由 Grok 原生压缩当前会话上下文', action: 'execute' }]),
        ];
      },
      async executeCommand(session, id, hooks, args) {
        if (id === 'compact') {
          await doGrokCompact(session, args?.userContext || args?.text, hooks);
          return;
        }
        await adapter.send(session, '/' + id, hooks);
      },
      async getContextUsage(session) { return session.state.usage; },
      async fork(source, context) {
        if (!fork || context.message) throw new Error('Native ACP does not support this fork boundary');
        const probe = await adapter.open({ thread: { ...source, restore: true }, emit: () => {}, diagnostic: context.diagnostic });
        try {
          const result = await probe.process.request('_x.ai/session/fork', { sourceSessionId: source.nativeSessionId, sourceCwd: source.cwd, newCwd: source.cwd });
          return { session: await adapter.open({ thread: { ...source, nativeSessionId: result.newSessionId, restore: true }, emit: context.emit, diagnostic: context.diagnostic }) };
        } finally { await adapter.close(probe); }
      },
      async close(session) { session.process.stop(); },
    };
    return adapter;
  }
  return { manifest, create };
}
function projectUsage(u) {
  const fields = { inputTokens: ['inputTokens', 'input_tokens'], outputTokens: ['outputTokens', 'output_tokens'], reasoningOutputTokens: ['reasoningTokens', 'reasoning_tokens'], cacheRead: ['cachedReadTokens', 'cached_read_tokens'], cacheWrite: ['cacheCreationTokens', 'cache_creation_tokens'] };
  return Object.fromEntries(Object.entries(fields).flatMap(([key, names]) => { const value = names.map(n => u[n]).find(Number.isFinite); return value === undefined ? [] : [[key, value]]; }));
}
function parseGrokCompactionUpdate(update) {
  if (!update || typeof update !== 'object' || typeof update.sessionUpdate !== 'string') return null;
  const tokensUsed = update.tokensUsed ?? update.tokens_used;
  const contextWindowTokens = update.contextWindowTokens ?? update.contextWindow ?? update.context_window;
  const tokensBefore = update.tokensBefore ?? update.tokens_before;
  const tokensAfter = update.tokensAfter ?? update.tokens_after;
  if (update.sessionUpdate === 'auto_compact_started') {
    return {
      type: 'started',
      ...(tokensUsed != null ? { tokensUsed } : {}),
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
    };
  }
  if (update.sessionUpdate === 'auto_compact_completed') {
    return {
      type: 'completed',
      outcome: 'succeeded',
      ...(tokensBefore != null ? { tokensBefore } : {}),
      ...(tokensAfter != null ? { tokensAfter } : {}),
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
    };
  }
  if (update.sessionUpdate === 'auto_compact_failed') {
    return {
      type: 'completed',
      outcome: 'failed',
      errorMessage: update.errorMessage ?? update.error_message ?? update.message,
    };
  }
  if (update.sessionUpdate === 'auto_compact_cancelled') {
    return { type: 'completed', outcome: 'cancelled' };
  }
  return null;
}
async function doGrokCompact(session, userContext, hooks) {
  const params = {
    sessionId: session.nativeSessionId,
    ...(userContext ? { userContext } : {}),
  };
  let result;
  try {
    result = await session.process.request('x.ai/compact_conversation', params);
  } catch (err) {
    if (err.message && (err.message.includes('Method not found') || err.message.includes('-32601') || err.message.includes('not supported') || err.message.includes('Unsupported'))) {
      result = await session.process.request('_x.ai/compact_conversation', params);
    } else {
      throw err;
    }
  }
  const tokensBefore = result?.tokensBefore ?? result?.tokens_before;
  const tokensAfter = result?.tokensAfter ?? result?.tokens_after;
  const contextWindowTokens = result?.contextWindowTokens ?? result?.context_window;
  if (tokensAfter != null) {
    session.state.usage = {
      ...(session.state.usage || {}),
      tokens: tokensAfter,
      totalTokens: tokensAfter,
      inputTokens: tokensAfter,
      ...(contextWindowTokens != null ? { contextWindow: contextWindowTokens } : {}),
    };
    hooks?.emit?.({ kind: 'usage', usage: session.state.usage });
  }
  const outcome = result?.outcome ?? (result?.aborted ? 'cancelled' : result?.success === false ? 'failed' : 'succeeded');
  hooks?.emit?.({
    kind: 'compaction',
    state: 'completed',
    outcome,
    ...(tokensBefore != null ? { tokensBefore } : {}),
    ...(tokensAfter != null ? { tokensAfter } : {}),
    ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
  });
  hooks?.emit?.({ kind: 'completed', finalAnswer: outcome !== 'cancelled' });
}
module.exports = { ...grokAdapter(), projectUsage, parseGrokCompactionUpdate, doGrokCompact };
