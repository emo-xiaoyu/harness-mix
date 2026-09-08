const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-main-lifecycle-'));
app.setPath('userData', directory);
fs.mkdirSync(path.join(directory, 'harness-mix'));
const store = path.join(directory, 'harness-mix', 'threads.json');
fs.writeFileSync(store, JSON.stringify([{ id: 'history', harnessId: 'pi', cwd: directory, title: 'History migration',
  status: 'ready', createdAt: 1000, tools: [], messages: [
    { id: 'u', role: 'user', text: 'old question', at: 1000 },
    { id: 'a', role: 'assistant', text: 'preserved history', at: 1000, endedAt: 2000 },
  ] }]));
let closed = false, verified = false;
const close = HostRuntime.prototype.close;
HostRuntime.prototype.close = async function () {
  await new Promise(resolve => setTimeout(resolve, 200));
  await close.call(this); closed = true;
};
require('../src/main/main');

app.on('will-quit', event => {
  try {
    assert.equal(closed, true, 'main must await runtime shutdown before quitting');
    assert.equal(verified, true, 'startup and reload must pass');
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'))[0];
    assert.equal(saved.coreState.version, 1);
    assert.ok(saved.messages[1].coreItems.some(item => item.content === 'preserved history'));
    console.log('app-lifecycle: real main/preload/Renderer startup, old history migration, reload, awaited shutdown passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  event.preventDefault();
  app.exit(process.exitCode ?? 0);
});

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 300; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (win && !win.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(win);
    const check = async () => {
      for (let i = 0; i < 100; i++) {
        if (await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-thread="history"]'))`)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-thread="history"]').click(); document.querySelector('#conversation').textContent.includes('preserved history')`), true);
    };
    await check();
    await win.webContents.executeJavaScript(`(() => {
      const group = [...document.querySelectorAll('#projects details')].find(el => el.dataset.path === ${JSON.stringify(directory)});
      group.querySelector('[data-project-menu]').click();
      document.querySelector('.project-menu [data-action=pin]').click();
      group.querySelector('[data-project-menu]').click();
      document.querySelector('.project-menu [data-action=edit]').click();
      document.querySelector('.project-editor [name=name]').value = '我的工作区';
      document.querySelector('.project-editor').requestSubmit();
      group.querySelector('[data-project-new]').click();
      if (document.querySelector('#cwd').value !== ${JSON.stringify(directory)}) throw Error('project draft directory');
    })()`);
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    await check();
    assert.equal(await win.webContents.executeJavaScript(`(() => {
      const group = document.querySelector('#projects details');
      return group.dataset.path === ${JSON.stringify(directory)} && group.querySelector('.project-name').textContent === '我的工作区' && Boolean(group.querySelector('.project-pin'));
    })()`), true, 'project name and pinned order survive reload');
    await win.webContents.executeJavaScript(`document.querySelector('#projects details [data-project-menu]').click()`);
    fs.mkdirSync('output/playwright', { recursive: true });
    fs.writeFileSync('output/playwright/project-actions.png', (await win.webContents.capturePage()).toPNG());
    verified = true;
    win.close();
  } catch (error) { console.error(error); process.exitCode = 1; app.quit(); }
});
