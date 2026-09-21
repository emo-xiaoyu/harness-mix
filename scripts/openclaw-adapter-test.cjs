const assert = require('node:assert/strict');
const { manifest, create, projectAgentEvent, projectApproval, applySessionDescription, planMcpReconcile, toOpenClawServerEntry, MCP_OWNED_PREFIX, THINKING_LEVELS } = require('../src/main/adapters/openclaw');
const hermes = require('../src/main/adapters/hermes');

// OpenClaw Adapter 投影单元测试。帧形状以 Gateway 2026.5.12 实测捕获为准
// （agent 流：{runId, stream, data, sessionKey, seq, ts}；审批广播：{id, request, createdAtMs, expiresAtMs}）。

// 1. assistant 流：delta 优先，缺 delta 时按累计 text 差分
{
  const session = { state: {} };
  const evts = [
    ...projectAgentEvent({ stream: 'assistant', data: { text: 'PONG', delta: 'PONG' } }, session),
    ...projectAgentEvent({ stream: 'assistant', data: { text: 'PONG。完成' } }, session),
  ];
  assert.deepEqual(evts.map((e) => e.text), ['PONG', '。完成'], 'delta 与差分补齐');
  assert.equal(session.state.lastAssistantText, 'PONG。完成', '累计文本跟踪');
}

// 2. tool 流全链路：start(running+input) → update(running+output) → result(done)
{
  const call = { toolCallId: 'call_1', name: 'exec', meta: 'print text' };
  const events = [
    ...projectAgentEvent({ stream: 'tool', data: { ...call, phase: 'start', args: { command: 'echo hi' } } }),
    ...projectAgentEvent({ stream: 'tool', data: { ...call, phase: 'update', partialResult: { content: [{ type: 'text', text: 'hi\r\n' }] } } }),
    ...projectAgentEvent({ stream: 'tool', data: { ...call, phase: 'result', isError: false, result: { content: [{ type: 'text', text: 'hi' }] } } }),
  ];
  assert.equal(events[0].state, 'running');
  assert.ok(events[0].input.includes('echo hi'), '入参投影');
  assert.equal(events[0].title, 'exec print text', '标题含 meta');
  assert.equal(events.at(-1).state, 'done');
  assert.equal(events.at(-1).output, 'hi');
  const failed = projectAgentEvent({ stream: 'tool', data: { ...call, phase: 'result', isError: true, result: { content: [] } } });
  assert.equal(failed[0].state, 'error');
}

// 3. command_output 流：delta 增量挂同一 toolCallId，end 收尾带退出码
{
  const events = [
    ...projectAgentEvent({ stream: 'command_output', data: { phase: 'delta', toolCallId: 'c1', title: 'command print text', output: 'hello' } }),
    ...projectAgentEvent({ stream: 'command_output', data: { phase: 'end', toolCallId: 'c1', title: 'command print text', output: 'hello', status: 'completed', exitCode: 0 } }),
  ];
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].state, 'running');
  assert.equal(events[1].state, 'done');
  assert.equal(events[1].detail, 'exit 0');
}

// 4. lifecycle error 只累积上下文（结算由 agent.wait 驱动），未知流不投影
{
  const session = { state: {} };
  assert.equal(projectAgentEvent({ stream: 'lifecycle', data: { phase: 'start' } }, session).length, 0);
  assert.equal(projectAgentEvent({ stream: 'lifecycle', data: { phase: 'error', error: 'boom' } }, session).length, 0);
  assert.equal(session.state.lastError, 'boom');
  assert.equal(projectAgentEvent({ stream: 'patch', data: {} }, session).length, 0, '未验证的流不伪造');
}

// 4b. thinking 流投影（形状取自上游 emitAgentEvent stream:"thinking" 的 {text,delta}，与 assistant 同构）
{
  const session = { state: {} };
  const evts = [
    ...projectAgentEvent({ stream: 'thinking', data: { text: '先列约束', delta: '先列约束' } }, session),
    ...projectAgentEvent({ stream: 'thinking', data: { text: '先列约束，再枚举' } }, session),
  ];
  assert.deepEqual(evts, [{ kind: 'thinking-delta', text: '先列约束' }, { kind: 'thinking-delta', text: '，再枚举' }], 'delta 优先 + 累计差分');
  assert.equal(session.state.lastThinkingText, '先列约束，再枚举', 'thinking 累计文本独立跟踪');
  assert.equal(projectAgentEvent({ stream: 'thinking', data: { text: '' } }, session).length, 0, '空思考不投影');
}

// 5. 审批投影与应答路由（exec/plugin 分流；deny 为唯一拒绝决定）
(async () => {
{
  const projected = projectApproval('exec.approval.requested', {
    id: 'ap-1',
    request: { command: 'rm -rf build', cwd: 'E:\\harness-mix', sessionKey: 'agent:main:hm-1' },
  }, 'agent:main:hm-1');
  assert.equal(projected.kind, 'approval');
  assert.equal(projected.requestId, 'openclaw-ap-1');
  assert.ok(projected.message.includes('rm -rf build'));
  assert.equal(projected.options.length, 3);

  const calls = [];
  const session = {
    nativeSessionId: 'agent:main:hm-1',
    pendingApprovals: new Map([['openclaw-ap-1', { approvalId: 'ap-1' }], ['openclaw-plugin:x', { approvalId: 'plugin:x' }]]),
    host: { call: async (method, params) => calls.push({ method, params }) },
  };
  const adapter = create();
  await adapter.respond(session, 'openclaw-ap-1', { optionId: 'allowed-once' });
  assert.deepEqual(calls.at(-1), { method: 'exec.approval.resolve', params: { id: 'ap-1', decision: 'allow-once' } });
  await adapter.respond(session, 'openclaw-plugin:x', { optionId: 'rejected' });
  assert.deepEqual(calls.at(-1), { method: 'plugin.approval.resolve', params: { id: 'plugin:x', decision: 'deny' } }, '插件审批按 id 前缀路由');
  session.pendingApprovals.set('openclaw-ap-2', { approvalId: 'ap-2' });
  await adapter.respond(session, 'openclaw-ap-2', { cancelled: true });
  assert.equal(calls.at(-1).params.decision, 'deny', '取消即拒绝，不替用户放行');
  await assert.rejects(adapter.respond(session, 'openclaw-unknown', { optionId: 'allowed-once' }), /未知/);
}

// 6. send 流程：agent 受理 → agent.wait 结算；in_flight 拒绝并发；model/thinking 透传
{
  const emitted = [];
  const calls = [];
  const host = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'agent') return { runId: 'run-1', status: 'accepted', acceptedAt: 1 };
      if (method === 'agent.wait') return { runId: 'run-1', status: 'ok', startedAt: 1, endedAt: 2 };
      throw new Error('unexpected ' + method);
    },
  };
  const session = { host, nativeSessionId: 'agent:main:hm-2', state: {}, modelOverride: 'minimax/MiniMax-M2.7', thinkingOverride: 'low' };
  const adapter = create();
  await adapter.send(session, '你好', { emit: (e) => emitted.push(e) });
  assert.deepEqual(emitted, [{ kind: 'completed', finalAnswer: true }]);  const agentCall = calls.find((c) => c.method === 'agent');
  assert.equal(agentCall.params.sessionKey, 'agent:main:hm-2');
  assert.equal(agentCall.params.model, 'minimax/MiniMax-M2.7');
  assert.equal(agentCall.params.thinking, 'low');
  assert.equal(agentCall.params.deliver, false, '回复不外投到 OpenClaw 渠道');
  assert.ok(agentCall.params.idempotencyKey, '幂等键必传');

  const busy = { ...session, host: { call: async () => ({ status: 'in_flight' }) } };
  await assert.rejects(adapter.send(busy, 'x', { emit: () => {} }), /进行中/);

  // 用户取消（stopReason: rpc 的 timeout 快照）：安静返回，不再重复结算
  const cancelled = [];
  const cancelHost = { call: async (method) => method === 'agent' ? { runId: 'r', status: 'accepted' } : { status: 'timeout', stopReason: 'rpc' } };
  await adapter.send({ ...session, host: cancelHost }, 'x', { emit: (e) => cancelled.push(e) });
  assert.deepEqual(cancelled, [], '取消由 runtime 结算');

  // 原生失败：错误优先取 agent.wait 快照，其次 lifecycle 累计
  const failHost = { call: async (method) => method === 'agent' ? { runId: 'r', status: 'accepted' } : { status: 'error', error: '模型限流' } };
  await assert.rejects(adapter.send({ ...session, host: failHost, state: {} }, 'x', { emit: () => {} }), /模型限流/);
  const lifecycleErr = [];
  const lcHost = { call: async (method) => {
    if (method === 'agent') return { runId: 'r', status: 'accepted' };
    for (const e of projectAgentEvent({ stream: 'lifecycle', data: { phase: 'error', error: { message: '上下文溢出' } } }, lcSession)) lifecycleErr.push(e);
    return { status: 'error' };
  } };
  const lcSession = { ...session, host: lcHost, state: {} };
  await assert.rejects(adapter.send(lcSession, 'x', { emit: () => {} }), /上下文溢出/);
}

// 7. cancel 路由 sessions.abort（带 runId 限定作用域）
{
  const calls = [];
  const session = { host: { call: async (m, p) => calls.push({ m, p }) }, nativeSessionId: 'agent:main:hm-3', state: { runId: 'run-9' } };
  await create().cancel(session);
  assert.deepEqual(calls[0], { m: 'sessions.abort', p: { key: 'agent:main:hm-3', runId: 'run-9' } });
}

// 8. sessions.describe 行投影：生效模型 / 思考目录 / 原生用量（totalTokensFresh 才可信）
{
  const session = { state: {}, models: [{ id: 'minimax/MiniMax-M2.7', name: 'MiniMax M2.7' }] };
  applySessionDescription(session, {
    modelProvider: 'minimax', model: 'MiniMax-M2.7',
    thinkingLevels: [{ id: 'off', label: 'off' }, { id: 'low', label: 'low' }], thinkingDefault: 'off',
    inputTokens: 47, outputTokens: 19, totalTokens: 28656, contextTokens: 200000, estimatedCostUsd: 0,
  });
  assert.equal(session.model.id, 'minimax/MiniMax-M2.7', '模型命中目录条目');
  assert.deepEqual(session.state.thinkingLevels.map((l) => l.id), ['off', 'low']);
  assert.equal(session.state.thinkingDefault, 'off');
  assert.deepEqual(session.state.usage, { tokens: 28656, contextWindow: 200000, contextPercent: 14.33 });
  // 0 成本不冒充 cost；缺字段不产出 usage
  assert.equal(session.state.usage.cost, undefined);
  const empty = { state: {} };
  applySessionDescription(empty, { label: 'x' });
  assert.equal(empty.state.usage, undefined);
}

// 9. Manifest 能力声明（诚实面：thinking 投影已接线但无推理凭据完成端到端实测，能力位保持 false；
//    compaction=true 以原生 /compact 实测为准；usage 取自原生 token 统计）
{
  assert.equal(manifest.id, 'openclaw');
  assert.deepEqual(manifest.capabilities, { streaming: true, thinking: false, tools: true, approvals: true, questions: false, models: true, thinkingLevels: true, permissionModes: false, resume: true, fork: false, forkFromMessage: false, compaction: true, usage: true, contextUsage: true, attachments: true });
  assert.equal(manifest.integrations.mcp, true, '托管 MCP 走 mcp.servers 注册表对账');
}

// 9a. 静态思考档位兜底 = Gateway 2026.5.12 实测目录（sessions.create 后首 turn 前 describe 即返回，
//     见 output/openclaw-thinking-probe/*.json：thinkingLevels 5 档、thinkingDefault "off"）
{
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high'], '兜底目录对齐实测 5 档，不夸大');
  const withDefault = { state: { thinkingLevels: [{ id: 'off' }, { id: 'high' }], thinkingDefault: 'off' }, models: null };
  const described = await create().describeFor(withDefault);
  assert.deepEqual(described.thinkingLevels, [{ id: 'off', default: true }, { id: 'high', default: false }], '原生 thinkingDefault 标记预选');
  const fallback = await create().describeFor({ state: {}, models: null });
  assert.deepEqual(fallback.thinkingLevels, THINKING_LEVELS.map((id) => ({ id, label: id })), 'describe 缺席时回落静态兜底');
  assert.deepEqual(fallback.permissionModes, [], 'OpenClaw 无原生权限模式，不虚构');
}

// 9b. 托管 MCP 对账：只动 harness-mix/* 自有键，用户键原样保留；条目形状对齐 openclaw mcp set
{
  assert.deepEqual(toOpenClawServerEntry({ command: 'node', args: ['server.js'], env: { A: '1' } }), { command: 'node', args: ['server.js'], env: { A: '1' } });
  assert.deepEqual(toOpenClawServerEntry({ url: 'https://mcp.example/sse', http_headers: { Authorization: 'Bearer x' } }), { url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(toOpenClawServerEntry({ command: 'uvx' }), { command: 'uvx' }, '空 args/env 不携带');

  const current = {
    'user-own': { command: 'uvx', args: ['context7-mcp'] },
    [`${MCP_OWNED_PREFIX}old`]: { url: 'https://old/sse' },
    [`${MCP_OWNED_PREFIX}keep`]: { command: 'node', args: ['k.js'] },
  };
  const managed = [
    { name: 'keep', command: 'node', args: ['k.js'] },
    { name: 'new', url: 'https://new/sse' },
  ];
  const plan = planMcpReconcile(current, managed);
  assert.deepEqual(plan.kept, { 'user-own': { command: 'uvx', args: ['context7-mcp'] } }, '用户键不动');
  assert.deepEqual(plan.unsets, [`${MCP_OWNED_PREFIX}old`], '托管集合里消失的自有键被移除');
  assert.deepEqual(plan.sets, [[`${MCP_OWNED_PREFIX}new`, { url: 'https://new/sse' }]], '新增进集合；未变化的键不重写');

  const update = planMcpReconcile({ [`${MCP_OWNED_PREFIX}keep`]: { command: 'node', args: ['old.js'] } }, [{ name: 'keep', command: 'node', args: ['k.js'] }]);
  assert.deepEqual(update.sets, [[`${MCP_OWNED_PREFIX}keep`, { command: 'node', args: ['k.js'] }]], '内容漂移的自有键被更新');

  const empty = planMcpReconcile(undefined, []);
  assert.deepEqual(empty, { kept: {}, sets: [], unsets: [] }, '空状态零操作');
}

// 9c. 原生斜杠命令目录与执行：commands.list {scope:'text'}（行形状按 Gateway 2026.5.12 实测）
// → UI 命令：compact 专用条目去重、无文本别名条目诚实跳过、参数提示与来源标注
{
  const payload = { commands: [
    { name: 'help', nativeName: 'help', textAliases: ['/help'], description: 'Show available commands.', category: 'core', source: 'native', scope: 'both', acceptsArgs: false, args: [] },
    { name: 'compact', nativeName: 'compact', textAliases: ['/compact'], description: 'Compact the session context.', category: 'core', source: 'native', scope: 'text', acceptsArgs: true, args: [{ name: 'instructions', type: 'string', required: false }] },
    { name: 'skill:Code Review', nativeName: 'code-review', textAliases: ['/code-review'], description: 'Review recent changes.', source: 'skill', scope: 'text', acceptsArgs: true, args: [{ name: 'focus', type: 'string', required: true }] },
    { name: 'Summarize Links', nativeName: 'summarize-links', textAliases: ['/summarize-links'], description: 'Summarize a page.', source: 'plugin', scope: 'text', args: [{ name: 'url', required: false }] },
    { name: 'no-alias', nativeName: 'no-alias', textAliases: [], description: '不可经文本面执行', source: 'native', scope: 'text' },
    { name: '无别名', nativeName: 'cn', description: 'textAliases 缺席', source: 'native' },
    { name: 'DUPE', nativeName: 'dupe', textAliases: ['/dupe'], source: 'native' },
    { name: 'dupe', nativeName: 'dupe-2', textAliases: ['/dupe-2'], source: 'native' },
  ] };
  const calls = [];
  const session = { host: { call: async (method, params) => { calls.push({ method, params }); return payload; } }, state: {} };
  const commands = await create().listCommands(session);
  assert.deepEqual(calls, [{ method: 'commands.list', params: { scope: 'text' } }]);
  assert.equal(commands[0].id, 'compact');
  assert.equal(commands[0].action, 'execute');
  assert.equal(commands.filter((c) => c.id === 'compact').length, 1, '原生 compact 与映射目录去重');
  const help = commands.find((c) => c.id === 'help');
  assert.deepEqual([help.label, help.text, help.action], ['/help', '/help ', 'insert']);
  assert.ok(help.description.includes('原生'), '来源标注：原生');
  const review = commands.find((c) => c.id === 'skill:code-review');
  assert.ok(review, 'name slug 化（skill:Code Review → skill:code-review）');
  assert.ok(review.description.includes('<focus>'), '必选参数以 <name> 提示');
  assert.ok(review.description.includes('技能'), '来源标注：技能');
  const summarize = commands.find((c) => c.id === 'summarize-links');
  assert.ok(summarize.description.includes('[url]'), '可选参数以 [name] 提示');
  assert.ok(summarize.description.includes('插件'), '来源标注：插件');
  assert.ok(!commands.some((c) => c.id === 'no-alias' || c.id === 'cn'), '无文本别名条目跳过');
  assert.equal(commands.filter((c) => c.id === 'dupe').length, 1, 'slug 撞名去重');
  assert.ok(commands.every((c) => /^[A-Za-z0-9._:-]+$/.test(c.id)), 'id 满足 UI 契约字符集');
  assert.ok(commands.every((c) => c.label && c.label.length <= 128 && c.description.length <= 512), 'label/description 长度满足 UI 契约');
  assert.equal(session.state.commands, commands, '目录缓存进会话状态');

  // 目录 RPC 失败：仅保留可执行的压缩指令
  const failing = { host: { call: async () => { throw new Error('rpc down'); } }, state: {} };
  assert.deepEqual((await create().listCommands(failing)).map((c) => c.id), ['compact']);

  // executeCommand：未知指令拒绝；compact 经 send 以消息文本走 agent 管道
  const emitted = [];
  const agentCalls = [];
  const compactSession = {
    host: { call: async (method, params) => {
      agentCalls.push({ method, params });
      if (method === 'agent') return { runId: 'run-c', status: 'accepted' };
      if (method === 'agent.wait') return { runId: 'run-c', status: 'ok' };
      if (method === 'sessions.describe') return null;
      throw new Error('unexpected ' + method);
    } },
    nativeSessionId: 'agent:main:hm-c', state: {},
  };
  const adapter = create();
  await assert.rejects(adapter.executeCommand(compactSession, 'nope', { emit: () => {} }), /未知/);
  await adapter.executeCommand(compactSession, 'compact', { emit: (e) => emitted.push(e) });
  assert.deepEqual(agentCalls.map((c) => c.method), ['agent', 'agent.wait', 'sessions.describe'], 'send 全链路只触这三个 RPC');
  assert.equal(agentCalls[0].params.message, '/compact', 'compact 以消息文本走 agent 运行管道');
  assert.equal(agentCalls[0].params.sessionKey, 'agent:main:hm-c');
  const compaction = emitted.find((e) => e.kind === 'compaction');
  assert.equal(compaction.outcome, 'succeeded');
  assert.ok(/OpenClaw 压缩/.test(compaction.summary));
  assert.equal(compaction.tokensBefore, undefined, '压缩流形状未实测，不伪造 token 前后值');
}

// 10. Hermes 经 ACP 家族工厂接入，未文档化能力不声明
{
  assert.equal(hermes.manifest.id, 'hermes');
  assert.equal(hermes.manifest.capabilities.streaming, true);
  assert.equal(hermes.manifest.capabilities.fork, true, '文档支持 fork');
  assert.equal(hermes.manifest.capabilities.resume, true, '文档支持 resume');
  assert.equal(hermes.manifest.capabilities.usage, false);
  assert.equal(hermes.manifest.capabilities.compaction, false);
  assert.equal(hermes.manifest.capabilities.attachments, true);
  assert.equal(hermes.manifest.capabilities.questions, false);
  const adapter = hermes.create();
  for (const method of ['inspect', 'open', 'send', 'cancel', 'close', 'respond', 'fork', 'listModelsFor', 'setModel']) {
    assert.equal(typeof adapter[method], 'function', `hermes 缺 ${method}()`);
  }
}

console.log('openclaw-adapter: Gateway 帧投影/审批路由/发送结算/取消/Hermes 能力声明 passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
