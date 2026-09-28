const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createNativeFileSubagentBridge } = require('../src/main/adapters/native-file-subagents');
const { createGrokSubagentBridge } = require('../src/main/adapters/grok-subagents');
const { createHermesSubagentBridge } = require('../src/main/adapters/hermes-subagents');
const { HostRuntime } = require('../src/main/host/runtime');

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-native-child-'));
  try {
    const received = [];
    const emit = event => { received.push(event); };
    const qoder = createNativeFileSubagentBridge({ vendor: 'qoder', cwd: 'E:\\work', parentId: 'parent-q',
      environment: { HOME: root }, emit });
    const qoderFile = path.join(root, '.qoder', 'projects', 'E--work', 'parent-q', 'subagents', 'agent-research.jsonl');
    await write(qoderFile, [
      { type: 'user', sessionId: 'parent-q', agentId: 'research', isSidechain: true, message: { role: 'user', content: 'Inspect code' } },
      { type: 'assistant', sessionId: 'parent-q', agentId: 'research', isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a' } }] } },
      { type: 'user', sessionId: 'parent-q', agentId: 'research', isSidechain: true,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file' }] } },
      { type: 'assistant', sessionId: 'parent-q', agentId: 'research', isSidechain: true,
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    await qoder.scan();
    assert.equal(received.length, 1);
    assert.equal(received[0].nativeSessionId, 'parent-q:qoder:research');
    assert.equal(received[0].status, 'success');
    assert.equal(received[0].messages.length, 4);
    assert.equal(received[0].messages[2].info.role, 'assistant');
    assert.ok(received[0].messages[2].info.time.completed);
    await qoder.scan();
    assert.equal(received.length, 1, 'unchanged source should not replay');
    qoder.close();

    const cursor = createNativeFileSubagentBridge({ vendor: 'cursor-cli', cwd: 'E:\\work', parentId: 'parent-c',
      environment: { HOME: root }, emit });
    await cursor.resume();
    const cursorFile = path.join(root, '.cursor', 'projects', 'e-work', 'agent-transcripts', 'parent-c', 'subagents', 'child-1.jsonl');
    await write(cursorFile, [
      { role: 'user', message: { content: [{ type: 'text', text: 'Review' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Finding' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    await cursor.scan();
    assert.equal(received.at(-1).nativeSessionId, 'parent-c:cursor:child-1');
    assert.equal(received.at(-1).status, 'running');
    await cursor.settle();
    assert.equal(received.at(-1).status, 'success');
    await cursor.resume();
    await cursor.scan();
    assert.equal(received.at(-1).status, 'success', 'later parent turn must not reopen an old child');
    cursor.close();

    const cline = createNativeFileSubagentBridge({ vendor: 'cline', cwd: 'E:\\work', parentId: 'parent-cl',
      environment: { HOME: root }, emit });
    const sessions = path.join(root, '.cline', 'data', 'sessions');
    const messagesPath = path.join(sessions, 'child.messages.json');
    await write(messagesPath, JSON.stringify({ messages: [{ role: 'user', content: 'Audit' }, { role: 'assistant', content: 'Result' }] }));
    await write(path.join(sessions, 'sessions.index.json'), JSON.stringify({ version: 1, sessions: {
      child: { sessionId: 'child', parentSessionId: 'parent-cl', isSubagent: true,
        cwd: 'E:\\work', metadata: { sessionHistoryOrigin: { mode: 'subagent' } },
        messagesPath, status: 'running', prompt: 'Audit' },
      team: { sessionId: 'team', parentSessionId: 'parent-cl', isSubagent: true,
        metadata: { sessionHistoryOrigin: { mode: 'team' } }, messagesPath, status: 'completed' },
    } }));
    await cline.scan();
    assert.equal(received.at(-1).nativeSessionId, 'child');
    assert.equal(received.at(-1).status, 'running');
    assert.equal(received.at(-1).messages.length, 1, 'streaming snapshot must not import mutable assistant text');
    const clineIndex = JSON.parse(await fs.readFile(path.join(sessions, 'sessions.index.json'), 'utf8'));
    clineIndex.sessions.child.status = 'completed';
    await write(path.join(sessions, 'sessions.index.json'), JSON.stringify(clineIndex));
    await cline.scan();
    assert.equal(received.at(-1).status, 'success');
    assert.equal(received.at(-1).messages.length, 2);
    cline.close();

    const { DatabaseSync } = require('node:sqlite');
    const hermesHome = path.join(root, '.hermes');
    await fs.mkdir(hermesHome, { recursive: true });
    const db = new DatabaseSync(path.join(hermesHome, 'state.db'));
    db.exec('CREATE TABLE sessions (id TEXT, parent_session_id TEXT, title TEXT, ended_at TEXT, end_reason TEXT, model_config TEXT)');
    db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, active INTEGER)');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('hermes-child', 'hermes-parent', 'Research', '2026-09-27', 'completed', JSON.stringify({ _delegate_from: 'hermes-parent' }));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('ordinary-branch', 'hermes-parent', 'Branch', '2026-09-27', 'completed', '{}');
    db.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)').run('hermes-child', 'user', 'Inspect');
    db.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)').run('hermes-child', 'assistant', 'Result');
    db.close();
    const hermes = createHermesSubagentBridge({ parentId: 'hermes-parent', environment: { HERMES_HOME: hermesHome }, emit });
    await hermes.scan();
    assert.equal(received.at(-1).nativeSessionId, 'hermes-child');
    assert.equal(received.at(-1).status, 'success');
    assert.equal(received.filter(event => event.nativeSessionId === 'ordinary-branch').length, 0);
    hermes.close();

    const prior = process.env.GROK_HOME;
    process.env.GROK_HOME = path.join(root, '.grok');
    try {
      const grokRoot = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent('E:\\work'));
      await write(path.join(grokRoot, 'parent-g', 'subagents', 'agent-1', 'meta.json'), JSON.stringify({
        subagent_id: 'agent-1', parent_session_id: 'parent-g', child_session_id: 'child-g',
        status: 'completed', description: 'Inspect files', prompt: 'Inspect files', child_cwd: 'E:\\work',
      }));
      await write(path.join(grokRoot, 'child-g', 'updates.jsonl'), [
        { timestamp: 10, method: 'session/update', params: { sessionId: 'child-g', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Inspect files' } } } },
        { timestamp: 11, method: 'session/update', params: { sessionId: 'child-g', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } } },
        { timestamp: 12, method: 'session/update', params: { sessionId: 'child-g', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' now' } } } },
      ].map(JSON.stringify).join('\n') + '\n');
      const grok = createGrokSubagentBridge({ cwd: 'E:\\work', parentId: 'parent-g', emit });
      await grok.scan();
      assert.equal(received.at(-1).nativeSessionId, 'child-g');
      assert.equal(received.at(-1).status, 'success');
      assert.equal(received.at(-1).messages.length, 3, 'each native chunk keeps a stable append index');
      grok.close();
    } finally {
      if (prior === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prior;
    }

    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const runtime = new HostRuntime({ dataDirectory: path.join(root, 'host') });
    await runtime.store.load();
    let parentEmit;
    runtime.adapters.set('qoder', { manifest: { id: 'qoder', name: 'Qoder', capabilities: {} },
      async open(input) { parentEmit = input.emit; parentEmit({ kind: 'session', nativeSessionId: 'parent-ui' }); return {}; },
      async send() {}, async cancel() { parentEmit({ kind: 'completed', finalAnswer: false }); }, async close() {} });
    runtime.status.qoder = { available: true };
    const parent = await runtime.createThread({ harnessId: 'qoder', cwd: workspace });
    await runtime.send(parent.id, 'Delegate native work');
    parentEmit({ kind: 'native-subagent', nativeSessionId: 'parent-ui:qoder:child', title: 'Qoder · child',
      task: 'Inspect', status: 'success', messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'Inspect' }] },
        { info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'Done' }] },
      ] });
    for (let attempt = 0; attempt < 100 && !runtime.threads.some(item => item.parentThreadId === parent.id); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const child = runtime.threads.find(item => item.parentThreadId === parent.id);
    assert.ok(child, 'native event creates a clickable child thread');
    assert.equal(child.nativeReadOnly, true);
    assert.equal(child.messages.at(-1)?.text, 'Done');
    assert.ok(parent.tools.some(tool => tool.collaboration?.child_thread_id === child.id), 'parent card links to child');
    await runtime.cancel(parent.id);
    const save = runtime.store.save.bind(runtime.store);
    let releaseImport;
    const imported = new Promise(resolve => { releaseImport = resolve; });
    let delayNextSave = true;
    runtime.store.save = (...args) => {
      const saving = save(...args);
      if (!delayNextSave) return saving;
      delayNextSave = false;
      return saving.then(() => imported);
    };
    parentEmit({ kind: 'native-subagent', nativeSessionId: 'parent-ui:qoder:closing-child',
      title: 'Qoder · closing child', task: 'Check shutdown', status: 'success', messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'Check shutdown' }] },
        { info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'Saved before close' }] },
      ] });
    for (let attempt = 0; attempt < 100 && !runtime.threads.some(item => item.nativeSessionId === 'parent-ui:qoder:closing-child'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(runtime.threads.some(item => item.nativeSessionId === 'parent-ui:qoder:closing-child'));
    let closeSettled = false;
    const closing = runtime.close().finally(() => { closeSettled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(closeSettled, false, 'close waits for native child import to finish');
    } finally {
      releaseImport();
      await closing;
    }
    const stored = await runtime.store.load();
    const savedChild = stored.find(item => item.nativeSessionId === 'parent-ui:qoder:closing-child');
    assert.equal(savedChild?.nativeMessageCount, 2);
    assert.ok(savedChild?.coreState.items.some(item => item.type === 'agent_message' && item.content === 'Saved before close'),
      'close persists the complete native child transcript');
    console.log('native file subagent tests passed');
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
