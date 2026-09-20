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
  let turnCount = 0;
  const seenModes = [];
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
      } else if (method === 'session/setMode') {
        assert.ok(['plan', 'build', 'edit', 'yolo'].includes(params.mode), `setMode 必须使用规范模式枚举，收到 ${params.mode}`);
        assert.equal(params.expectedRevision, undefined, 'setMode 无需 expectedRevision');
        seenModes.push(params.mode);
        assert.deepEqual(seenModes, ['build', 'yolo'].slice(0, seenModes.length), `setMode 序列应为 open 应用线程选项→显式切换：${seenModes}`);
        send({ id, result: { sessionId: params.sessionId, mode: params.mode, accepted: true } });
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
        assert.ok(['hello', '带路径图', '纯base64图'].includes(params.content), `意外的回合内容：${params.content}`);
        if (Array.isArray(params.attachments)) {
          // 实测约束：dataBase64 通道只会退化为元数据占位符，附件必须走 localPath
          for (const attachment of params.attachments) {
            assert.equal(attachment.kind, 'image', 'Harness Mix 只路由图片附件');
            assert.ok(attachment.filename && attachment.mimeType, '附件必须带 filename 与 mimeType');
            assert.ok(typeof attachment.localPath === 'string' && attachment.localPath, '附件必须走 localPath 通道');
            assert.equal(attachment.dataBase64, undefined, '不得使用会降级的 dataBase64 通道');
            assert.ok(Number.isInteger(attachment.sizeBytes) && attachment.sizeBytes > 0, '附件需携带 sizeBytes 提示');
          }
        }
        send({ id, result: { accepted: true, sessionId: params.sessionId, stateRevision: 2 } });
        const push = payload => send({ method: 'session/event', params: { deliveryKind: 'desktop-continuous', eventId: `evt-${nextId++}`, type: payload.type, payload } });
        turnCount += 1;
        if (turnCount > 1) {
          // 附件回合：简化事件流，回合直接完成
          const simple = () => {
            push({ type: 'turn.started', turnNumber: turnCount, input: params.content });
            push({ type: 'part.delta', messageId: 'm2', partId: 'p3', field: 'text', delta: '图已收到' });
            push({ type: 'turn.completed', response: '图已收到', tokenCount: 9, usage: { inputTokens: 5, outputTokens: 4 }, toolCallCount: 0, duration: 0.2 });
          };
          setTimeout(simple, 30);
          continue;
        }
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
  assert.equal(zcode.manifest.capabilities.permissionModes, true, 'manifest 必须声明 permissionModes 能力');
  assert.equal(zcode.manifest.capabilities.attachments, true, 'manifest 必须声明 attachments 能力');
  assert.equal(zcode.manifest.capabilities.collaborationTools, true, 'manifest 必须声明 collaborationTools（工人/团队成员角色）');
  const adapter = zcode.create();
  const events = [];
  let session;
  try {
    session = await adapter.open({
      thread: { cwd: process.cwd(), options: { permissionMode: 'build' } },
      emit: event => events.push(event),
      diagnostic: () => {},
      // 协作描述符在 open 时传入（工人/成员角色不需要 harness 侧 MCP 工具）
      collaboration: { command: process.execPath, args: ['bridge.cjs'], env: { HARNESS_MIX_COLLAB_KEY: 'fixture' } },
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

    // 权限模式目录与官方桌面选择器一致；线程选项在 open 时已生效
    const catalog = await adapter.describeFor(session);
    assert.deepEqual(catalog.permissionModes.map(mode => mode.id), ['plan', 'build', 'edit', 'yolo']);
    assert.equal(catalog.permissionModes.find(mode => mode.default)?.id, 'build', '原生默认档是 build');
    assert.equal(catalog.permissionModes.find(mode => mode.dangerous)?.id, 'yolo', '完全访问必须标记 dangerous');
    await adapter.setPermissionMode(session, 'yolo');
    await assert.rejects(() => adapter.setPermissionMode(session, 'auto'), /未知的 ZCode 权限模式/, '目录外模式必须拒绝');

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

    // 附件：runtime 已给路径的图直接走 localPath；纯 base64 落盘为临时文件后同通道发送
    await adapter.send(session, '带路径图', null, { images: [
      { name: 'shot.png', mime: 'image/png', data: 'aGVsbG8=', path: path.join(fixtureBase, 'shot.png') },
    ] });
    await adapter.send(session, '纯base64图', null, { images: [
      { name: 'paste.png', mime: 'image/png', data: Buffer.from('png-bytes').toString('base64') },
    ] });
    const textAfter = events.filter(event => event.kind === 'text-delta').map(event => event.text).join('');
    assert.ok(textAfter.includes('图已收到'), '附件回合必须完成');
    assert.equal(session.state.tempFiles.length, 1, '仅 base64-only 图片落盘');
    const tempFile = session.state.tempFiles[0];
    assert.ok(fs.existsSync(tempFile), 'base64 附件必须物化为临时文件');
    assert.equal(fs.readFileSync(tempFile).toString(), 'png-bytes', '落盘内容必须与 base64 解码一致');

    // 取消：向 server 发送 session/stop 并本地结算
    await adapter.cancel(session);
    await adapter.close(session);
    assert.equal(fs.existsSync(tempFile), false, 'close 后必须清理附件临时文件');
    console.log('zcode adapter: protocol framing, session lifecycle, model catalog, permissions, questions, deltas, tools, usage, attachments, collaboration and cancel PASS');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fixtureBase, { recursive: true, force: true });
    session?.proc?.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
