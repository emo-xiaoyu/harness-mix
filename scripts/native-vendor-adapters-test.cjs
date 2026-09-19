const assert = require('node:assert/strict');
const oc = require('../src/main/adapters/opencode');
const grok = require('../src/main/adapters/grok');
const pi = require('../src/main/adapters/pi');
(async () => {
  const events = [], calls = [];
  const session = { nativeSessionId: 's', emit: e => events.push(e), state: { active: true, userMessages: new Set(), parts: new Map(), text: new Map(), permissions: new Map(), questions: new Map() } };
  const event = (type, properties) => oc.projectEvent(session, { type, properties: { sessionID: 's', ...properties } }, session.emit);
  event('message.updated', { info: { role: 'user', id: 'u' } });
  event('message.part.updated', { part: { id: 'up', messageID: 'u', type: 'text', text: 'do not echo' } });
  event('message.part.updated', { part: { id: 'p', messageID: 'a', type: 'text', text: 'A' } });
  event('message.part.delta', { partID: 'p', field: 'text', delta: 'B' });
  oc.projectPart(session, { id: 'p', messageID: 'a', type: 'text', text: 'AB' }, session.emit);
  assert.equal(events.filter(e => e.kind === 'text-delta').map(e => e.text).join(''), 'AB');
  event('question.asked', { id: 'q', questions: [{ question: 'Choose', options: [{ label: 'yes' }] }] });
  assert.equal(events.at(-1).kind, 'approval');
  let fail = true;
  session.host = { request: async (...args) => { if (fail) throw new Error('network'); calls.push(args); } };
  const adapter = oc.create();
  await assert.rejects(adapter.respond(session, 'q:0', { value: 'yes' }));
  assert.equal(session.state.questions.get('q').index, 0);
  fail = false;
  await adapter.respond(session, 'q:0', { value: 'yes' });
  assert.deepEqual(calls.at(-1)[2], { answers: [['yes']] });
  event('permission.asked', { id: 'perm', permission: 'shell', patterns: ['test'] });
  await assert.rejects(adapter.respond(session, 'perm', { value: 'invented' }));
  await adapter.respond(session, 'perm', { optionId: 'always' });
  assert.deepEqual(calls.at(-1)[2], { reply: 'always' });
  assert.deepEqual(grok.projectUsage({ input_tokens: 12, outputTokens: 3, signature: 'private', costUsdTicks: 5 }), { inputTokens: 12, outputTokens: 3 });
  const piFailure = pi.project({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'native quota exhausted' }] });
  assert.equal(piFailure.kind, 'error'); assert.match(piFailure.message, /quota exhausted/);
  let answer;
  const gs = { pendingApprovals: new Map([['r', { options: [{ optionId: 'native-always', kind: 'allow_always' }], resolve: v => { answer = v; } }]]) };
  await assert.rejects(grok.create().respond(gs, 'r', { optionId: 'fake' }));
  await grok.create().respond(gs, 'r', { optionId: 'native-always' });
  assert.equal(grok.manifest.capabilities.attachments, true);
  const grokCalls = [];
  const grokSession = { nativeSessionId: 'grok-1', state: { agentCapabilities: {} }, process: { request: async (method, params) => { grokCalls.push({ method, params }); return { stopReason: 'end_turn', _meta: { promptId: 'p1' } }; } } };
  await grok.create().send(grokSession, 'hi', { emit: () => {} }, { images: [{ data: 'AA==', mime: 'image/png' }] });
  assert.equal(grokCalls[0].method, 'session/prompt');
  assert.deepEqual(grokCalls[0].params.prompt, [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }]);

  // Grok auto-compaction update parsing
  const updateStarted = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_started', tokens_used: 400000, context_window: 500000 });
  assert.deepEqual(updateStarted, { type: 'started', tokensUsed: 400000, contextWindowTokens: 500000 });
  const updateCompleted = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_completed', tokens_before: 400000, tokens_after: 12000, context_window: 500000 });
  assert.deepEqual(updateCompleted, { type: 'completed', outcome: 'succeeded', tokensBefore: 400000, tokensAfter: 12000, contextWindowTokens: 500000 });
  const updateFailed = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_failed', error_message: 'compaction error' });
  assert.deepEqual(updateFailed, { type: 'completed', outcome: 'failed', errorMessage: 'compaction error' });
  const updateCancelled = grok.parseGrokCompactionUpdate({ sessionUpdate: 'auto_compact_cancelled' });
  assert.deepEqual(updateCancelled, { type: 'completed', outcome: 'cancelled' });

  // Grok commands & manual compact
  const grokAdapterInst = grok.create();
  const grokCmds = await grokAdapterInst.listCommands(grokSession);
  assert.ok(grokCmds.some(c => c.id === 'compact' && c.action === 'execute'));

  // Test /compact interception in send()
  const grokCompactEmits = [];
  grokCalls.length = 0;
  grokSession.process.request = async (method, params) => {
    grokCalls.push({ method, params });
    return { outcome: 'succeeded', tokensBefore: 50000, tokensAfter: 5000 };
  };
  await grokAdapterInst.send(grokSession, '/compact keep recent tests', { emit: e => grokCompactEmits.push(e) });
  assert.equal(grokCalls[0].method, 'x.ai/compact_conversation');
  assert.deepEqual(grokCalls[0].params, { sessionId: 'grok-1', userContext: 'keep recent tests' });
  assert.ok(grokCompactEmits.some(e => e.kind === 'compaction' && e.state === 'completed' && e.outcome === 'succeeded'));
  assert.ok(grokCompactEmits.some(e => e.kind === 'usage' && e.usage.tokens === 5000));

  // Test EventNormalizer compaction mapping
  const { EventNormalizer } = require('../src/main/harness-adapter/event-normalizer');
  const normalizer = new EventNormalizer({ threadId: 't-comp' });
  normalizer.beginTurn('turn-c', 'test compact');
  const normEvents = normalizer.normalize({ kind: 'compaction', tokensBefore: 50000, tokensAfter: 5000 });
  assert.equal(normEvents.length, 2);
  assert.equal(normEvents[0].type, 'item.started');
  assert.equal(normEvents[0].payload.type, 'context_compaction');
  assert.equal(normEvents[0].payload.tokensBefore, 50000);
  assert.equal(normEvents[1].type, 'item.completed');

  // Test projectItem mapping
  const { projectItem } = require('../src/main/native/protocol');
  const projected = projectItem({ id: 'norm-item-1', type: 'context_compaction' });
  assert.deepEqual(projected, { id: 'norm-item-1', type: 'contextCompaction' });

  // Pi 自动重试（stream 错误如 "Anthropic stream ended without a stop reason"）：
  // message_end 的 error 不得提前定论为 Turn 失败——agent_end 携带 willRetry，
  // 重试成功的回答必须完整落地，全程零 error 事件（否则 Host 提前结算，
  // 重试结果被丢弃，用户重发还会撞上原生 "Agent is already processing"）。
  {
    const emitted = [];
    const fakeProc = { harnessMixAnswer: '', command: async () => ({ leafId: 'leaf-1' }) };
    const fwd = (event) => pi.forwardEvent(fakeProc, event, e => emitted.push(e));
    const failedMsg = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Anthropic stream ended without a stop reason' };
    fwd({ type: 'message_end', message: failedMsg });
    assert.equal(emitted.filter(e => e.kind === 'error').length, 0, 'message_end 不得提前报错');
    fwd({ type: 'agent_end', willRetry: true, messages: [{ role: 'user', content: [{ type: 'text', text: '登录好了' }] }, failedMsg] });
    assert.equal(emitted.at(-1).kind, 'status');
    fwd({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: failedMsg.errorMessage });
    assert.equal(emitted.at(-1).kind, 'status');
    fwd({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好的，' } });
    fwd({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '开始执行。' } });
    fwd({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '好的，开始执行。' }], stopReason: 'stop' } });
    assert.equal(emitted.filter(e => e.kind === 'text-delta').map(e => e.text).join(''), '好的，开始执行。', '已流式回答不得重复补发');
    fwd({ type: 'auto_retry_end', success: true, attempt: 1 });
    fwd({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: [{ type: 'text', text: '好的，开始执行。' }], stopReason: 'stop' }] });
    fwd({ type: 'agent_settled', sessionId: 's-retry' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(emitted.at(-1).kind, 'completed');
    assert.equal(emitted.at(-1).nativeRef.checkpointId, 'leaf-1');
    assert.equal(emitted.filter(e => e.kind === 'error').length, 0, '重试成功全程不得出现 error');
  }
  // Pi 重试耗尽/不可重试：error 在 agent_end（willRetry:false）处恰好结算一次
  {
    const emitted = [];
    const fwd = (event) => pi.forwardEvent({ harnessMixAnswer: '', command: async () => ({}) }, event, e => emitted.push(e));
    const failedMsg = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'native quota exhausted' };
    fwd({ type: 'message_end', message: failedMsg });
    assert.equal(emitted.filter(e => e.kind === 'error').length, 0);
    fwd({ type: 'agent_end', willRetry: false, messages: [failedMsg] });
    assert.equal(emitted.filter(e => e.kind === 'error').length, 1);
    assert.match(emitted.find(e => e.kind === 'error').message, /quota exhausted/);
  }
  // Pi 未流式回答的 message_end 回退补发仍然有效
  {
    const emitted = [];
    pi.forwardEvent({ harnessMixAnswer: '', command: async () => ({}) },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '非流式回答' }], stopReason: 'stop' } },
      e => emitted.push(e));
    assert.ok(emitted.some(e => e.kind === 'text-delta' && e.text === '非流式回答'));
  }
  // Pi send()：原生拒绝 "already processing"（Host 与原生状态偶发分叉，如取消竞态）时
  // 按原生协议提示以 followUp 排队重发；其他错误原样抛出
  {
    const calls = [];
    let rejectOnce = true;
    const busySession = { process: { harnessMixAnswer: '', command: async (payload) => {
      calls.push(payload);
      if (rejectOnce && payload.type === 'prompt') { rejectOnce = false; throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."); }
      return {};
    } } };
    await pi.create().send(busySession, '登录好了', { emit: () => {} }, { images: [{ data: 'AA==', mime: 'image/png' }] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].streamingBehavior, undefined);
    assert.equal(calls[1].streamingBehavior, 'followUp');
    assert.equal(calls[1].message, '登录好了');
    assert.deepEqual(calls[1].images, [{ type: 'image', data: 'AA==', mimeType: 'image/png' }]);
    const failingSession = { process: { harnessMixAnswer: '', command: async () => { throw new Error('Authentication failed'); } } };
    await assert.rejects(pi.create().send(failingSession, 'hi', { emit: () => {} }, {}), /Authentication failed/);
  }

  // qoder 解析不得回退到 PATH 上的裸 `qoder`（IDE 启动器）：它能通过 --version 可用性
  // 探测，却把每次 --acp 会话打开变成完整 GUI 启动且永远完不成 ACP 握手。
  // 只有无头 qodercli 或显式 HARNESS_MIX_QODER_EXECUTABLE 覆盖是合法入口。
  {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { nativeCommand } = require('../src/main/adapters/native-acp-command');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-qoder-path-'));
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'qoder.cmd' : 'qoder'), '');
    const originalPath = process.env.PATH;
    const originalOverride = process.env.HARNESS_MIX_QODER_EXECUTABLE;
    delete process.env.HARNESS_MIX_QODER_EXECUTABLE;
    const pathWithoutQodercli = originalPath.split(path.delimiter).filter(Boolean).filter(entry => {
      try { return !fs.existsSync(path.join(entry, process.platform === 'win32' ? 'qodercli.cmd' : 'qodercli')); } catch { return true; }
    }).join(path.delimiter);
    try {
      process.env.PATH = `${dir}${path.delimiter}${pathWithoutQodercli}`;
      assert.throws(() => nativeCommand('qoder', ['--acp']), /qodercli 未安装/, '裸 qoder（IDE 启动器）不得作为 ACP 回退');
      const override = path.join(dir, 'custom-acp.exe');
      fs.writeFileSync(override, '');
      process.env.HARNESS_MIX_QODER_EXECUTABLE = override;
      assert.equal(nativeCommand('qoder', ['--acp']).command, override, '显式覆盖仍然生效');
    } finally {
      process.env.PATH = originalPath;
      if (originalOverride === undefined) delete process.env.HARNESS_MIX_QODER_EXECUTABLE;
      else process.env.HARNESS_MIX_QODER_EXECUTABLE = originalOverride;
    }
  }

  console.log('Native adapters: streaming deduplication, user suppression, question retry, exact native approvals, sanitized usage, grok images, grok compaction & UI projection, qoder ACP resolution PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
