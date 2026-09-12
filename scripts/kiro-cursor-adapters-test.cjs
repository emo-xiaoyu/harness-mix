const assert = require('node:assert/strict');
const { acpAdapter, catalog } = require('../src/main/adapters/acp');
const { nativeCommand } = require('../src/main/adapters/native-acp-command');

if (process.argv.includes('--fixture')) {
  const readline = require('node:readline');
  const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const configs = [{ id: 'model', currentValue: 'sonnet', options: [{ value: 'sonnet', name: 'Sonnet' }] }, { id: 'effortLevel', currentValue: 'medium', options: [{ value: 'high', name: 'High' }] }];
  let prompt;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const r = JSON.parse(line);
    if (r.id === 'permission') {
      assert.equal(r.result.outcome.optionId, 'native-once');
      write({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native reply' } } } });
      write({ id: prompt, result: { stopReason: 'end_turn' } });
      return;
    }
    let result = {};
    if (r.method === 'initialize') result = { agentCapabilities: { loadSession: true } };
    else if (r.method === 'session/new' || r.method === 'session/load') result = { sessionId: r.params.sessionId || 'native-session', configOptions: configs };
    else if (r.method === 'session/set_config_option') { configs.find(c => c.id === r.params.configId).currentValue = r.params.value; result = { configOptions: configs }; }
    else if (r.method === 'session/prompt') {
      prompt = r.id;
      write({ id: 'permission', method: 'session/request_permission', params: { toolCall: { title: 'Test native permission' }, options: [{ kind: 'allow_once', optionId: 'native-once' }] } });
      return;
    } else if (r.method === 'session/cancel') return;
    if (r.id !== undefined) write({ id: r.id, result });
  });
} else {
  (async () => {
    for (const [id, key, argv] of [
      ['qoder', 'HARNESS_MIX_QODER_EXECUTABLE', ['--acp']],
      ['zcode', 'HARNESS_MIX_ZCODE_ACP_EXECUTABLE', []],
      ['trae', 'HARNESS_MIX_TRAE_EXECUTABLE', []],
    ]) {
      const previous = process.env[key];
      try {
        delete process.env[key];
        if (id !== 'qoder') assert.throws(() => nativeCommand(id, argv), /ACP/);
        process.env[key] = __filename + '.missing';
        assert.throws(() => nativeCommand(id, argv), /未安装/);
        process.env[key] = __filename;
        assert.deepEqual(nativeCommand(id, argv), { command: process.execPath, args: [__filename, ...argv] });
      } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
    }
    for (const name of ['kiro', 'cursor']) {
      const module = require('../src/main/adapters/' + name);
      assert.equal(module.manifest.capabilities.fork, name === 'kiro');
      assert.equal(module.manifest.capabilities.questions, true);
      const key = name === 'kiro' ? 'HARNESS_MIX_KIRO_EXECUTABLE' : 'HARNESS_MIX_CURSOR_EXECUTABLE';
      const previous = process.env[key];
      try {
        process.env[key] = __filename + '.missing';
        assert.throws(() => nativeCommand(module.manifest.id, ['acp']), /未安装/);
        assert.equal((await module.create().inspect()).available, false);
        process.env[key] = process.execPath;
        assert.deepEqual(nativeCommand(module.manifest.id, ['acp']), { command: process.execPath, args: ['acp'] });
      } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
    }
    const adapter = acpAdapter({ id: 'fixture', name: 'Fixture', bin: () => ({ command: process.execPath, args: [__filename, '--fixture'] }), args: [], requestTimeoutMs: 5000 }).create();
    const events = [];
    let session;
    const emit = event => {
      events.push(event);
      if (event.kind === 'approval') queueMicrotask(() => adapter.respond(session, event.requestId, { confirmed: true }));
    };
    try {
      session = await adapter.open({ thread: { cwd: process.cwd() }, emit });
      assert.equal(catalog(session).models[0].id, 'sonnet');
      await adapter.setThinkingLevel(session, 'high');
      assert.equal(session.state.configOptions[1].currentValue, 'high');
      await adapter.send(session, 'hello', { emit });
      assert.ok(events.some(e => e.text === 'native reply'));
      assert.equal(events.filter(e => e.kind === 'completed').length, 1);
      await adapter.close(session);
      session = await adapter.open({ thread: { cwd: process.cwd(), restore: true, nativeSessionId: 'native-session' }, emit });
      assert.equal(session.nativeSessionId, 'native-session');
      await adapter.cancel(session);
    } finally { if (session) await adapter.close(session); }
    console.log('Kiro/Cursor: discovery isolation, config, native approval, streaming, resume and cancel PASS (fixture, not live model)');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
