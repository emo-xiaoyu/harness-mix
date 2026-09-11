const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const bundle = await require('esbuild').build({ stdin: { contents: `export * from './src/native-ui/renderer-extension/src/renderer-harness-mentions.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Mentions', write: false });
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="font:16px system-ui;padding:32px"><h2>Harness Mix · 多 Agent 协作</h2><p>主任务负责分工、收集结果与验证。</p><div data-codex-composer-root style="position:absolute;bottom:50px;width:750px"><textarea style="width:100%;height:90px;font:16px system-ui" placeholder="输入 @ 选择协作 Harness"></textarea><div contenteditable="true" style="border:1px solid gray;padding:16px">你负责后端，</div></div></body>'));
    await win.webContents.executeJavaScript(`globalThis.__HARNESS_MIX_ICONS__ = ${JSON.stringify(require('../src/main/native/icons').getAllIconsDictionary())}`);
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const api = Mentions.installHarnessMentions(async () => ({agents:[{id:'pi',name:'Pi',available:true,lead:true},{id:'claude',name:'Claude Code',available:true,lead:true},{id:'dsh',name:'DeepSeek Harness',available:false,lead:false}],sessions:[{id:'c2Vzc2lvbg',title:'旧版登录审查',harnessId:'claude',cwd:'E:/project',running:false}]}));
      const editor = document.querySelector('textarea');
      editor.focus(); editor.value = '你负责后端， @cl'; editor.setSelectionRange(editor.value.length,editor.value.length); editor.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,30));
      const filtered = document.querySelectorAll('[data-harness-mix-mentions] [role="option"]').length;
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      const text = editor.value;
      const badge = document.querySelector('[data-harness-mix-selected-mentions] img')?.dataset.harnessMixIcon;
      const rich = document.querySelector('[contenteditable]'); rich.focus();
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(rich); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('insertText',false,' @pi');
      await new Promise(r=>setTimeout(r,30));
      rich.textContent = rich.textContent; // Native editor redraw replaces the original Range nodes.
      document.querySelector('[data-harness-mix-mentions] [role="option"]').click();
      const richText = rich.textContent;
      editor.focus(); editor.value='@'; editor.setSelectionRange(1,1); editor.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,30));
      globalThis.mentionSmoke = api;
      const tabs = document.querySelectorAll('[data-harness-mix-mentions] [role=tab]').length;
      if (tabs !== 2) throw new Error('Missing Agents/session tabs');
      const icons = document.querySelectorAll('[data-harness-mix-mentions] img').length;
      const disabled = document.querySelectorAll('[data-harness-mix-mentions] [role="option"]:disabled').length;
      editor.value='@旧';editor.setSelectionRange(2,2);editor.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,30));
      document.querySelector('[data-harness-mix-mentions] [role="option"]').click();
      const sessionBadge=[...document.querySelectorAll('[data-harness-mix-selected-mentions] span')].some(b=>b.title.startsWith('历史会话'));
      return {filtered,text,richText,badge,icons,disabled,sessionText:editor.value,sessionBadge};
    })()`);
    assert.equal(result.filtered, 1); assert.equal(result.text, '你负责后端， @claude ');
    assert.match(result.richText, /^你负责后端， @pi\s$/); assert.equal(result.disabled, 1);
    assert.equal(result.badge, 'harnesses/claude'); assert.equal(result.icons, 3); assert.equal(result.disabled, 1);
    assert.match(result.sessionText, /harness-mix:\/\/session\/c2Vzc2lvbg/); assert.equal(result.sessionBadge, true);
    const out = path.resolve('output/collaboration-ui'); await fs.mkdir(out, { recursive: true });
    await new Promise(r => setTimeout(r,100));
    await fs.writeFile(path.join(out, 'mentions.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('mentionSmoke.dispose()');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-harness-mix-mentions]").length'), 0);
    console.log('PASS: Electron native composer @ Harness/session icons, badges, keyboard selection, textarea/rich text and cleanup');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
