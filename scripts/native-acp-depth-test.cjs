const assert = require('node:assert/strict');
const { nativeAcp, project } = require('../src/main/adapters/native-acp');
const { AcpInteractions } = require('../src/main/adapters/acp-interactions');
const { historyUsage, branch, latestAssistantAfterUser } = require('../src/main/adapters/codebuddy-history');
const { projectUsage } = require('../src/main/native/usage');
const { randomUUID } = require('node:crypto');

if (process.argv.includes('--fixture')) {
  const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  let sid, pending, cancelled = false;
  const heartbeat = process.argv.includes('--heartbeat');
  const ignorePrompt = process.argv.includes('--ignore-prompt');
  const delayedFinal = process.argv.includes('--delayed-final');
  if (heartbeat) setInterval(() => { if (sid) write({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 1, size: 100 } } }); }, 20).unref();
  let configs = [{ id: 'model', currentValue: 'native[variant]', options: [{ value: 'native[variant]', name: 'Native' }, { value: 'other' }] },
    { id: 'thought_level', currentValue: 'medium', options: [{ value: 'high', name: 'High' }, { value: 'medium' }] },
    { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'plan' }] }];
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const r = JSON.parse(line); let result = {};
    if (r.method === 'initialize') result = { agentCapabilities: { loadSession: true, promptCapabilities: { image: !process.argv.includes('--no-images') }, sessionCapabilities: { fork: {} }, _meta: { kiro: { extensionMethods: ['_kiro/session/compact', '_kiro/session/context'] } } } };
    if (r.method === 'session/new' || r.method === 'session/load') {
      sid = r.params.sessionId || randomUUID();
      // Replay and foreign sessions must never leak into the parent turn.
      write({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY' } } } });
      result = { sessionId: sid, configOptions: configs };
    }
    if (r.method === 'session/set_config_option') {
      configs = configs.map(c => c.id === r.params.configId ? { ...c, currentValue: r.params.value } : c);
      result = { configOptions: configs };
    }
    if (r.method === 'session/fork') { assert.equal(r.params._meta?.kiro?.messageId, 'native-end'); result = { sessionId: randomUUID() }; }
    if (r.method === '_kiro/session/context') result = { usagePercentage: 23 };
    if (r.method === 'session/prompt') {
      if (r.params.prompt[0].text === 'image') assert.deepEqual(r.params.prompt[1], { type: 'image', data: 'AA==', mimeType: 'image/png' });
      if (cancelled) { write({ id: r.id, error: { message: 'Old CodeBuddy connection still cancelled' } }); return; }
      if (r.params.prompt[0].text === 'wait') { pending = r.id; return; }
      if (ignorePrompt) return; // 模拟 agent 完全不响应、心跳单独存活
      result = { stopReason: 'end_turn', userMessageId: 'native-user' };
      if (delayedFinal) setTimeout(() => write({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE_OK' } } } }), 400);
      else {
        write({ method: 'session/update', params: { sessionId: sid + '-other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREIGN' } } } });
        write({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } });
      }
    }
    if (r.method === 'session/cancel') { if (process.argv.includes('--ignore-cancel')) return; cancelled = true; write({ id: pending, result: { stopReason: 'cancelled' } }); return; }
    if (r.id !== undefined) write({ id: r.id, result });
  });
} else {
  (async () => {
    for (const vendor of ['codebuddy', 'kiro-cli', 'cursor-cli', 'qoder', 'zcode', 'trae']) {
      const module = nativeAcp({ id: vendor, name: vendor, args: [], timeoutMs: 2000, command: () => ({ command: process.execPath, args: [__filename, '--fixture'] }) });
      const adapter = module.create(), events = [];
      let s;
      try {
        s = await adapter.open({ thread: { cwd: process.cwd() }, emit: e => events.push(e) });
        assert.equal((await adapter.listModelsFor(s))[0].id, 'native[variant]');
        await adapter.send(s, 'image', { emit: e => events.push(e) }, { images: [{ data: 'AA==', mime: 'image/png' }] });
        events.length = 0;
        await adapter.setModel(s, { id: 'other' });
        if (vendor !== 'cursor-cli') await adapter.setThinkingLevel(s, 'high');
        const first = adapter.send(s, 'wait', { emit: e => events.push(e) });
        await assert.rejects(adapter.send(s, 'busy', { emit: () => {} }), /busy/);
        await assert.rejects(adapter.setModel(s, { id: 'other' }), /busy/);
        await adapter.cancel(s); await first;
        if (vendor === 'codebuddy') {
          assert.equal(s.model.id, 'other');
          assert.equal(s.state.configOptions.find(c => c.id === 'thought_level').currentValue, 'high');
          await adapter.send(s, 'after cancel', { emit: e => events.push(e) });
          assert.equal(events.filter(e => e.kind === 'text-delta').map(e => e.text).join(''), 'OK');
        }
        if (vendor === 'kiro-cli') {
          assert.equal((await adapter.getContextUsage(s)).contextUsagePercent, 23);
          const fs = require('node:fs/promises'), path = require('node:path');
          const saved = process.env.KIRO_HOME;
          process.env.KIRO_HOME = path.resolve('output', 'kiro-history-test-' + randomUUID());
          try {
            const dir = path.join(process.env.KIRO_HOME, 'sessions', 'workspace', s.nativeSessionId);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify({ id: s.nativeSessionId, workspacePaths: [process.cwd()] }));
            await fs.writeFile(path.join(dir, 'messages.jsonl'), JSON.stringify({ id: 'native-user', payload: { type: 'user' } }) + '\n' + JSON.stringify({ id: 'native-end', payload: { type: 'turn_end' } }));
            const fork = await adapter.fork({ cwd: process.cwd(), nativeSessionId: s.nativeSessionId }, { emit: () => {} });
            assert.notEqual(fork.session.nativeSessionId, s.nativeSessionId); await adapter.close(fork.session);
            await fs.appendFile(path.join(dir, 'messages.jsonl'), '\n' + JSON.stringify({ id: 'rewritten', payload: { type: 'tombstone' } }));
            await assert.rejects(adapter.fork({ cwd: process.cwd(), nativeSessionId: s.nativeSessionId }, { emit: () => {} }), /Compacted/);
          } finally { if (saved === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = saved; }
        }
      } finally { await adapter.close(s); }
    }
    const events = [], s = { active: true, nativeSessionId: 's', emit: e => events.push(e) };
    const noImages = nativeAcp({ id: 'qoder', name: 'Qoder', args: [],
      command: () => ({ command: process.execPath, args: [__filename, '--fixture', '--no-images'] }) }).create();
    const textOnly = await noImages.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    try {
      await assert.rejects(noImages.send(textOnly, 'image', { emit: () => {} }, { images: [{ data: 'AA==', mime: 'image/png' }] }), /not supported/);
      assert.equal(textOnly.active, false);
      await noImages.send(textOnly, 'text still works', { emit: () => {} });
    } finally { await noImages.close(textOnly); }
    const unresponsive = nativeAcp({ id: 'cursor-cli', name: 'Cursor', args: [], timeoutMs: 500,
      command: () => ({ command: process.execPath, args: [__filename, '--fixture', '--ignore-cancel'] }) }).create();
    const stalled = await unresponsive.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    const stalledTurn = unresponsive.send(stalled, 'wait', { emit: () => {} });
    const failedTurn = assert.rejects(stalledTurn);
    await assert.rejects(unresponsive.cancel(stalled)); await failedTurn;
    assert.ok(stalled.fault); await assert.rejects(unresponsive.send(stalled, 'again', { emit: () => {} }));
    await unresponsive.close(stalled);
    const idle = nativeAcp({ id: 'codebuddy', name: 'CodeBuddy', args: [], timeoutMs: 1000, turnIdleTimeoutMs: 100,
      command: () => ({ command: process.execPath, args: [__filename, '--fixture'] }) }).create();
    const idleSession = await idle.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    try {
      await assert.rejects(idle.send(idleSession, 'wait', { emit: () => {} }), /no progress/);
      assert.match(idleSession.fault.message, /no progress/);
    } finally { await idle.close(idleSession); }
    const cursor = new AcpInteractions(s, 'cursor-cli');
    const plan = cursor.request('cursor/create_plan', { sessionId: 's', plan: 'Native plan' });
    await assert.rejects(cursor.respond(events.at(-1).requestId, { value: 'invented' }));
    await cursor.respond(events.at(-1).requestId, { value: 'reject' });
    assert.equal((await plan).outcome.outcome, 'rejected');
    const questions = cursor.request('cursor/ask_question', { questions: [{ id: 'q', prompt: 'Choose', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: true }] });
    await assert.rejects(cursor.respond(events.at(-1).requestId, { value: '["fake"]' }));
    await cursor.respond(events.at(-1).requestId, { value: '["a","b"]' });
    assert.deepEqual((await questions).outcome.answers, [{ questionId: 'q', selectedOptionIds: ['a', 'b'] }]);
    const kiro = new AcpInteractions(s, 'kiro-cli');
    const question = kiro.request('_kiro/userInput', { question: 'Why?' });
    await kiro.respond(events.at(-1).requestId, { value: 'Because' });
    assert.deepEqual(await question, { action: 'answered', answer: 'Because' });
    let failures = 1, nativeAnswers;
    s.request = async (method, p) => { assert.equal(method, '_codebuddy.ai/resolveInterruption'); if (failures--) throw new Error('retry'); nativeAnswers = p; return { resolved: true }; };
    const buddy = new AcpInteractions(s, 'codebuddy');
    const answer = buddy.request('session/request_permission', { toolCall: { toolCallId: 'tool', _meta: { 'codebuddy.ai/toolName': 'AskUserQuestion' }, rawInput: { questions: [{ question: 'Choose', options: [{ label: 'yes' }] }] } } });
    const requestId = events.at(-1).requestId;
    await assert.rejects(buddy.respond(requestId, { value: 'yes' }), /retry/);
    await buddy.respond(requestId, { value: 'yes' });
    assert.equal((await answer).outcome.outcome, 'cancelled');
    assert.deepEqual(nativeAnswers.answers, { q_0: ['yes'] });
    const permission = buddy.request('session/request_permission', { toolCall: {}, options: [{ optionId: 'native-always', name: 'Always', kind: 'allow_always' }] });
    await buddy.respond(events.at(-1).requestId, { optionId: 'native-always' });
    assert.equal((await permission).outcome.optionId, 'native-always');
    const pending = kiro.request('_kiro/userInput', { question: 'Cancel?' }); kiro.close();
    assert.deepEqual(await pending, { action: 'dismissed' });
    const emitted = [], ps = { nativeSessionId: 's', active: true, vendor: 'cursor-cli', state: { usage: {} }, tools: new Map(), charges: new Map(), emit: e => emitted.push(e) };
    const update = u => project(ps, { method: 'session/update', params: { sessionId: 's', update: u } });
    const tool = { sessionUpdate: 'tool_call', toolCallId: 't', status: 'completed', content: [{ type: 'diff', path: 'a', oldText: 'old', newText: 'new' }] };
    update(tool); update(tool);
    assert.equal(emitted.filter(e => e.kind === 'file-change').length, 1);
    // CodeBuddy Bash output: start has description content, completed update has rawOutput with stdout:
    update({ sessionUpdate: 'tool_call', toolCallId: 'bash-1', title: '`ls`', status: 'in_progress', rawInput: { command: 'ls' }, content: [{ type: 'content', content: { type: 'text', text: 'List files' } }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'bash-1', status: 'completed', rawOutput: { type: 'text', text: 'Command: ls\nStdout: a.js\nb.js\nExit Code: 0' } });
    const bashTool = emitted.filter(e => e.kind === 'tool' && e.toolCallId === 'bash-1').at(-1);
    assert.equal(bashTool?.state, 'completed');
    assert.equal(bashTool?.output, 'Command: ls\nStdout: a.js\nb.js\nExit Code: 0');
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CHILD' }, _meta: { 'codebuddy.ai/parentToolCallId': 't' } });
    assert.equal(emitted.filter(e => e.kind === 'text-delta').length, 0);
    const usage = historyUsage([{ providerData: { messageId: 'one', rawUsage: { credit: 2, prompt_tokens: 3 } } }, { providerData: { messageId: 'one', rawUsage: { credit: 2, prompt_tokens: 3 } } }]);
    assert.equal(usage.totalCredits, 2); assert.equal(projectUsage(usage).totalCredits, 2); assert.equal(projectUsage(usage).totalCostUsd, undefined);
    assert.equal(latestAssistantAfterUser([{ type: 'message', id: 'old-u', role: 'user', content: 'old' }, { type: 'message', id: 'old-a', role: 'assistant', content: 'old answer' },
      { type: 'message', id: 'new-u', role: 'user', content: 'new' }, { type: 'function_call_result' }], 'new-u'), '', 'Do not replay an earlier answer when the current turn has none');
    assert.equal(latestAssistantAfterUser([{ type: 'message', id: 'new-u', role: 'user', content: [{ type: 'input_text', text: 'new' }] },
      { type: 'message', id: 'new-a', role: 'assistant', content: [{ type: 'output_text', text: 'native final' }] }], 'new-u'), 'native final');
    assert.throws(() => branch([{ type: 'message', id: 'a', parentId: 'a' }]), /parent chain/);
    // 进度事件重置 idle，heartbeat-only 不重置：心跳场景下 idle 应当照常起效。
    const heartbeatOnly = nativeAcp({ id: 'codebuddy', name: 'CodeBuddy', args: [], timeoutMs: 1000, turnIdleTimeoutMs: 80, turnPromptTimeoutMs: 60_000, cancelGraceMs: 1000,
      command: () => ({ command: process.execPath, args: [__filename, '--fixture', '--ignore-prompt', '--heartbeat'] }) }).create();
    const heartbeatSession = await heartbeatOnly.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    try {
      await assert.rejects(heartbeatOnly.send(heartbeatSession, 'alive', { emit: () => {} }), /no progress/);
      assert.match(heartbeatSession.fault.message, /no progress/);
    } finally { await heartbeatOnly.close(heartbeatSession); }
    // 硬上限：即使心跳/usage_update 持续到天荒地老，turnPromptTimeoutMs 一定上到。
    const hardCeiling = nativeAcp({ id: 'codebuddy', name: 'CodeBuddy', args: [], timeoutMs: 1000, turnIdleTimeoutMs: 5 * 60_000, turnPromptTimeoutMs: 80, cancelGraceMs: 1000,
      command: () => ({ command: process.execPath, args: [__filename, '--fixture', '--ignore-prompt', '--heartbeat'] }) }).create();
    const ceilingSession = await hardCeiling.open({ thread: { cwd: process.cwd() }, emit: () => {} });
    try {
      const t0 = Date.now();
      await assert.rejects(hardCeiling.send(ceilingSession, 'forever', { emit: () => {} }), /hard ceiling/);
      assert.ok(Date.now() - t0 < 2000, '硬上限应接近 80ms 触发，而不是被心跳重置');
    } finally { await hardCeiling.close(ceilingSession); }
    // Prompt receipt may precede the final ACP message notification. The
    // bounded drain keeps the Core turn active long enough to project it.
    const delayed = nativeAcp({ id: 'dsh', name: 'DSH', args: [], timeoutMs: 1000, turnEventDrainMs: 100, turnEventDrainMaxMs: 900,
      command: () => ({ command: process.execPath, args: [__filename, '--fixture', '--delayed-final'] }) }).create();
    const delayedEvents = [];
    const delayedSession = await delayed.open({ thread: { cwd: process.cwd() }, emit: e => delayedEvents.push(e) });
    try {
      await delayed.send(delayedSession, 'late', { emit: () => {} });
      assert.equal(delayedEvents.filter(e => e.kind === 'text-delta').map(e => e.text).join(''), 'LATE_OK');
    } finally { await delayed.close(delayedSession); }
    console.log('Native ACP depth: cancel/reconnect, session isolation, exact approvals, question retry/multi-select, plan, Kiro context/fork, diff dedup and credits PASS');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
