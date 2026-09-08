const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { CodexAppServer } = require('../src/main/adapters/codex-app-server');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function settle(thread) {
  for (let i = 0; i < 900 && (thread.status === 'working' || thread.reviewPending); i++) await sleep(200);
  assert.equal(thread.status, 'ready', thread.error);
}

(async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-codex-e2e-data-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-codex-e2e-work-'));
  const nativeIds = new Set();
  let runtime;
  try {
    runtime = new HostRuntime({ dataDirectory });
    await runtime.initialize();
    const source = await runtime.createThread({
      harnessId: 'codex', cwd, title: 'Codex native E2E',
      options: { permissionMode: ':danger-full-access' },
    });
    assert.notEqual(source.status, 'error', source.error);
    nativeIds.add(source.nativeSessionId);
    const catalog = await runtime.describe('codex');
    assert.ok(catalog.models.length > 0 && catalog.thinkingLevels.length > 0);
    const selectedModel = catalog.models.find(model => model.isDefault) ?? catalog.models[0];
    await runtime.setModel(source.id, selectedModel);
    await runtime.setThinking(source.id, selectedModel.defaultEffort ?? selectedModel.efforts[0].id);

    await runtime.send(source.id, 'Remember CODEX-FORK-4172. Reply exactly READY-4172. Do not use tools.');
    await settle(source);
    const boundary = source.messages.at(-1);
    assert.match(boundary.text, /READY-4172/);
    assert.ok(boundary.coreTurn.nativeTurnRef.turnId, 'native Codex turn id captured');

    await runtime.send(source.id, 'Remember LATER-9386 too. Reply exactly LATER-OK. Do not use tools.');
    await settle(source);
    const fork = await runtime.forkThread(source.id, boundary.id);
    nativeIds.add(fork.nativeSessionId);
    assert.notEqual(fork.nativeSessionId, source.nativeSessionId);
    assert.equal(fork.messages.length, 2, 'fork UI history ends at selected reply');

    const forkNativeId = fork.nativeSessionId;
    await runtime.close();
    runtime = new HostRuntime({ dataDirectory });
    await runtime.initialize();
    const resumed = runtime.threads.find(thread => thread.nativeSessionId === forkNativeId);
    assert.ok(resumed?.restore, 'persisted Codex task is lazily resumable');
    await runtime.send(resumed.id, 'What CODEX-FORK token did I ask you to remember? Reply only the token.');
    await settle(resumed);
    assert.match(resumed.messages.at(-1).text, /CODEX-FORK-4172/);
    assert.doesNotMatch(resumed.messages.at(-1).text, /LATER-9386/);
    const usage = await runtime.refreshUsage(resumed.id);
    assert.ok(usage.tokens > 0 && usage.contextWindow > 0 && usage.contextPercent > 0);
    await runtime.executeCommand(resumed.id, 'compact');
    await settle(resumed);
    assert.match(resumed.messages.at(-1).text, /Codex 压缩/);

    await fs.mkdir('output/verification', { recursive: true });
    await fs.writeFile('output/verification/codex-native.json', JSON.stringify({
      at: new Date().toISOString(), sourceId: source.nativeSessionId, forkId: forkNativeId,
      boundaryTurnId: boundary.coreTurn.nativeTurnRef.turnId,
      streamingReply: boundary.text, resumedReply: resumed.messages.at(-1).text,
      laterTurnsExcluded: true, nativeCompact: true, models: catalog.models.length, usage,
    }, null, 2));
    console.log('codex: native app-server streaming, usage, reply fork and cold resume passed');
  } finally {
    if (nativeIds.size) {
      const host = await CodexAppServer.acquire().catch(() => null);
      if (host) {
        for (const threadId of nativeIds) await host.request('thread/delete', { threadId }).catch(() => {});
        host.release();
      }
    }
    await runtime?.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
