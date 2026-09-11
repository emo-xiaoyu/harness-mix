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

// 能力声明按 Harness 文档化支持面逐项传入；默认值保持 ACP 家族基线（事件只在原生端真正发出时才投影）。
function acpAdapter({ id, name, bin, args, executable = false, images = false, fork = false, thinking = false, permissions = false,
  questions = true, compaction = true, usage = true, contextUsage = true, resolveCommand, inspectCustom }) {
  const manifest = { id, name, icon: `${id}-color.svg`, aliases: [id], capabilities: { streaming: true, thinking: true, tools: true, approvals: true,
    questions, models: true, thinkingLevels: thinking, permissionModes: permissions, resume: true, fork, forkFromMessage: false,
    compaction, usage, contextUsage, attachments: images } };
  function command(argv) {
    if (typeof resolveCommand === 'function') {
      const resolved = resolveCommand(argv);
      if (resolved) return resolved;
    }
    if (typeof bin === 'function') return bin(argv);
    if (executable) {
      if (process.platform === 'win32' && (bin.toLowerCase().endsWith('.cmd') || bin.toLowerCase().endsWith('.bat'))) {
        return cliSpawn(bin.replace(/\.(cmd|bat)$/i, ''), argv);
      }
      return { command: bin, args: argv };
    }
    return cliSpawn(bin, argv);
  }
  function create() {
    const adapter = {
      async inspect() {
        if (typeof inspectCustom === 'function') {
          try { return await inspectCustom(); } catch (e) { return { available: false, detail: `${name} CLI 不可用: ${e.message}` }; }
        }
        try {
          const cli = command(['--version']);
          return await new Promise(resolve => execFile(cli.command, cli.args, { windowsHide: true, timeout: 10000 }, (error, out) => resolve({ available: !error, detail: error ? `${name} CLI 不可用` : (out || '').trim() })));
        } catch (error) {
          return { available: false, detail: `${name} CLI 不可用: ${error.message}` };
        }
      },
      async describe() { return { models: null, thinkingLevels: [], permissionModes: [] }; },
      async open({ thread, emit, diagnostic = () => {} }) {
        const cli = command(args);
        const session = { cwd: thread.cwd, nativeSessionId: null, state: { configOptions: [], models: null, modes: null, commands: [], usage: undefined, loading: true }, pendingApprovals: new Map(), tools: new Map(), emit };
        session.process = new JsonlProcess(cli.command, cli.args, { cwd: thread.cwd }, {
          onDiagnostic: diagnostic,
          onExit: error => { for (const pending of session.pendingApprovals.values()) pending.reject(error); session.pendingApprovals.clear(); },
          onRequest: request => {
            if (request.method !== 'session/request_permission') throw new Error(`Unsupported ACP client request: ${request.method}`);
            const requestId = randomUUID();
            return new Promise((resolve, reject) => {
              const options = request.params.options || [];
              session.pendingApprovals.set(requestId, { resolve, reject, options });
              emit({ kind: 'approval', requestId, method: 'confirm', title: request.params.toolCall?.title || 'Native tool permission' });
            });
          },
          onEvent: event => {
            if (event.method !== 'session/update') return;
            const u = event.params.update;
            if (u.sessionUpdate === 'config_option_update') session.state.configOptions = u.configOptions;
            if (u.sessionUpdate === 'available_commands_update') session.state.commands = u.availableCommands || [];
            if (u.sessionUpdate === 'current_mode_update' && session.state.modes) session.state.modes.currentModeId = u.currentModeId;
            if (session.state.loading) return;
            if (u.sessionUpdate === 'agent_message_chunk') emit({ kind: 'text-delta', text: textOf(u.content) });
            if (u.sessionUpdate === 'agent_thought_chunk') emit({ kind: 'thinking-delta', text: textOf(u.content) });
            if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
              const tool = { ...session.tools.get(u.toolCallId), ...u };
              session.tools.set(u.toolCallId, tool);
              const output = textOf(tool.content);
              emit({ kind: 'tool', toolCallId: tool.toolCallId, title: tool.title || tool.kind || 'tool', state: tool.status === 'completed' ? 'completed' : tool.status === 'failed' ? 'error' : 'running',
                input: typeof tool.rawInput === 'string' ? tool.rawInput : JSON.stringify(tool.rawInput),
                output: output || (typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput)) });
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
          const result = await session.process.request(thread.restore ? 'session/load' : 'session/new', { cwd: thread.cwd, mcpServers: [], ...(thread.restore ? { sessionId: thread.nativeSessionId } : {}) });
          session.nativeSessionId = result.sessionId || thread.nativeSessionId;
          session.state.configOptions = result.configOptions || [];
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
      // 契约要求：models 能力 ⇒ 按会话返回模型目录（ACP 目录来自 session/new 的 configOptions/models）
      async listModelsFor(session) { return catalog(session).models; },
      async send(session, text, hooks, attachments) {
        if (attachments?.images?.length && !session.state.agentCapabilities?.promptCapabilities?.image) throw new Error(`${name} 原生 ACP 不支持图片`);
        const prompt = [...(text ? [{ type: 'text', text }] : []), ...(attachments?.images || []).map(i => ({ type: 'image', data: i.data, mimeType: i.mime }))];
        const result = await session.process.request('session/prompt', { sessionId: session.nativeSessionId, prompt });
        hooks.emit({ kind: 'completed', finalAnswer: result.stopReason !== 'cancelled' });
      },
      async cancel(session) { session.process.notify('session/cancel', { sessionId: session.nativeSessionId }); },
      async respond(session, requestId, response) {
        const pending = session.pendingApprovals.get(requestId);
        if (!pending) throw new Error('Unknown native approval');
        const option = pending.options.find(o => o.kind === (response.confirmed ? 'allow_once' : 'reject_once'));
        if (response.confirmed && !option) throw new Error('Native agent offers no single-use approval');
        pending.resolve({ outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
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
      async listCommands(session) { return (session?.state.commands || []).map(c => ({ id: c.name, label: '/' + c.name, description: c.description, action: 'insert' })); },
      async executeCommand(session, id, hooks) { await adapter.send(session, '/' + id, hooks); },
      async getContextUsage(session) { return session.state.usage; },
      async fork(source, context) {
        if (!fork || context.message) throw new Error('Native ACP does not support this fork boundary');
        const probe = await adapter.open({ thread: { ...source, restore: true }, emit: () => {}, diagnostic: context.diagnostic });
        try {
          const result = await probe.process.request('session/fork', { sessionId: source.nativeSessionId, cwd: source.cwd });
          return { session: await adapter.open({ thread: { ...source, nativeSessionId: result.sessionId, restore: true }, emit: context.emit, diagnostic: context.diagnostic }) };
        } finally { await adapter.close(probe); }
      },
      async close(session) { session.process.stop(); },
    };
    return adapter;
  }
  return { manifest, create };
}
module.exports = { acpAdapter, catalog };
