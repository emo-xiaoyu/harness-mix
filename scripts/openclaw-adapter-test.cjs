const assert = require('node:assert/strict');
const { manifest, create, projectAgentEvent, projectApproval, applySessionDescription } = require('../src/main/adapters/openclaw');
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

// 9. Manifest 能力声明（诚实面：reasoning 流/plan/patch/图片未实测不声明；usage 取自原生 token 统计）
{
  assert.equal(manifest.id, 'openclaw');
  assert.deepEqual(manifest.capabilities, { streaming: true, thinking: false, tools: true, approvals: true, questions: false, models: true, thinkingLevels: true, permissionModes: false, resume: true, fork: false, forkFromMessage: false, compaction: false, usage: true, contextUsage: true, attachments: true });
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
