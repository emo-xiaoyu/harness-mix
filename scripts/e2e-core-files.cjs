const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { ParityObserver } = require('./support/parity-observer.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  for (const harnessId of process.argv[2] ? [process.argv[2]] : ['pi', 'claude', 'dsh']) {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), `hm-core-files-${harnessId}-`));
    const root = path.join(data, 'workspace'); await fs.mkdir(root);
    const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: data });
    try {
      await rt.initialize();
      const thread = await rt.createThread({ harnessId, cwd: root, options: { permissionMode: 'acceptEdits' } });
      assert.notEqual(thread.status, 'error', thread.error);
      let ended = false, sendError;
      const sending = rt.send(thread.id, 'Only in this temporary working directory: use your native file editing tool to create acceptance.txt containing exactly HARNESS-CORE-OK. Do not access other folders. Then reply done.')
        .catch(error => { sendError = error; }).finally(() => { ended = true; });
      for (let i = 0; i < 600; i++) {
        for (const item of [...thread.interactions ?? []]) {
          const allow = item.options?.find(option => option.kind === 'allow_once');
          if (!allow) throw new Error('No one-time native file-edit approval option');
          await rt.respondApproval(thread.id, item.requestId, { optionId: allow.id });
        }
        if (ended && !rt.execution.isRunning(thread.id) && !thread.reviewPending) break;
        await sleep(250);
      }
      assert.equal(ended, true, 'native send timed out'); await sending;
      if (sendError) throw sendError;
      assert.equal(thread.status, 'ready', thread.error);
      assert.equal(await fs.readFile(path.join(root, 'acceptance.txt'), 'utf8').then(text => text.trim()), 'HARNESS-CORE-OK');
      const message = thread.messages.at(-1);
      const review = await rt.readReview(thread, message);
      const file = review.files.find(item => item.path === 'acceptance.txt');
      assert.ok(file); assert.equal(file.type, 'file_change');
      assert.ok(file.after.includes('HARNESS-CORE-OK'));
      assert.ok(message.coreItems.some(item => item.type === 'tool_call'));
      assert.ok((await rt.readReview(thread, message, file.path)).rows.some(row => row.kind === 'add'));
      const report = rt.shadowReport();
      assert.ok(report.comparisons > 0); assert.deepEqual(report.errors, []); assert.deepEqual(report.mismatches, []);
      await rt.undoFile(thread.id, message.id, file.path);
      await assert.rejects(fs.access(path.join(root, file.path)));
      assert.ok(message.coreReview.files.find(item => item.path === file.path).undone);
      await fs.mkdir('output/verification', { recursive: true });
      await fs.writeFile(`output/verification/core-files-${harnessId}.json`, JSON.stringify({ harnessId, at: new Date().toISOString(), source: file.source, nativeRef: file.nativeRef, fileVerified: true, undoVerified: true, report }, null, 2));
      console.log(`${harnessId}: real file edit -> ${file.source} FileChange -> diff -> undo; zero parity mismatch PASSED`);
    } finally { await rt.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
