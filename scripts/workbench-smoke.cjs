const { coreFixture } = require('./support/core-fixture.cjs');
const { ParityObserver } = require('./support/parity-observer.cjs');
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { HostRuntime } = require('../src/main/host/runtime');
const { registerWorkspace } = require('../src/main/workspace/ipc');
const data = mkdtempSync(path.join(os.tmpdir(), 'hm-workbench-ui-'));
app.setPath('userData', path.join(data, 'electron'));
app.whenReady().then(async () => {
  let terminal;
  try {
    const root = path.join(data, 'project'); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'app.js'), '// User existing work\nconst message = "before";\n');
    const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: data });
    const reviewId = await rt.reviews.begin(root);
    await fs.writeFile(path.join(root, 'app.js'), '// User existing work\nconst message = "after";\nconsole.log(message);\n');
    const review = undefined;
    rt.threads = [{ id: 'ui-thread', harnessId: 'pi', cwd: root, title: '完成态与文件审查', status: 'ready', tools: [{ id: 'tool', messageId: 'reply', title: 'edit', state: 'done', input: 'app.js', output: 'Updated file' }], messages: [
      { id: 'user', role: 'user', text: '完善任务完成态，并接入文件审查。' },
      { id: 'reply', role: 'assistant', text: '任务已完成。', at: Date.now() - 153000, endedAt: Date.now(), stopReason: 'completed', reviewId, review, items: [
        { id: 'thought', kind: 'thinking', text: '检查当前文件与已有用户修改。', at: 1000, endedAt: 2000 },
        { id: 'progress', kind: 'text', text: '先检查项目结构，再修改显示逻辑。' },
        { id: 'tool-item', kind: 'tool', toolId: 'tool' },
        { id: 'final', kind: 'text', text: '已完成任务展示调整。\n\n- 中间过程自动折叠。\n- 文件变更可在右侧逐行审查。\n- 撤回会校验后续修改，保护已有工作。' },
      ] },
    ] }];
    ipcMain.handle('runtime:snapshot', () => rt.snapshot());
    terminal = registerWorkspace({ ipcMain, runtime: rt, roots: new Set([root]), emit: e => win.webContents.send('runtime:event', e) });
    const win = new BrowserWindow({ width: 1440, height: 960, show: true, webPreferences: { preload: path.resolve('src/main/preload.js'), contextIsolation: true, sandbox: true } });
    rt.subscribe(e => win.webContents.send('runtime:event', e));
    const errors = [];
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
    rt.threads[0].messages.at(-1).streaming = true; rt.threads[0].status = 'working';
    rt.threads = rt.threads.map(coreFixture);
    rt.core.restore(rt.threads[0].coreState);
    rt.execution.lastTurns.set('ui-thread', rt.threads[0].messages.at(-1).coreTurnId);
    rt.execution.sync(rt.threads[0]);
    await win.loadFile(path.resolve('src/renderer/index.html'));
    const run = code => win.webContents.executeJavaScript(`(async()=>{const $=s=>document.querySelector(s);const check=(v,m)=>{if(!v)throw Error(m)};const wait=()=>new Promise(r=>setTimeout(r,200));${code}})()`).catch(error => { throw new Error(error.message + '\nCHECK: ' + code); });
    const reply = rt.threads[0].messages.at(-1);
    reply.streaming = true; rt.threads[0].status = 'working';
    rt.startReviewUpdates(rt.threads[0], reply);
    await run(`for(let i=0;i<30&&!$('[data-thread="ui-thread"]');i++)await wait();$('[data-thread="ui-thread"]').click();await wait();check(!$('.turn-process').open,'live collapsed');check($('.progress-message').checkVisibility(),'progress text visible');check(!$('.reasoning-text').checkVisibility(),'reasoning details hidden');check(!$('[data-tab="__draft"]'),'no draft tab');$('.turn-process summary').click();check($('.turn-process').open,'live expands');$('.activity summary').click();check($('.activity').open,'thinking expands');$('.turn-process summary').click();$('[data-live-review]').click();await wait();check($('.wb-code .add'),'live real diff');check($('.wb-undo').disabled,'live undo disabled');check($('.wb-tree-file').textContent.includes('app.js'),'changed file list');document.activeElement.blur();`);
    await fs.writeFile(path.join(root, 'live.txt'), 'created while running\n');
    await run(`for(let i=0;i<40&&!$('.wb-tree-files').textContent.includes('live.txt');i++)await wait();check($('.wb-tree-files').textContent.includes('live.txt'),'new file auto appears');document.querySelectorAll('.wb-tree-file')[1].click();await wait();check($('.wb-code').textContent.includes('created while running'),'select live file diff');const search=$('.wb-change-tree input');search.value='app';search.dispatchEvent(new Event('input'));check(document.querySelectorAll('.wb-tree-file:not([hidden])').length===1,'file filter');search.value='';search.dispatchEvent(new Event('input'));search.blur();`);
    await fs.mkdir('output/playwright', { recursive: true });
    await fs.writeFile('output/playwright/live-review-sidebar.png', (await win.webContents.capturePage()).toPNG());
    await run(`$('.turn-process summary').click();check($('.activity').open,'nested disclosure survives refresh');$('.wb-close').click();$('#toggleSide').click();await wait();check($('.wb-code .add'),'live panel reopens');`);
    await fs.writeFile('output/playwright/live-process-expanded.png', (await win.webContents.capturePage()).toPNG());
    win.setSize(1040, 760);
    await run(`await wait();check(document.documentElement.scrollWidth<=innerWidth,'1040px layout fits');check($('.wb-change-tree input').getBoundingClientRect().right<=innerWidth,'file filter fits');`);
    await fs.writeFile('output/playwright/live-review-1040.png', (await win.webContents.capturePage()).toPNG());
    win.setSize(1440, 960);
    await run(`$('.turn-process summary').click();`);
    rt.core.dispatch({ threadId: 'ui-thread', turnId: reply.coreTurnId, itemId: reply.coreItems.findLast(i => i.type === 'agent_message').id, type: 'item.updated', payload: { phase: 'final' } });
    rt.core.dispatch({ threadId: 'ui-thread', turnId: reply.coreTurnId, type: 'turn.completed', timestamp: reply.at + 153000 });
    rt.execution.sync(rt.threads[0]);
    reply.review = await rt.reviews.finish(reviewId);
    win.webContents.send('runtime:event', { type: 'snapshot' });
    await run(`await wait();await wait();$('.wb-close').click();`);
    await run(`for(let i=0;i<30&&!$('[data-thread="ui-thread"]');i++)await wait();$('[data-thread="ui-thread"]').click();await wait();check(!$('.turn-process').open,'process collapsed');check($('.turn-header').textContent.includes('2分 33秒'),'total duration above final');check($('.final-answer').textContent.includes('已完成'),'final visible');check($('.change-card'),'change card');$('.turn-process summary').click();check($('.turn-process').open,'process expands');$('.turn-process summary').click();$('.change-heading button').click();await wait();check($('.workbench').hidden===false,'review panel opens');check($('.wb-code .add'),'added lines');check($('.wb-code .remove'),'removed lines');check(document.documentElement.scrollWidth<=innerWidth,'no overflow');`);
    await fs.mkdir('output/playwright', { recursive: true });
    await fs.writeFile('output/playwright/review-sidebar.png', (await win.webContents.capturePage()).toPNG());
    await run(`$('.wb-undo').click();await wait();check($('.modal'),'undo confirmation');$('[data-modal-ok]').click();await wait();await wait();check($('.wb-undo').disabled,'undo reflected');`);
    assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), '// User existing work\nconst message = "before";\n');
    await run(`$('[data-wb="files"]').click();await wait();check($('.wb-file-list').textContent.includes('app.js'),'file tree');$('.wb-file-list button').click();await wait();check($('.wb-file-preview').textContent.includes('before'),'file preview');$('[data-wb="terminal"]').click();await wait();$('.terminal-form textarea').value="Write-Output 'ui-terminal-ok'";$('.terminal-form').requestSubmit();for(let i=0;i<30&&!$('.terminal-output').textContent.includes('[退出码 0]');i++)await wait();check($('.terminal-output').textContent.includes('ui-terminal-ok'),'real terminal output');check($('.terminal-output').textContent.includes('[退出码 0]'),'real terminal settled');$('.wb-close').click();check($('.workbench').hidden,'panel closes');$('#toggleSide').click();await wait();check($('.terminal-output').textContent.includes('ui-terminal-ok'),'terminal survives panel reopen');`);
    await fs.writeFile('output/playwright/terminal-sidebar.png', (await win.webContents.capturePage()).toPNG());
    const grip = await run(`const r=$('.wb-resize').getBoundingClientRect();return {x:Math.round(r.x+3),y:Math.round(r.y+200),width:$('.workbench').getBoundingClientRect().width};`);
    win.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x, y: grip.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: grip.x, y: grip.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x - 100, y: grip.y, modifiers: ['leftButtonDown'] });
    await new Promise(r => setTimeout(r, 100));
    win.webContents.sendInputEvent({ type: 'mouseUp', x: grip.x - 100, y: grip.y, button: 'left', clickCount: 1 });
    await run(`await wait();check($('.workbench').getBoundingClientRect().width>${grip.width}+50,'real pointer drag resizes panel');const width=$('.workbench').getBoundingClientRect().width;$('.wb-close').click();$('#toggleSide').click();await wait();check(Math.abs($('.workbench').getBoundingClientRect().width-width)<2,'width survives reopen');$('[data-wb="git"]').click();await wait();check($('.wb-content').textContent.includes('初始化 Git'),'non-repo init entry');$('.wb-content>button').click();for(let i=0;i<30&&!$('.git-files');i++)await wait();check($('.git-files'),'Git init UI works');`);
    const execGit = args => require('node:child_process').execFileSync('git', args, { cwd: root, windowsHide: true });
    execGit(['config', 'user.name', 'UI Test']); execGit(['config', 'user.email', 'ui@example.invalid']);
    await run(`$('.git-action').click();for(let i=0;i<30&&!$('.git-files').textContent.includes('取消暂存');i++)await wait();check($('.git-files').textContent.includes('取消暂存'),'stage via IPC');$('.git-path').click();await wait();check($('.git-preview').textContent.includes('before'),'staged diff');$('.git-commit textarea').value='UI verified commit';$('.git-commit').requestSubmit();await wait();$('[data-modal-ok]').click();for(let i=0;i<30&&!$('.git-history').textContent.includes('UI verified commit');i++)await wait();check($('.git-history').textContent.includes('UI verified commit'),'commit history updated');`);
    await fs.writeFile('output/playwright/git-sidebar.png', (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    await terminal.close();
    console.log('completed turn collapse, total duration, real review/file IPC, confirmed undo, file preview, real terminal, panel reopen, overflow checks passed');
    app.exit(0);
  } catch (e) { console.error(e); await terminal?.close(); app.exit(1); }
});
