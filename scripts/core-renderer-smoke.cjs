const { ParityObserver } = require('./support/parity-observer.cjs');
// Real Electron + real HostRuntime/Core + recorded native events; no model calls.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { HostRuntime } = require('../src/main/host/runtime');
const { registerWorkspace } = require('../src/main/workspace/ipc');
const projectors = {
  pi: require('../src/main/adapters/pi').project,
  claude: require('../src/main/adapters/claude').projectEvent,
  dsh: require('../src/main/adapters/dsh').projectWireEvent,
};
const directory = mkdtempSync(path.join(os.tmpdir(), 'hm-core-ui-'));
app.setPath('userData', path.join(directory, 'electron'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let rt, terminal, win;
  try {
    const root = path.join(directory, 'project'); await fs.mkdir(root);
    rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: directory }); await rt.store.load();
    const emitters = new Map();
    for (const id of Object.keys(projectors)) {
      rt.adapters.set(id, {
        manifest: { id, name: id, capabilities: {} },
        async open({ thread, emit }) { emitters.set(thread.id, emit); return {}; },
        async send() {}, async cancel() {}, async close() {}, async respond() {},
      });
      rt.status[id] = { available: true };
    }
    ipcMain.handle('runtime:snapshot', () => rt.snapshot());
    ipcMain.handle('approval:respond', (_, input) => rt.respondApproval(input.threadId, input.requestId, input.response));
    terminal = registerWorkspace({ ipcMain, runtime: rt, roots: new Set([root]), emit: event => win?.webContents.send('runtime:event', event) });
    win = new BrowserWindow({ width: 1440, height: 960, show: true, webPreferences: { backgroundThrottling: false, preload: path.resolve('src/main/preload.js'), contextIsolation: true, sandbox: true } });
    rt.subscribe(event => { if (!win.isDestroyed()) win.webContents.send('runtime:event', event); });
    await win.loadFile(path.resolve('src/renderer/index.html'));
    const run = code => win.webContents.executeJavaScript(`(async()=>{const $=s=>document.querySelector(s);const check=(v,m)=>{if(!v)throw Error(m)};${code}})()`);
    async function refresh() { win.webContents.send('runtime:event', { type: 'core/thread-updated' }); await sleep(300); }
    await fs.mkdir('output/playwright', { recursive: true });
    for (const [harnessId, project] of Object.entries(projectors)) {
      const thread = await rt.createThread({ harnessId, cwd: root, title: `${harnessId} Core UI` });
      await rt.send(thread.id, 'replay');
      const emit = emitters.get(thread.id);
      await refresh();
      await run(`$('[data-thread="${thread.id}"]').click();check($('.turn-header.is-live'),'Core running header');`);
      const events = (await fs.readFile(`fixtures/${harnessId}/tool-call.jsonl`, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      for (const event of events) for (const mapped of [project(event)].flat().filter(Boolean)) emit(mapped);
      if (rt.execution.lastTurn(thread.id).status === 'running') emit({ kind: 'completed', finalAnswer: true });
      for (let i = 0; i < 100 && (thread.status === 'working' || thread.reviewPending); i++) await sleep(20);
      assert.equal(thread.messages.at(-1).coreTurn.status, 'completed');
      assert.deepEqual(rt.shadowReport().errors, []);
      assert.deepEqual(rt.shadowReport().mismatches, []);
      const reply = thread.messages.at(-1);
      const expected = reply.coreItems.filter(i => i.phase === 'final').map(i => i.content).join('');
      assert.ok(expected);
      // Deliberately corrupt only legacy presentation: UI must still use Core.
      reply.text = 'LEGACY-POISON'; reply.items = [{ kind: 'text', text: 'LEGACY-POISON' }];
      reply.at = 1; reply.endedAt = 9999999;
      await refresh();
      await run(`check(!$('.message.assistant').textContent.includes('LEGACY-POISON'),'legacy content ignored');check($('.final-answer'),'Core final');check(!$('.turn-header.is-live'),'Core completed');check($('#taskStatus').textContent.includes('准备就绪'),'top status from Core');check($('#stop').hidden,'stop follows Core');check($('.turn-history'),'completed process');$('.turn-history summary').click();check($('.turn-history').open,'completed process opens');`);
      await refresh();
      await run(`check($('.turn-history').open,'disclosure preserved');check(document.documentElement.scrollWidth<=innerWidth,'desktop width');`);
      await run(`check($('#tabs [aria-selected="true"]').textContent.includes('${harnessId}'),'selected harness');await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
      await sleep(200);
      await fs.writeFile(`output/playwright/core-${harnessId}.png`, (await win.webContents.capturePage()).toPNG());
      win.setSize(1040, 760); await sleep(100);
      await run(`check(document.documentElement.scrollWidth<=innerWidth,'1040 width');`);
      win.setSize(1440, 960);
      console.log(`${harnessId}: native replay -> Core -> real Renderer, tools/final/timing/disclosure passed`);
    }
    const thread = rt.threads[0], emit = emitters.get(thread.id);
    await rt.send(thread.id, 'wait');
    emit({ kind: 'plan', entries: [{ content: 'Core plan step', status: 'in_progress' }] });
    await fs.writeFile(path.join(root, 'core-ui.txt'), 'Core file review');
    emit({ kind: 'approval', requestId: 'question', method: 'input', title: 'Your answer?' });
    thread.pendingApprovals = [{ requestId: 'poison', title: 'LEGACY-REQUEST' }];
    await refresh();
    await run(`check($('.turn-header.is-live').textContent.includes('等待你的回答'),'Core waiting');`);
    await run(`check($('.approval').textContent.includes('Your answer?'),'Core request visible');check(!$('.approval').textContent.includes('LEGACY-REQUEST'),'legacy request ignored');check([...document.querySelectorAll('.message.assistant')].at(-1).textContent.includes('执行计划'),'Core plan visible');$('.approval input').value='OK';$('.approval [data-approval-submit]').click();`);
    for (let i=0;i<100&&rt.execution.lastTurn(thread.id).status==='waiting_interaction';i++) await sleep(20);
    assert.equal(rt.execution.lastTurn(thread.id).status, 'running');
    await rt.cancel(thread.id);
    for (let i=0;i<100&&(thread.status==='working'||thread.reviewPending);i++) await sleep(20);
    await refresh();
    const messageId = thread.messages.at(-1).id;
    await run(`const review=await window.harnessMix.review({threadId:'${thread.id}',messageId:'${messageId}'});check(review.files.some(f=>f.type==='file_change'&&f.path==='core-ui.txt'),'Core FileChange IPC');`);
    await run(`check([...document.querySelectorAll('.turn-history')].at(-1).textContent.includes('已停止'),'Core cancelled');`);
    await run(`await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
    await fs.writeFile('output/playwright/core-services.png', (await win.webContents.capturePage()).toPNG());
    await win.reload(); await sleep(300);
    await run(`$('[data-thread="${thread.id}"]').click();check([...document.querySelectorAll('.turn-history')].at(-1).textContent.includes('已停止'),'reload preserves Core');`);
    console.log('core-renderer: waiting, cancelled, reload and layout passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await terminal?.close(); await rt?.close(); win?.destroy(); app.exit(process.exitCode ?? 0); }
});
