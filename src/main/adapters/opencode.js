const { execFile } = require('node:child_process');
const { OpenCodeServer, executable } = require('./opencode-server');
const manifest = { id: 'opencode', name: 'OpenCode', icon: 'opencode-color.svg', aliases: ['opencode'], capabilities: {
  collaborationTools: true, streaming: true, thinking: true, tools: true, approvals: true, questions: true, models: true, thinkingLevels: true,
  permissionModes: true, resume: true, fork: true, forkFromMessage: true, compaction: true, usage: true, contextUsage: false, attachments: true,
} };
const enc = encodeURIComponent;
const route = (s, suffix = '') => `/session/${enc(s.nativeSessionId)}${suffix}`;
function projectPart(session, part, emit) {
  const state = session.state;
  if (state.userMessages.has(part.messageID)) return;
  if (part.type === 'text' || part.type === 'reasoning') {
    const previous = state.text.get(part.id) || '', text = part.text || '';
    if (text.startsWith(previous) && text.length > previous.length) emit({ kind: part.type === 'text' ? 'text-delta' : 'thinking-delta', text: text.slice(previous.length), nativeRef: { itemId: part.id } });
    state.text.set(part.id, text);
  } else if (part.type === 'tool') {
    const tool = part.state;
    emit({ kind: 'tool', toolCallId: part.callID, title: tool.title || part.tool, input: tool.input, output: tool.output || tool.error,
      state: tool.status === 'completed' ? 'completed' : tool.status === 'error' ? 'error' : 'running', nativeRef: { itemId: part.id, toolCallId: part.callID } });
  }
}
function askNext(session, id) {
  const pending = session.state.questions.get(id), q = pending.questions[pending.index];
  session.emit({ kind: 'approval', method: q.multiple || !q.options?.length ? 'input' : 'select', requestId: `${id}:${pending.index}`, title: q.header, message: q.question + (q.multiple ? '\n可多选，请以 JSON 数组填写选项名称。' : ''),
    options: q.multiple ? undefined : q.options?.map(o => ({ id: o.label, label: o.label, description: o.description })) });
}
function projectEvent(session, event, emit) {
  const p = event.properties || {};
  if ((p.sessionID || p.part?.sessionID || p.info?.sessionID) !== session.nativeSessionId) return;
  const state = session.state;
  if (event.type === 'message.updated' && p.info?.role === 'user') state.userMessages.add(p.info.id);
  if (!state.active) return;
  if (event.type === 'message.part.updated') { state.parts.set(p.part.id, p.part); projectPart(session, p.part, emit); }
  if (event.type === 'message.part.delta') {
    const part = state.parts.get(p.partID);
    if (part && p.field === 'text') { part.text = (part.text || '') + p.delta; projectPart(session, part, emit); }
  }
  if (event.type === 'session.diff') emit({ kind: 'file-change', source: 'native', changes: p.diff.filter(d => d.file && d.patch).map(d => ({ path: d.file, patch: d.patch, changeType: d.status || 'modified', complete: true })) });
  if (event.type === 'permission.asked') {
    state.permissions.set(p.id, p);
    emit({ kind: 'approval', requestId: p.id, method: 'select', title: p.permission, message: (p.patterns || []).join('\n'),
      options: [{ id: 'once', label: '允许一次' }, { id: 'always', label: '始终允许' }, { id: 'reject', label: '拒绝' }] });
  }
  if (event.type === 'question.asked') { state.questions.set(p.id, { ...p, index: 0, answers: [] }); askNext(session, p.id); }
}
function describeSession(s) {
  const model = s.state.models.find(m => m.id === s.model?.id && m.provider === s.model?.provider);
  return { models: s.state.models, thinkingLevels: (model?.efforts || []).map(id => ({ id, label: id })), permissionModes: s.state.agents.map(a => ({ id: a.name, label: a.name, description: a.description, default: a.name === s.state.agent })) };
}
function create() {
  const adapter = {
    async inspect() {
      const cli = executable(['--version']);
      return new Promise(resolve => execFile(cli.command, cli.args, { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve({ available: !error, detail: error ? 'OpenCode Server CLI unavailable' : `OpenCode ${stdout.trim()} · native HTTP/SSE` })));
    },
    async describe() { return { models: null, thinkingLevels: [], permissionModes: [] }; },
    async open({ thread, emit, collaboration }) {
      // L2 注入：OPENCODE_CONFIG_CONTENT 是最高优先级的运行时内联配置，合并而非覆盖用户配置，会话结束即失效，不污染任何配置文件
      const overlay = collaboration ? { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { servers: { 'harness-mix': { type: 'local', command: [collaboration.command, ...collaboration.args], environment: collaboration.env } } } }) } } : undefined;
      const host = await new OpenCodeServer(thread.cwd, overlay).start();
      try {
        // Read the model catalog, never provider credentials or auth files.
        const [catalog, agents] = await Promise.all([host.request('GET', '/api/model'), host.request('GET', '/agent')]);
        const models = catalog.data.filter(m => m.enabled).map(m => ({ id: m.id, provider: m.providerID, name: m.name, contextWindow: m.limit.context, images: m.capabilities.input.includes('image'), efforts: m.variants.map(v => v.id) }));
        const info = thread.restore ? await host.request('GET', `/session/${enc(thread.nativeSessionId)}`) : await host.request('POST', '/session', { title: thread.title });
        const session = { host, emit, nativeSessionId: info.id, cwd: thread.cwd, collaborationEnabled: !!collaboration, model: info.model ? { id: info.model.id, provider: info.model.providerID } : undefined,
          state: { active: false, agent: info.agent, models, agents: agents.filter(a => !a.hidden && a.mode !== 'subagent'), text: new Map(), parts: new Map(), userMessages: new Set(), permissions: new Map(), questions: new Map() } };
        await host.subscribe(e => projectEvent(session, e, emit), error => { if (session.state.active) { void adapter.cancel(session).catch(() => {}); emit({ kind: 'error', message: error.message }); } });
        if (thread.options?.model) await adapter.setModel(session, thread.options.model);
        if (thread.options?.thinking) await adapter.setThinkingLevel(session, thread.options.thinking);
        if (thread.options?.permissionMode) await adapter.setPermissionMode(session, thread.options.permissionMode);
        emit({ kind: 'session', nativeSessionId: info.id, model: session.model });
        return session;
      } catch (error) { await host.close(); throw error; }
    },
    async describeFor(session) { return describeSession(session); },
    async listModelsFor(session) { return session.state.models; },
    async setModel(session, model) {
      const selected = session.state.models.find(m => m.id === model.id && m.provider === model.provider);
      if (!selected) throw new Error('OpenCode model unavailable');
      await session.host.request('POST', `/api/session/${enc(session.nativeSessionId)}/model`, { model: { id: model.id, providerID: model.provider } });
      session.model = selected; session.state.effort = undefined; return selected;
    },
    async setThinkingLevel(session, level) {
      if (!describeSession(session).thinkingLevels.some(l => l.id === level)) throw new Error('OpenCode model variant unavailable');
      await session.host.request('POST', `/api/session/${enc(session.nativeSessionId)}/model`, { model: { id: session.model.id, providerID: session.model.provider, variant: level } });
      session.state.effort = level;
    },
    async setPermissionMode(session, agent) {
      if (!session.state.agents.some(a => a.name === agent)) throw new Error('OpenCode agent mode unavailable');
      await session.host.request('POST', `/api/session/${enc(session.nativeSessionId)}/agent`, { agent }); session.state.agent = agent;
    },
    async send(session, text, hooks, attachments) {
      if (session.state.active) throw new Error('OpenCode turn already active');
      const parts = [...(text ? [{ type: 'text', text }] : []), ...(attachments?.images || []).map(i => ({ type: 'file', mime: i.mime, filename: i.name, url: `data:${i.mime};base64,${i.data}` }))];
      const commands = text.startsWith('/') ? await adapter.listCommands(session) : [];
      const matched = commands.slice().sort((a, b) => b.nativeName.length - a.nativeName.length).find(c => text === '/' + c.nativeName || text.startsWith('/' + c.nativeName + ' '));
      const command = matched ? [text, matched.nativeName, text.slice(matched.nativeName.length + 1).trimStart()] : null;
      let body = { parts }, suffix = '/message';
      if (command) {
        if (command[1] === 'compact') return adapter.executeCommand(session, 'compact', hooks);
        if (matched) { suffix = '/command'; body = { command: command[1], arguments: command[2] || '', parts: parts.filter(p => p.type === 'file') }; }
      }
      session.state.active = true; session.state.text.clear(); session.state.parts.clear();
      try {
        const result = await session.host.request('POST', route(session, suffix), body, 30 * 60 * 1000);
        if (result.info?.error) throw new Error(result.info.error.data?.message || result.info.error.name || 'OpenCode turn failed');
        for (const part of result.parts || []) projectPart(session, part, hooks.emit);
        hooks.emit({ kind: 'usage', usage: await adapter.getContextUsage(session) });
        hooks.emit({ kind: 'completed', finalAnswer: true, nativeRef: { checkpointId: result.info?.id } });
      } finally { session.state.active = false; }
    },
    async cancel(session) { await session.host.request('POST', route(session, '/abort')); },
    async respond(session, requestId, response) {
      if (session.state.permissions.has(requestId)) {
        const value = response.optionId ?? response.value;
        const choice = ({ '允许一次': 'once', '始终允许': 'always', '拒绝': 'reject' })[value] || value;
        const reply = response.cancelled ? 'reject' : choice;
        if (!['once', 'always', 'reject'].includes(reply)) throw new Error('Invalid OpenCode permission response');
        await session.host.request('POST', `/permission/${enc(requestId)}/reply`, { reply }); session.state.permissions.delete(requestId); return;
      }
      const split = requestId.lastIndexOf(':'), id = requestId.slice(0, split), pending = session.state.questions.get(id);
      if (!pending || String(pending.index) !== requestId.slice(split + 1)) throw new Error('Unknown OpenCode question');
      if (response.cancelled) { await session.host.request('POST', `/question/${enc(id)}/reject`); session.state.questions.delete(id); return; }
      const q = pending.questions[pending.index];
      const answers = q.multiple ? JSON.parse(response.value) : [response.optionId ?? response.value];
      if (!Array.isArray(answers) || !answers.length || answers.some(a => typeof a !== 'string')) throw new Error('Invalid OpenCode answers');
      if (pending.index + 1 < pending.questions.length) { pending.answers.push(answers); pending.index++; askNext(session, id); }
      else { await session.host.request('POST', `/question/${enc(id)}/reply`, { answers: [...pending.answers, answers] }); session.state.questions.delete(id); }
    },
    async listCommands(session) {
      const commands = session ? await session.host.request('GET', '/command') : [];
      return [{ id: 'compact', nativeName: 'compact', label: '压缩上下文', action: 'execute' }, ...commands.filter(c => c.name !== 'compact').map(c => ({ id: 'native-' + Buffer.from(c.name).toString('hex'), nativeName: c.name, label: '/' + c.name, description: c.description, action: 'insert', text: '/' + c.name + ' ' }))];
    },
    async executeCommand(session, id, hooks) {
      if (id !== 'compact') throw new Error('Unknown OpenCode command');
      const info = await session.host.request('GET', route(session)), model = session.model || (info.model && { id: info.model.id, provider: info.model.providerID });
      if (!model) throw new Error('Select an OpenCode model before compacting');
      if (session.state.active) throw new Error('OpenCode turn already active');
      session.state.active = true;
      try { await session.host.request('POST', route(session, '/summarize'), { providerID: model.provider, modelID: model.id }, 30 * 60 * 1000); hooks.emit({ kind: 'completed', finalAnswer: false }); }
      finally { session.state.active = false; }
    },
    async getContextUsage(session) {
      const info = await session.host.request('GET', route(session)), t = info.tokens || {};
      return { inputTokens: t.input, outputTokens: t.output, reasoningOutputTokens: t.reasoning, cacheRead: t.cache?.read, cacheWrite: t.cache?.write, cost: info.cost };
    },
    async fork(source, context) {
      const host = await new OpenCodeServer(source.cwd).start();
      try {
        const history = await host.request('GET', `/session/${enc(source.nativeSessionId)}/message`), boundary = context.message?.coreTurn?.nativeTurnRef?.checkpointId;
        if (context.message && !boundary) throw new Error('OpenCode reply has no native message boundary');
        const index = boundary ? history.findIndex(m => m.info.id === boundary) : -1;
        if (boundary && index < 0) throw new Error('OpenCode fork boundary no longer exists');
        const next = boundary && history[index + 1]?.info.id;
        const info = await host.request('POST', `/session/${enc(source.nativeSessionId)}/fork`, next ? { messageID: next } : {});
        const copied = await host.request('GET', `/session/${enc(info.id)}/message`);
        const checkpointMap = Object.fromEntries(copied.map((m, i) => [history[i].info.id, m.info.id]));
        return { checkpointMap, session: await adapter.open({ thread: { ...source, nativeSessionId: info.id, restore: true }, emit: context.emit }) };
      } finally { await host.close(); }
    },
    async close(session) { if (session.state.active) await adapter.cancel(session).catch(() => {}); await session.host.close(); },
  };
  return adapter;
}
module.exports = { manifest, create, projectEvent, projectPart, describeSession };
