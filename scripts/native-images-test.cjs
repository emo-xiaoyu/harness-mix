const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol, routeModel } = require('../src/main/native/protocol');
const { prepareInput } = require('../src/main/native/input');

async function main() {
  const root = path.resolve('output/native-images', String(Date.now()));
  await fs.mkdir(root, { recursive: true });
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const imagePath = path.join(root, '图片.png');
  await fs.writeFile(imagePath, Buffer.from(data, 'base64'));
  const local = { type: 'localImage', path: imagePath };
  const inline = { type: 'image', url: `data:image/png;base64,${data}` };
  assert.equal((await prepareInput([local], root)).attachments[0].data, data);
  await assert.rejects(prepareInput([{ type: 'localImage', path: path.join(root, 'missing.png') }]), /ENOENT/);
  await assert.rejects(prepareInput([{ type: 'image', url: 'bad' }]), /base64/);
  await assert.rejects(prepareInput(Array(7).fill(inline)), /6/);
  await assert.rejects(prepareInput([{ type: 'file' }]), /Unsupported/);
  const runtime = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await runtime.store.load();
  const events = [], received = [];
  const bridge = new NativeProtocol(runtime, event => events.push(event));
  try {
    for (const id of ['pi', 'claude', 'dsh']) {
      runtime.status[id] = { available: true };
      runtime.adapters.set(id, {
        manifest: { id, name: id, capabilities: { attachments: true } },
        async open({ emit }) { return { emit }; }, async close() {},
        async describe() { return { models: [] }; },
        async send(session, text, hooks, attachments) {
          received.push({ id, text, attachments });
          hooks.emit({ kind: 'completed', finalAnswer: true });
        },
      });
      const { thread } = await bridge.request('thread/start', { cwd: root, model: routeModel(id === 'claude' ? 'claude-code' : id === 'dsh' ? 'deepseek-harness' : id) });
      const { turn } = await bridge.request('turn/start', { threadId: thread.id, input: id === 'pi' ? [local] : [{ type: 'text', text: 'describe' }, inline] });
      for (let n = 0; n < 200 && (runtime.execution.isRunning(thread.id) || runtime.threads.find(t => t.id === thread.id).reviewPending); n++) await new Promise(r => setTimeout(r, 20));
      assert.equal(received.at(-1).attachments.images[0].data, data);
      assert.equal(received.at(-1).text, id === 'pi' ? '' : 'describe');
      const history = await bridge.request('thread/read', { threadId: thread.id });
      assert.equal(history.thread.turns[0].items[0].content[1].url, inline.url);
      assert.ok(events.some(e => e.method === 'item/completed' && e.params.turnId === turn.id && e.params.item.content?.[1]?.url === inline.url));
    }
    const stored = await runtime.store.load();
    const restored = new HostRuntime({ dataDirectory: path.join(root, 'data') });
    restored.threads = stored;
    for (const thread of stored) restored.execution.threadCreated(thread);
    const replay = new NativeProtocol(restored, () => {});
    assert.equal(replay.projectThread(stored[0]).turns[0].items[0].content[1].url, inline.url);
    replay.unsubscribe();
    console.log('PASS: local/inline images, image-only turns, three adapter dispatches, notifications and persisted history; invalid inputs rejected');
  } finally { bridge.unsubscribe(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
