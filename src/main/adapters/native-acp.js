const { execFile } = require('node:child_process');
const { JsonlProcess } = require('../host/jsonl');
const { AcpInteractions } = require('./acp-interactions');
const { nativeCommand } = require('./native-acp-command');
const { recordNative } = require('../harness-adapter/fixture-recorder');

const text = value => Array.isArray(value) ? value.map(text).filter(Boolean).join('\n') : value?.type === 'text' ? value.text || '' : value?.content ? text(value.content) : '';
function extractToolOutput(tool, update) {
  if (update?.content && Array.isArray(update.content) && update.content.length) {
    const direct = text(update.content);
    if (direct) return direct;
  }
  const raw = update?.rawOutput ?? tool.rawOutput;
  if (raw != null) {
    if (typeof raw === 'string') return raw;
    if (typeof raw.text === 'string') return raw.text;
    if (typeof raw.output === 'string') return raw.output;
    if (typeof raw.stdout === 'string') return raw.stdout + (raw.stderr ? '\n' + raw.stderr : '');
  }
  if (tool.content) {
    const fallback = text(tool.content);
    if (fallback) return fallback;
  }
  if (raw != null) return JSON.stringify(raw);
  return undefined;
}
const options = list => (list || []).flatMap(o => Array.isArray(o.options) ? options(o.options) : typeof o.value === 'string' ? [o] : []);
const finite = n => Number.isFinite(n) && n >= 0;
function config(s, kind) {
  const ids = { model: ['model'], thinking: ['effortLevel', 'thought_level'], mode: ['mode'] }[kind];
  return s.state.configOptions.find(o => ids.includes(o.id) || o.category === (kind === 'thinking' ? 'thought_level' : kind));
}
function catalog(s) {
  const model = config(s, 'model'), effort = config(s, 'thinking'), mode = config(s, 'mode');
  return {
    models: model ? options(model.options).map(o => ({ id: o.value, name: o.name || o.value, isDefault: o.value === model.currentValue }))
      : (s.state.models?.availableModels || []).map(o => ({ id: o.modelId, name: o.name || o.modelId, isDefault: o.modelId === s.state.models.currentModelId })),
    thinkingLevels: s.vendor === 'cursor-cli' || model?.currentValue === 'auto' ? [] : options(effort?.options).map(o => ({ id: o.value, label: o.name || o.value })),
    permissionModes: mode ? options(mode.options).map(o => ({ id: o.value, label: o.name || o.value, description: o.description, default: o.value === mode.currentValue }))
      : (s.state.modes?.availableModes || []).map(o => ({ id: o.id, label: o.name || o.id, default: o.id === s.state.modes.currentModeId })),
  };
}
function updateConfig(s, result) {
  if (Array.isArray(result.configOptions)) s.state.configOptions = result.configOptions;
  if (result.models) s.state.models = result.models;
  if (result.modes) s.state.modes = result.modes;
  s.model = catalog(s).models.find(m => m.isDefault);
}
function isTurnProgressUpdate(update) {
  return ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update?.sessionUpdate);
}
function waitForTurnDrain(s, { quietMs, maxMs }) {
  s.turnSettling = true;
  return new Promise(resolve => {
    let quietTimer;
    let maxTimer;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      if (s.turnDrainWake === wake) s.turnDrainWake = null;
      resolve();
    };
    const armQuiet = delay => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        // A late approval/question means the native turn is still waiting for
        // the user. Do not close the interaction router while it is pending;
        // the bounded max timer remains the final escape hatch.
        if (s.interactions.pending?.size) armQuiet(quietMs);
        else finish();
      }, delay);
    };
    const wake = () => {
      if (settled) return;
      // A tool/thought update alone is not a final answer. Keep the quiet
      // timer disarmed until at least one assistant message chunk is seen;
      // otherwise a server can still flush its answer after a prompt receipt
      // and a tool update. The bounded max timer remains the final escape.
      if (s.turnTextSeen) armQuiet(quietMs);
    };
    s.turnDrainWake = wake;
    if (s.turnTextSeen) armQuiet(quietMs);
    maxTimer = setTimeout(finish, Math.max(maxMs, quietMs));
  });
}
function project(s, event) {
  if (event.method !== 'session/update' || event.params?.sessionId !== s.nativeSessionId) return;
  const u = event.params.update;
  if (!u) return;
  if (u.sessionUpdate === 'config_option_update') updateConfig(s, u);
  if (u.sessionUpdate === 'available_commands_update') s.state.commands = u.availableCommands || [];
  if (u.sessionUpdate === 'current_mode_update' && s.state.modes) s.state.modes.currentModeId = u.currentModeId;
  if (!s.active || s.loading || s.closed) {
    return;
  }
  // Child updates must never be concatenated into the parent's answer.
  if (u._meta?.['codebuddy.ai/parentToolCallId']) return;
  if (isTurnProgressUpdate(u)) {
    s.turnProgressSeen = true;
    if (u.sessionUpdate === 'agent_message_chunk' && text(u.content)) s.turnTextSeen = true;
    s.turnDrainWake?.();
  }
  if (u.sessionUpdate === 'agent_message_chunk') {
    const delta = text(u.content);
    s.turnAnswer = (s.turnAnswer || '') + delta;
    s.emit({ kind: 'text-delta', text: delta });
  }
  if (u.sessionUpdate === 'agent_thought_chunk') s.emit({ kind: 'thinking-delta', text: text(u.content) });
  if (u.sessionUpdate === 'plan') s.emit({ kind: 'plan', entries: u.entries });
  if (u.sessionUpdate === 'usage_update') {
    if (finite(u.used) && finite(u.size) && u.size > 0) Object.assign(s.state.usage, { tokens: u.used, contextWindow: u.size });
    if (u.cost?.currency === 'USD' && finite(u.cost.amount)) s.state.usage.cost = u.cost.amount;
    const k = u._meta?.kiro;
    if (k) {
      const percent = k.contextUsage?.usagePercentage ?? k.usagePercentage;
      if (finite(percent)) s.state.usage.contextUsagePercent = percent;
      const ids = k.requestIds;
      const key = Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string' && id) ? JSON.stringify([...new Set(ids)].sort()) : k.executionId;
      const rows = k.promptTurnSummaries?.filter(r => r.unit === 'credit');
      if (key && rows?.length && rows.every(r => finite(r.usage))) {
        s.charges.set(key, rows.reduce((sum, r) => sum + r.usage, 0));
        s.state.usage.totalCredits = [...s.charges.values()].reduce((a, b) => a + b, 0);
      }
    }
    s.emit({ kind: 'usage', usage: { ...s.state.usage } });
  }
  if (!['tool_call', 'tool_call_update'].includes(u.sessionUpdate) || !u.toolCallId) return;
  const old = s.tools.get(u.toolCallId);
  if (old && ['completed', 'failed'].includes(old.status)) return;
  const tool = { ...old, ...u, _meta: { ...old?._meta, ...u._meta } };
  s.tools.set(u.toolCallId, tool);
  const terminal = ['completed', 'failed'].includes(tool.status);
  s.emit({ kind: 'tool', toolCallId: tool.toolCallId, title: tool.title || tool.kind || 'Native tool',
    state: tool.status === 'completed' ? 'completed' : tool.status === 'failed' ? 'error' : 'running',
    input: JSON.stringify(tool.rawInput), output: terminal ? extractToolOutput(tool, u) : undefined });
  if (tool.status !== 'completed') return;
  const changes = (tool.content || []).filter(c => c.type === 'diff' && typeof c.path === 'string' && typeof c.newText === 'string' && (c.oldText == null || typeof c.oldText === 'string'))
    .filter(c => c.oldText !== c.newText && (c.oldText?.length || 0) + c.newText.length <= 100000)
    // Observed Cursor fallback corrupts diff headers; don't invent file bodies.
    .filter(c => !(c.oldText?.startsWith('-- /dev/null') && c.newText.startsWith('++ b/')))
    .map(c => ({ path: c.path, before: c.oldText ?? '', after: c.newText, changeType: c.oldText == null ? 'added' : 'modified', complete: true }));
  if (changes.length) s.emit({ kind: 'file-change', source: 'native', changes });
}

// 环境变量调速：避免线上 native turn 卡死时无任何兜底。
// - HARNESS_MIX_TURN_IDLE_TIMEOUT_MS：无用户可见进度事件的最长等待时间
//   （heartbeat/usage-only 事件不计）。默认 15 分钟。
// - HARNESS_MIX_TURN_PROMPT_TIMEOUT_MS：单轮 session/prompt 硬上限。
//   任何事件都不能推迟这个超时。默认 2 小时。
// - HARNESS_MIX_TURN_CANCEL_GRACE_MS：发送 session/cancel 后多久强杀进程。
//   默认 15 秒（原来固定用 timeoutMs=30s，明显偏长）。
// - HARNESS_MIX_TOOL_STUCK_TIMEOUT_MS：单个工具调用 running 状态的最长
//   等待时间，超时只发诊断不杀进程（避免误杀大文件写入）。默认 30 分钟。
// - HARNESS_MIX_TURN_EVENT_DRAIN_MS：原生 ACP 在 session/prompt 响应后
//   仍可能排队写出的最终 session/update 通知的安静窗口。默认 250ms。
// - HARNESS_MIX_TURN_EVENT_DRAIN_MAX_MS：本轮排空的最大等待时间；避免
//   ACP 只返回 prompt 回执、最终文本随后才到时过早结算。默认 10 秒。
const envMs = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
function nativeAcp({ id, name, args, aliases = [], command = argv => nativeCommand(id, argv), timeoutMs = 30000,
  turnIdleTimeoutMs = envMs('HARNESS_MIX_TURN_IDLE_TIMEOUT_MS', 15 * 60 * 1000),
  turnPromptTimeoutMs = envMs('HARNESS_MIX_TURN_PROMPT_TIMEOUT_MS', 2 * 60 * 60 * 1000),
  turnEventDrainMs = envMs('HARNESS_MIX_TURN_EVENT_DRAIN_MS', 250),
  turnEventDrainMaxMs = envMs('HARNESS_MIX_TURN_EVENT_DRAIN_MAX_MS', 10_000),
  cancelGraceMs = envMs('HARNESS_MIX_TURN_CANCEL_GRACE_MS', 15_000),
  toolStuckTimeoutMs = envMs('HARNESS_MIX_TOOL_STUCK_TIMEOUT_MS', 30 * 60 * 1000),
  capabilities = {} }) {
  const kiro = id === 'kiro-cli', buddy = id === 'codebuddy';
  const manifest = { id, name, aliases: [id, ...aliases], icon: `${id}-color.svg`, capabilities: {
    streaming: true, thinking: true, tools: true, approvals: true, questions: true, plan: true, nativeDiff: true,
    models: true, thinkingLevels: id !== 'cursor-cli', permissionModes: !kiro, resume: true,
    fork: kiro, forkFromMessage: false, compaction: kiro, usage: kiro || buddy, contextUsage: kiro || buddy,
    attachments: true, collaborationTools: true, ...capabilities,
  } };
  function create() {
    async function connect(s, restore) {
      s.loading = true;
      const generation = ++s.generation;
      const cli = command(args);
      const proc = new JsonlProcess(cli.command, cli.args, { cwd: s.cwd, env: { ...process.env, ...s.environment } }, {
        onDiagnostic: s.diagnostic,
        onRequest: r => {
          if (generation !== s.generation) throw new Error('Stale native connection');
          s.touchTurn?.({ request: r.method });
          return s.interactions.request(r.method, r.params || {});
        },
        onEvent: e => { if (generation === s.generation) { recordNative(id, e); s.touchTurn?.({ event: e?.params?.update?.sessionUpdate }); project(s, e); } },
        onExit: error => { if (generation === s.generation && !s.closed) { s.fault ||= error; s.interactions.close(); } },
      });
      s.process = proc;
      s.request = (method, params) => {
        if (s.closed || s.fault) return Promise.reject(s.fault || new Error('Native session closed'));
        if (method === 'session/prompt') {
          // 硬上限：即使 agent 持续发 heartbeat/usage_update 也不延后。
          // 超时后置 fault 并强杀进程，让 send() 的 await 抛错触发 turn.failed。
          let promptTimer;
          return Promise.race([proc.request(method, params), new Promise((_, reject) => {
            promptTimer = setTimeout(() => {
              const minutes = Math.ceil(turnPromptTimeoutMs / 60000);
              const e = new Error(`${name}: session/prompt exceeded ${minutes} minute hard ceiling`);
              s.fault = e; s.diagnostic?.(`${name} turn 触发硬超时（${minutes} 分钟）`);
              try { s.process?.stop(); } catch { /* already gone */ }
              reject(e);
            }, turnPromptTimeoutMs);
          })]).finally(() => clearTimeout(promptTimer));
        }
        let timer;
        return Promise.race([proc.request(method, params), new Promise((_, reject) => {
          timer = setTimeout(() => { const e = new Error(`${name}: ${method} timed out`); s.fault = e; reject(e); proc.stop(); }, timeoutMs);
        })]).finally(() => clearTimeout(timer));
      };
      try {
        const init = await s.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'harness-mix', version: '0.1.0' } });
        s.state.agentCapabilities = init.agentCapabilities || {};
        if (restore && !s.nativeSessionId) throw new Error('Cannot resume without a native session ID');
        if (restore && init.agentCapabilities?.loadSession === false) throw new Error('Native CLI does not support session/load');
        const result = await s.request(restore ? 'session/load' : 'session/new', { cwd: s.cwd, mcpServers: s.mcpServers, ...(restore ? { sessionId: s.nativeSessionId } : {}) });
        if (result.sessionId && restore && result.sessionId !== s.nativeSessionId) throw new Error('Native resume returned a different session');
        s.nativeSessionId = result.sessionId || (restore ? s.nativeSessionId : null);
        if (!s.nativeSessionId) throw new Error('Native CLI returned no session identity');
        updateConfig(s, result);
        s.loading = false;
      } catch (error) { proc.stop(); throw error; }
    }
    const adapter = {
      async inspect() {
        try {
          const cli = command(['--version']);
          return await new Promise(resolve => execFile(cli.command, cli.args, { timeout: 10000, windowsHide: true }, (error, out) => resolve({ available: !error, detail: error ? `${name} CLI 启动失败` : String(out).trim() })));
        } catch (error) { return { available: false, detail: error.message }; }
      },
      async describe() { return { models: null, thinkingLevels: [], permissionModes: [] }; },
      async describeFor(s) { return catalog(s); },
      async listModelsFor(s) { return catalog(s).models; },
      async open({ thread, emit, diagnostic = () => {}, collaboration }) {
        const s = { vendor: id, cwd: thread.cwd, nativeSessionId: thread.restore ? thread.nativeSessionId : null,
          generation: 0, loading: true, active: false, closed: false, fault: null, emit, diagnostic,
          environment: thread.environment || {}, tools: new Map(), charges: new Map(), confirmed: {},
          state: { configOptions: [], models: null, modes: null, commands: [], usage: {} },
          mcpServers: collaboration ? [{ name: 'harness-mix', command: collaboration.command, args: collaboration.args,
            env: Object.entries(collaboration.env).map(([name, value]) => ({ name, value })) }] : [],
          collaborationEnabled: !!collaboration,
        };
        s.interactions = new AcpInteractions(s, id);
        try {
          await connect(s, thread.restore);
          if (thread.options?.model) await adapter.setModel(s, thread.options.model);
          if (thread.options?.thinking) await adapter.setThinkingLevel(s, thread.options.thinking);
          if (thread.options?.permissionMode) await adapter.setPermissionMode(s, thread.options.permissionMode);
          emit({ kind: 'session', nativeSessionId: s.nativeSessionId, model: s.model });
          return s;
        } catch (error) { await adapter.close(s); throw error; }
      },
      async send(s, prompt, hooks, attachments) {
        if (s.active || s.configuring || s.closed || s.fault) throw s.fault || new Error('Native session is busy or closed');
        if (attachments?.images?.length && (!manifest.capabilities.attachments || !s.state.agentCapabilities.promptCapabilities?.image)) throw new Error(`${name} native image input is not supported`);
        s.active = true; s.tools.clear(); s.cancelRequested = false; s.turnAnswer = ''; s.turnProgressSeen = false; s.turnTextSeen = false;
        s.turnSettling = false; s.turnDrainWake = null;
        // 哪些事件代表“用户可见的进度”？只让这些重置 idle timer，
        // heartbeat / usage-only / plan 不算进度，否则 model API 挂起后
        // agent 仍能以心跳续命。
        const isProgressEvent = hint => {
          if (!hint) return false;
          if (hint.request) return true;
          return ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(hint.event);
        };
        // 初始一轮总是设置计时器；之后仅“进度”事件会重置，心跳不重置。
        const armIdleTimer = (hint) => {
          if (s.turnIdleTimer && hint && !isProgressEvent(hint)) return;
          clearTimeout(s.turnIdleTimer);
          s.turnIdleTimer = setTimeout(() => {
            if (!s.active || s.closed || s.interactions.pending?.size) return armIdleTimer();
            s.fault = new Error(`${name} native turn produced no progress for ${Math.ceil(turnIdleTimeoutMs / 60000)} minutes`);
            s.diagnostic?.(`${name} idle timeout fired after ${Math.ceil(turnIdleTimeoutMs / 60000)} minutes with no progress`);
            s.process?.stop();
          }, turnIdleTimeoutMs);
        };
        s.touchTurn = armIdleTimer;
        armIdleTimer();
        // 单工具 hung 诊断：仅告警不杀进程（原生写入文件可能本身就很慢）。
        const armToolStuckTimer = () => {
          clearTimeout(s.toolStuckTimer);
          if (toolStuckTimeoutMs <= 0) return;
          s.toolStuckTimer = setTimeout(() => {
            if (!s.active || s.closed) return;
            const stuck = [...s.tools.values()].filter(t => !['completed', 'failed'].includes(t.status));
            if (!stuck.length) return armToolStuckTimer();
            const sample = stuck.map(t => t.title || t.toolCallId).slice(0, 3).join(', ');
            s.diagnostic?.(`${name}: ${stuck.length} native tool call(s) still running after ${Math.ceil(toolStuckTimeoutMs / 60000)} min (${sample}). If the agent is hung, click Stop.`);
            armToolStuckTimer();
          }, toolStuckTimeoutMs);
        };
        armToolStuckTimer();
        s.turn = (async () => {
          try {
            const content = [{ type: 'text', text: prompt }, ...(attachments?.images || []).map(i => ({ type: 'image', data: i.data, mimeType: i.mime }))];
            const result = await s.request('session/prompt', { sessionId: s.nativeSessionId, prompt: content })
              .catch(error => { throw s.fault || error; });
            // ACP notifications are written on a separate JSONL queue. Some
            // native servers return the prompt receipt before the final
            // session/update line (DSH does this around MCP/tool turns). Keep
            // the Host turn active while a quiet window drains, with a bounded
            // maximum so an unhealthy server cannot leave a task running for
            // ever. Progress events reset the quiet window through project().
            if (result.stopReason !== 'cancelled') await waitForTurnDrain(s, {
              quietMs: turnEventDrainMs,
              maxMs: turnEventDrainMaxMs,
            });
            if (s.closed || s.fault) throw s.fault || new Error('Native session closed during turn');
            s.interactions.close();
            if (result.stopReason === 'cancelled' && buddy) {
              const confirmed = { ...s.confirmed };
              ++s.generation; s.process.stop(); s.fault = null;
              await connect(s, true);
              // The same session object survives reconnect; replay is suppressed.
              s.active = false;
              if (confirmed.model) await adapter.setModel(s, confirmed.model);
              if (confirmed.thinking) await adapter.setThinkingLevel(s, confirmed.thinking);
              if (confirmed.mode) await adapter.setPermissionMode(s, confirmed.mode);
              s.active = true;
            }
            if (buddy) {
              try {
                const { readCodeBuddyHistory, historyUsage, latestAssistantAfterUser } = require('./codebuddy-history');
                const rows = await readCodeBuddyHistory(s.cwd, s.nativeSessionId);
                Object.assign(s.state.usage, historyUsage(rows));
                hooks.emit({ kind: 'usage', usage: { ...s.state.usage } });
                const final = latestAssistantAfterUser(rows, result.userMessageId);
                if (final && final !== s.turnAnswer) {
                  const missing = final.startsWith(s.turnAnswer) ? final.slice(s.turnAnswer.length) : final;
                  if (missing) hooks.emit({ kind: 'text-delta', text: missing });
                  s.turnAnswer = final;
                }
              } catch (error) { s.diagnostic(`CodeBuddy history usage unavailable: ${error.message}`); }
            }
            if (buddy && result.stopReason !== 'cancelled' && !s.turnAnswer) throw new Error('CodeBuddy native turn completed without an assistant response');
            if (s.closed || s.fault) throw s.fault || new Error('Native session closed during turn');
            hooks.emit({ kind: 'completed', finalAnswer: result.stopReason !== 'cancelled',
              ...(result.userMessageId ? { nativeRef: { checkpointId: result.userMessageId } } : {}) });
          } finally {
            s.turnSettling = false; s.turnDrainWake = null; delete s.turnProgressSeen; delete s.turnTextSeen;
            clearTimeout(s.cancelTimer); clearTimeout(s.turnIdleTimer); clearTimeout(s.toolStuckTimer); delete s.touchTurn; s.active = false; s.interactions.close();
          }
        })();
        return s.turn;
      },
      async cancel(s) {
        if (!s.active || s.closed) return;
        if (!s.cancelRequested) {
          s.cancelRequested = true;
          s.process.notify('session/cancel', { sessionId: s.nativeSessionId });
          s.interactions.close();
          // 兜底：grace 内不返回就强杀进程、让 pending session/prompt 抛错。
          // 原来的 30s 偏长；用户卡在原生命令上点击取消后体验很差。
          s.cancelTimer = setTimeout(() => {
            if (!s.active || s.closed) return;
            s.fault = new Error('Native cancellation was not acknowledged within ' + Math.ceil(cancelGraceMs / 1000) + 's');
            s.diagnostic?.(`${name}: cancellation grace (${Math.ceil(cancelGraceMs / 1000)}s) expired, force-killing native process`);
            try { s.process?.stop(); } catch { /* already gone */ }
          }, cancelGraceMs);
        }
        await s.turn;
      },
      async respond(s, requestId, response) { return s.interactions.respond(requestId, response); },
      async configure(s, kind, value) {
        if (s.active || s.configuring || s.closed || s.fault) throw s.fault || new Error('Cannot configure a busy native session');
        s.configuring = true;
        try {
          const c = config(s, kind);
          if (c) {
            if (!options(c.options).some(o => o.value === value)) throw new Error(`Native ${kind} option unavailable`);
            const result = await s.request('session/set_config_option', { sessionId: s.nativeSessionId, configId: c.id, value });
            updateConfig(s, result);
            if (config(s, kind)?.currentValue !== value) throw new Error(`Native ${kind} change was not confirmed`);
          } else if (kind === 'model' && catalog(s).models.some(m => m.id === value)) {
            await s.request('session/set_model', { sessionId: s.nativeSessionId, modelId: value });
            s.state.models.currentModelId = value;
          } else if (kind === 'mode' && catalog(s).permissionModes.some(m => m.id === value)) {
            await s.request('session/set_mode', { sessionId: s.nativeSessionId, modeId: value });
            s.state.modes.currentModeId = value;
          } else throw new Error(`Native ${kind} option unavailable`);
        } finally { s.configuring = false; }
      },
      async setModel(s, model) { await adapter.configure(s, 'model', model.id); s.model = catalog(s).models.find(m => m.id === model.id); s.confirmed.model = s.model; delete s.confirmed.thinking; return s.model; },
      async setThinkingLevel(s, level) {
        if (!catalog(s).thinkingLevels.some(o => o.id === level)) throw new Error('Native effort unavailable for this model');
        await adapter.configure(s, 'thinking', level); s.confirmed.thinking = level;
      },
      async setPermissionMode(s, mode) {
        if (kiro) throw new Error('Kiro autopilot is not a Host permission mode');
        await adapter.configure(s, 'mode', mode); s.confirmed.mode = mode;
      },
      async getContextUsage(s) {
        if (kiro && s.state.agentCapabilities?._meta?.kiro?.extensionMethods?.includes('_kiro/session/context')) {
          const result = await s.request('_kiro/session/context', { sessionId: s.nativeSessionId });
          const percent = result.contextUsage?.usagePercentage ?? result.usagePercentage;
          if (finite(percent)) s.state.usage.contextUsagePercent = percent;
        }
        return { ...s.state.usage };
      },
      async listCommands(s) {
        const commands = (s?.state.commands || []).map(c => ({ id: c.name, label: '/' + c.name, description: c.description, action: 'insert' }));
        if (kiro && s?.state.agentCapabilities?._meta?.kiro?.extensionMethods?.includes('_kiro/session/compact')) commands.push({ id: 'compact', label: '/compact', description: 'Kiro 原生上下文压缩', action: 'execute' });
        return commands;
      },
      async executeCommand(s, name, hooks) {
        if (kiro && name === 'compact') {
          if (s.active || !s.state.agentCapabilities?._meta?.kiro?.extensionMethods?.includes('_kiro/session/compact')) throw new Error('Native compact unavailable');
          await s.request('_kiro/session/compact', { sessionId: s.nativeSessionId });
          hooks.emit({ kind: 'completed' });
        } else await adapter.send(s, '/' + name, hooks);
      },
      async fork(source, context) {
        if (!kiro || context.message) throw new Error('Native fork boundary unsupported');
        const checkpoint = await require('./kiro-history').latestKiroCheckpoint(source.cwd, source.nativeSessionId);
        const probe = await adapter.open({ thread: { ...source, restore: true }, emit: () => {}, diagnostic: context.diagnostic });
        try {
          if (!probe.state.agentCapabilities.sessionCapabilities?.fork) throw new Error('Kiro did not advertise session/fork');
          const result = await probe.request('session/fork', { sessionId: source.nativeSessionId, cwd: source.cwd, _meta: { kiro: { messageId: checkpoint } } });
          if (!result.sessionId || result.sessionId === source.nativeSessionId) throw new Error('Kiro fork did not return a new native session');
          return { session: await adapter.open({ thread: { ...source, nativeSessionId: result.sessionId, restore: true }, emit: context.emit, diagnostic: context.diagnostic }) };
        } finally { await adapter.close(probe); }
      },
      async close(s) { if (!s || s.closed) return; s.closed = true; ++s.generation; clearTimeout(s.cancelTimer); clearTimeout(s.turnIdleTimer); clearTimeout(s.toolStuckTimer); delete s.touchTurn; s.interactions.close(); s.process?.stop(); },
    };
    return adapter;
  }
  return { manifest, create };
}
module.exports = { nativeAcp, catalog, project };
