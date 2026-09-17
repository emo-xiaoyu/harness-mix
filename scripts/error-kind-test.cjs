const assert = require('node:assert/strict');
const { classifyError, errorActions, mapCodexErrorInfo, codexErrorInfoKey, ERROR_KINDS } = require('../src/main/harness-adapter/error-kind');
const { EventNormalizer } = require('../src/main/harness-adapter/event-normalizer');
const { ProtocolCore } = require('../src/main/protocol-core/protocol-core');
const { CoreSession } = require('../src/main/host/core-session');
const { NativeProtocol } = require('../src/main/native/protocol');

function main() {
  // 1) 显式归类优先：适配器从原生结构化错误给出的 errorKind 原样采纳
  assert.equal(classifyError({ errorKind: 'quota', message: 'whatever' }), 'quota');
  assert.equal(classifyError({ errorKind: 'bogus', message: '401 unauthorized' }), 'auth');

  // 2) Codex 原生 CodexErrorInfo：字符串与单键对象两种线格式都打平映射
  assert.equal(mapCodexErrorInfo('usageLimitExceeded'), 'quota');
  assert.equal(mapCodexErrorInfo({ responseStreamDisconnected: {} }), 'network');
  assert.equal(mapCodexErrorInfo('internalServerError'), 'server');
  assert.equal(mapCodexErrorInfo('sandboxError'), null); // 未确认语义的变体不猜
  assert.equal(codexErrorInfoKey({ usageLimitExceeded: null }), 'usageLimitExceeded');
  assert.equal(classifyError({ codexErrorInfo: 'unauthorized', message: 'stream disconnected' }), 'auth');

  // 3) HTTP 状态码信号
  assert.equal(classifyError({ statusCode: 401 }), 'auth');
  assert.equal(classifyError({ statusCode: 403 }), 'auth');
  assert.equal(classifyError({ statusCode: 429 }), 'quota');
  assert.equal(classifyError({ statusCode: 400 }), 'refused');
  assert.equal(classifyError({ statusCode: 503 }), 'server');

  // 4) 消息特征归类（含优先级陷阱）
  assert.equal(classifyError({ message: 'Invalid API key provided' }), 'auth');
  assert.equal(classifyError({ message: 'Rate limit reached, please slow down' }), 'quota');
  assert.equal(classifyError({ message: 'request failed: connect ECONNREFUSED 127.0.0.1' }), 'network');
  assert.equal(classifyError({ message: 'Connection refused by peer' }), 'network'); // refused 字样不误导为请求被拒
  assert.equal(classifyError({ message: 'stream disconnected while reading' }), 'network');
  assert.equal(classifyError({ message: 'upstream 502 Bad Gateway' }), 'server');
  assert.equal(classifyError({ message: 'the request was rejected by the server' }), 'refused');
  assert.equal(classifyError({ message: '模型返回了奇怪的内容' }), 'unknown');
  assert.equal(classifyError({}), 'unknown');
  assert.ok(ERROR_KINDS.includes(classifyError({ message: '任何错误' })));

  // 5) 动作推导：login 按 Harness 真实登录能力过滤
  assert.deepEqual(errorActions('auth', { canLogin: true }), ['login', 'newSession']);
  assert.deepEqual(errorActions('auth', { canLogin: false }), ['newSession']);
  assert.deepEqual(errorActions('network'), ['retry']);
  assert.deepEqual(errorActions('quota'), ['newSession']);
  assert.deepEqual(errorActions('bogus'), ['retry', 'newSession']);

  // 6) Normalizer：error 事件 → turn.failed 携带 errorKind 与 codexErrorInfo
  const normalizer = new EventNormalizer({ threadId: 'thread_1', source: 'codex' });
  normalizer.beginTurn('turn_1', 'go');
  const failed = normalizer.normalize({ kind: 'error', message: 'Codex 回合失败', codexErrorInfo: 'usageLimitExceeded' });
  assert.equal(failed.at(-1).type, 'turn.failed');
  assert.equal(failed.at(-1).payload.errorKind, 'quota');
  assert.equal(failed.at(-1).payload.codexErrorInfo, 'usageLimitExceeded');
  // Turn 已结算后迟到的 error 事件被忽略
  assert.deepEqual(normalizer.normalize({ kind: 'error', message: 'late' }), []);

  // 7) Core：turn.failed 把 errorKind 落到 Turn 状态
  const core = new ProtocolCore();
  core.createThread({ id: 'thread_1', workspaceId: '/tmp' });
  const turn = core.turns.create({ threadId: 'thread_1' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.started' });
  core.dispatch({ threadId: 'thread_1', turnId: turn.id, type: 'turn.failed', payload: { message: '网络错误', errorKind: 'network' } });
  assert.equal(turn.status, 'error');
  assert.equal(turn.error, '网络错误');
  assert.equal(turn.errorKind, 'network');

  // 8) CoreSession：失败分类投影到线程模型
  const execution = new CoreSession();
  const thread = { id: 'thread_2', harnessId: 'pi', nativeSessionId: 's1', cwd: process.cwd(), messages: [], tools: [], connectionStatus: 'ready' };
  execution.threadCreated(thread);
  execution.turnStarted(thread, '跑一下');
  const { settled } = execution.apply(thread, { kind: 'error', message: '429 too many requests' });
  assert.equal(settled, true);
  assert.equal(thread.status, 'error');
  assert.match(thread.error, /429/);
  assert.equal(thread.errorKind, 'quota');

  // 9) 协议投影：turn() 透传原生 codexErrorInfo；turn-error 查询给出分类与动作
  const fakeRuntime = {
    threads: [{ id: 'thread_3', harnessId: 'claude', error: 'Invalid API key', errorKind: 'auth' }],
    getThread(id) { return this.threads.find(t => t.id === id); },
    core: { subscribe: () => () => {}, getItemsForTurn: () => [] },
    subscribe: () => () => {},
    adapters: new Map(),
    status: {},
  };
  const protocol = new NativeProtocol(fakeRuntime, () => {});
  const projected = protocol.turn({ id: 'turn_9', status: 'error', error: 'boom', codexErrorInfo: 'usageLimitExceeded' });
  assert.equal(projected.error.codexErrorInfo, 'usageLimitExceeded');
  const noInfo = protocol.turn({ id: 'turn_10', status: 'error', error: 'boom' });
  assert.equal(noInfo.error.codexErrorInfo, null);
  return (async () => {
    const state = await protocol.request('harnessmix/harness/turn-error', { threadId: 'thread_3' });
    assert.equal(state.errorKind, 'auth');
    assert.equal(state.error, 'Invalid API key');
    assert.deepEqual(state.actions, ['login', 'newSession']); // claude-code 有 loginCommand
    fakeRuntime.threads[0].errorKind = null;
    const cleared = await protocol.request('harnessmix/harness/turn-error', { threadId: 'thread_3' });
    assert.equal(cleared.errorKind, null);
    assert.deepEqual(cleared.actions, []);
    await assert.rejects(protocol.request('harnessmix/harness/turn-error', { threadId: 'nope' }), /Unknown thread/);
    protocol.close?.();
    console.log('PASS: error classification (explicit/codexErrorInfo/status/pattern/unknown), actions, normalizer/core/thread projection, turn-error query');
  })();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
