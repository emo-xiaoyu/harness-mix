// ZCode native app-server adapter coverage: runs the adapter against a fixture
// ZCode Protocol app-server (same framing, method set and event shapes as
// zcode.cjs 0.16.5). Fully offline. Invoked as
//   node zcode-adapter-test.cjs            -> driver
//   node zcode-adapter-test.cjs app-server --stdio  -> fixture (via env override)
const assert = require('node:assert/strict');

const mode = process.argv[2];

if (mode === 'app-server') {
  // Fixture: minimal ZCode app-server speaking the verified protocol subset.
  let nextId = 100;
  const send = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);
  const notify = (method, params) => send({ method, params });
  let buffer = '';
  // server→client 请求的处理注册表：应答到达时回调
  const pendingServerRequests = new Map();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      // jsonrpc:false 模式下客户端帧不得携带 jsonrpc 字段
      assert.equal(message.jsonrpc, undefined, 'client frames must not carry a jsonrpc key');
      const { id, method, params } = message;
      if (id !== undefined && pendingServerRequests.has(id)) {
        pendingServerRequests.get(id)(message);
        pendingServerRequests.delete(id);
        continue;
      }
      if (method === 'session/create') {
        const prefsId = nextId++;
        pendingServerRequests.set(prefsId, data => {
          assert.deepEqual(data.result, { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' });
          send({ id, result: { session: { sessionId: 'sess-fix', mode: 'build', status: 'idle' }, projection: { contextUsed: 0, contextWindow: 200000, status: 'idle' } } });
        });
        send({ id: prefsId, method: 'session/requestRuntimePreferences', params: { sessionId: 'sess-fix', scope: 'runtime-materialization' } });
      } else if (method === 'session/subscribe') {
        assert.equal(params.deliveryKind, 'desktop-continuous');
        send({ id, result: { sessionId: params.sessionId, eventSeq: 0, events: [] } });
        notify('state.updated', { scope: 'session', sessionId: params.sessionId, revision: 1, patch: { model: { available: [
          { ref: { providerId: 'account:fixture-plan', modelId: 'glm-4.6' }, label: 'GLM-4.6', contextWindow: 200000, reasoning: { levels: [{ value: 'low' }, { value: 'high' }], defaultLevel: 'high' } },
          { ref: { providerId: 'account:fixture-plan', modelId: 'glm-4.5-air' }, label: 'GLM-4.5 Air' },
        ] }, projection: { contextUsed: 1234, contextWindow: 200000 } } });
      } else if (method === 'session/setModel') {
        assert.ok(params.model?.options?.reasoningLevel, 'setModel 必须携带 reasoningLevel');
        send({ id, result: { sessionId: params.sessionId, accepted: true } });
      } else if (method === 'session/setThoughtLevel') {
        send({ id, result: { sessionId: params.sessionId, accepted: true } });
      } else if (method === 'provider/updateAccountConfig') {
        // 安全属性:账号声明必须零密钥——仅凭据条目名(connectionKey)参与链接
        const providerIds = Object.keys(params.providers ?? {});
        assert.ok(providerIds.length > 0 && providerIds.every(id => /^account:/.test(id)), '推送必须使用内置 account: 供应商 id');
        for (const id of providerIds) {
          const access = params.providers[id]?.access ?? {};
          assert.deepEqual(Object.keys(access).sort(), ['entitled', 'type'], 'access 不得携带密钥字段');
          assert.equal(access.type, 'zhipu-account');
          const state = params.states?.[id] ?? {};
          assert.ok(/^account-provider:.*:api-key$/.test(state.connectionKey ?? ''), 'states 需携带凭据条目名 connectionKey');
        }
        assert.ok(!JSON.stringify(params).includes('apiKey'), '推送体不得包含 apiKey 值');
        send({ id, result: { receivedRevision: params.revision, providerCount: providerIds.length, status: 'received' } });
      } else if (method === 'session/send') {
        assert.equal(params.content, 'hello');
        send({ id, result: { accepted: true, sessionId: params.sessionId, stateRevision: 2 } });
        const push = payload => send({ method: 'session/event', params: { deliveryKind: 'desktop-continuous', eventId: `evt-${nextId++}`, type: payload.type, payload } });
        const runTurn = () => {
          push({ type: 'turn.started', turnNumber: 0, input: params.content });
          push({ type: 'part.delta', messageId: 'm1', partId: 'p1', field: 'reasoning', delta: '思考' });
          push({ type: 'part.delta', messageId: 'm1', partId: 'p2', field: 'text', delta: '你' });
          push({ type: 'part.delta', messageId: 'm1', partId: 'p2', field: 'text', delta: '好' });
          push({ type: 'tool.updated', kind: 'scheduled', toolCallId: 't1', toolName: 'read_file', input: { path: 'a.txt' } });
          push({ type: 'tool.updated', kind: 'result', toolCallId: 't1', toolName: 'read_file', output: 'file body' });
          push({ type: 'tool.updated', kind: 'scheduled', toolCallId: 't2', toolName: 'write_file', input: { path: 'b.txt' } });
          const permId = nextId++;
          pendingServerRequests.set(permId, data => {
            const decision = data.result?.decision;
            push({ type: 'permission.resolved', toolCallId: 't2', decision });
            if (decision === 'allow') push({ type: 'tool.updated', kind: 'result', toolCallId: 't2', toolName: 'write_file', output: 'written' });
            const askId = nextId++;
            pendingServerRequests.set(askId, askData => {
              push({ type: 'turn.completed', response: `你好（${decision}/${askData.result?.value}）`, tokenCount: 42, usage: { inputTokens: 30, outputTokens: 12 }, toolCallCount: 2, duration: 1.5, cacheStats: { cacheReadTokens: 7 } });
            });
            send({ id: askId, method: 'interaction/requestUserInput', params: { requestId: 'ask-1', prompt: '继续吗？', inputType: 'choice', choices: ['是', '否'] } });
          });
          send({ id: permId, method: 'interaction/requestPermission', params: { requestId: 'perm-1', toolCallId: 't2', toolName: 'write_file', riskLevel: 'medium', reason: '写入文件', input: { path: 'b.txt' }, options: [{ kind: 'allow_once' }] } });
        };
        // send 的应答先落盘，再在下一个 tick 推事件
        setTimeout(runTurn, 30);
      } else if (method === 'session/setModel') {
        send({ id, result: { sessionId: params.sessionId, accepted: true } });
      } else if (method === 'session/stop') {
        send({ id, result: { sessionId: params.sessionId, accepted: true, stateRevision: 3 } });
      } else if (method === 'session/events') {
        send({ id, result: { sessionId: params.sessionId, eventSeq: 0, events: [] } });
      } else if (method === 'session/close') {
        send({ id, result: { sessionId: params.sessionId } });
      } else if (id !== undefined) {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    }
  });
  setTimeout(() => process.exit(0), 60000);
  return;
}

// --- driver: exercise the adapter against the fixture via the env override ---
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zcode = require('../src/main/adapters/zcode');

(async () => {
  // 隔离:fixture 内置目录(account: fixture-plan)+ 凭据键名,不触碰真实安装
  const fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-fixture-'));
  const fixtureBuiltin = path.join(fixtureBase, 'zcode-builtin.json');
  fs.writeFileSync(fixtureBuiltin, JSON.stringify({
    schemaVersion: 1, revision: 42,
    config: { providerConfigRules: { providerRules: [{ providerId: 'account:fixture-plan', config: { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: ['glm-4.6', 'glm-4.5-air'] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } },
  }));
  fs.writeFileSync(path.join(fixtureBase, 'credentials.json'), JSON.stringify({ 'account-provider:coding-plan:account:fixture-plan:account:1:api-key': 'enc:v1:fake' }));
  const previous = {
    BUILTIN: process.env.HARNESS_MIX_ZCODE_BUILTIN_CONFIG,
    EXEC: process.env.HARNESS_MIX_ZCODE_EXECUTABLE,
    CREDENTIALS: process.env.HARNESS_MIX_ZCODE_CREDENTIALS,
    SECRET: process.env.ZCODE_CREDENTIAL_SECRET,
    DATA: process.env.ZCODE_DATA_BASE_DIR,
  };
  process.env.HARNESS_MIX_ZCODE_EXECUTABLE = __filename;
  process.env.HARNESS_MIX_ZCODE_BUILTIN_CONFIG = fixtureBuiltin;
  process.env.HARNESS_MIX_ZCODE_CREDENTIALS = path.join(fixtureBase, 'credentials.json');
  delete process.env.ZCODE_DATA_BASE_DIR;
  assert.deepEqual(zcode.resolveLaunch(), { command: process.execPath, args: [__filename, 'app-server', '--stdio'] });
  const adapter = zcode.create();
  const events = [];
  let session;
  try {
    session = await adapter.open({
      thread: { cwd: process.cwd() },
      emit: event => events.push(event),
      diagnostic: () => {},
    });
    assert.equal(session.state.sessionId, 'sess-fix');
    const sessionEvent = events.find(event => event.kind === 'session');
    assert.equal(sessionEvent.nativeSessionId, 'sess-fix');

    const models = await adapter.listModelsFor(session);
    assert.deepEqual(models.map(model => model.id), ['glm-4.6', 'glm-4.5-air']);
    assert.equal(models[0].provider, 'account:fixture-plan');
    assert.deepEqual(models[0].efforts, ['low', 'high']);
    assert.equal(models[0].defaultEffort, 'high');
    const selected = await adapter.setModel(session, models[0]);
    assert.equal(selected.id, 'glm-4.6');
    await adapter.setThinkingLevel(session, 'low');

    // 权限/提问卡片先于回合结束出现，respond 后回合才完成
    const settled = adapter.send(session, 'hello');
    await assert.rejects(
      () => Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error('回合提前结束')), 400))]),
      /回合提前结束/, '权限未应答时回合必须保持等待');
    const waitFor = async predicate => {
      for (let i = 0; i < 200; i++) {
        const found = events.find(predicate);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return null;
    };
    const approval = await waitFor(event => event.kind === 'approval' && String(event.requestId).includes('requestPermission'));
    assert.ok(approval, '权限卡片必须投影');
    assert.ok(approval.title.includes('write_file'));
    await adapter.respond(session, approval.requestId, { optionId: 'accept' });
    const question = await waitFor(event => event.kind === 'approval' && String(event.requestId).includes('requestUserInput'));
    assert.ok(question, '提问卡片必须投影');
    assert.deepEqual(question.options.map(option => option.id), ['是', '否']);
    await adapter.respond(session, question.requestId, { optionId: '是' });
    await settled;

    assert.equal(events.filter(event => event.kind === 'thinking-delta').map(event => event.text).join(''), '思考', 'reasoning delta 投影');
    assert.equal(events.filter(event => event.kind === 'text-delta').map(event => event.text).join(''), '你好');
    const tools = events.filter(event => event.kind === 'tool');
    assert.deepEqual(tools.map(tool => `${tool.toolCallId}:${tool.state}`), ['t1:running', 't1:done', 't2:running', 't2:done']);
    assert.equal(tools[1].output, 'file body');
    assert.equal(tools[3].output, 'written');
    const usageEvent = events.find(event => event.kind === 'usage');
    assert.deepEqual(usageEvent.usage, { inputTokens: 30, outputTokens: 12, cachedInputTokens: 7, totalTokens: 42 });
    assert.ok(events.some(event => event.kind === 'completed' && event.finalAnswer === true));
    const context = await adapter.getContextUsage(session);
    assert.deepEqual(context, { usedTokens: 1234, contextWindow: 200000 });

    // 取消：向 server 发送 session/stop 并本地结算
    await adapter.cancel(session);
    await adapter.close(session);
    console.log('zcode adapter: protocol framing, session lifecycle, model catalog, permissions, questions, deltas, tools, usage and cancel PASS');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fixtureBase, { recursive: true, force: true });
    session?.proc?.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
