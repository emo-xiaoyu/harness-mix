const assert = require('node:assert/strict');
const { acpAdapter } = require('../src/main/adapters/acp');
const { randomUUID } = require('node:crypto');

// acpAdapter（Hermes 所在 ACP 家族工厂）图片附件路径单元测试：
// initialize 实测声明 image 支持 → session/prompt 携带 {type:'image',data,mimeType} 块；
// 声明不支持 → send 直接拒绝（"原生 ACP 不支持图片"），不静默丢图。
// fixture 子进程模式仿 native-acp-depth-test.cjs。

if (process.argv.includes('--fixture')) {
  const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const noImages = process.argv.includes('--no-images');
  let sid, sawImageBlock = null;
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const r = JSON.parse(line);
    let result = {};
    if (r.method === 'initialize') result = { agentCapabilities: { loadSession: true, promptCapabilities: { image: !noImages } } };
    if (r.method === 'session/new' || r.method === 'session/load') {
      sid = randomUUID();
      result = { sessionId: sid, configOptions: [{ id: 'model', currentValue: 'native-model', options: [{ value: 'native-model', name: 'Native' }] }] };
    }
    if (r.method === 'session/prompt') {
      if (r.params.prompt[0]?.text === 'image') {
        sawImageBlock = r.params.prompt[1];
        // 形状断言在 fixture 内完成：不匹配直接以错误回包，让适配器侧 reject
        const ok = JSON.stringify(sawImageBlock) === JSON.stringify({ type: 'image', data: 'AA==', mimeType: 'image/png' });
        if (!ok) { write({ id: r.id, error: { message: `image block shape mismatch: ${JSON.stringify(sawImageBlock)}` } }); return; }
      }
      result = { stopReason: 'end_turn', userMessageId: 'fixture-user' };
    }
    if (r.id !== undefined) write({ id: r.id, result });
    if (r.method === 'session/prompt' && sawImageBlock) process.stderr.write(`IMAGE_BLOCK_OK:${JSON.stringify(sawImageBlock)}\n`);
  });
} else {
  (async () => {
    const build = () => acpAdapter({
      id: 'hermes', name: 'Hermes', bin: 'hermes-fixture', executable: true, args: ['acp'],
      images: true, fork: true, thinking: false, permissions: false, questions: false, compaction: false, usage: false, contextUsage: false,
      resolveCommand: () => ({ command: process.execPath, args: [__filename, '--fixture'] }),
    }).create();

    // 1. 握手声明 image 支持 → 图片块按 ACP 形状进入 session/prompt
    const adapter = build();
    const session = await adapter.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    try {
      assert.equal(session.state.agentCapabilities?.promptCapabilities?.image, true, '握手能力必须被采集');
      await adapter.send(session, 'image', { emit: () => {} }, { images: [{ data: 'AA==', mime: 'image/png' }] });
    } finally { await adapter.close(session); }

    // 2. 纯文本回合不受影响
    const textAdapter = build();
    const textSession = await textAdapter.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    try { await textAdapter.send(textSession, 'plain', { emit: () => {} }); }
    finally { await textAdapter.close(textSession); }

    // 3. 旧版上游（initialize 不声明 image）→ send 拒绝而不是静默丢图
    const old = acpAdapter({
      id: 'hermes', name: 'Hermes', bin: 'hermes-fixture', executable: true, args: ['acp'],
      images: true, fork: true, thinking: false, permissions: false, questions: false, compaction: false, usage: false, contextUsage: false,
      resolveCommand: () => ({ command: process.execPath, args: [__filename, '--fixture', '--no-images'] }),
    }).create();
    const oldSession = await old.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    try {
      await assert.rejects(old.send(oldSession, 'image', { emit: () => {} }, { images: [{ data: 'AA==', mime: 'image/png' }] }), /Hermes 原生 ACP 不支持图片/);
    } finally { await old.close(oldSession); }

    console.log('acp image: prompt block shape, handshake gating and loud rejection PASS');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
