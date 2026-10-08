const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const bundle = await esbuild.build({
    stdin: { contents: "export * from './src/native-ui/renderer-extension/src/settings/skin-runtime.ts';", resolveDir: process.cwd() },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'Skins', write: false, loader: { '.webp': 'dataurl' },
  });
  const screenshots = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skin-compatibility-'));
  const win = new BrowserWindow({ show: false, width: 1280, height: 820, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  let cases = 0;
  try {
    for (const layout of ['legacy-fade', 'content-parent-fade']) {
      const content = '<div data-app-shell-focus-area="main"><div data-app-action-timeline-scroll><div data-user-message-bubble><p data-markdown-text-tone="user-message">皮肤切换后仍能看见用户消息</p></div><article data-response-annotation-conversation><p>聊天记录、工具状态和输入框必须可见。</p><button id="tool">展开工具输出</button><pre id="output" hidden>原生工具输出</pre><table><tbody><tr><td>可读表格</td></tr></tbody></table><div class="spacer"></div></article></div><div data-thread-scroll-footer><div data-codex-composer-root><div class="composer-surface-chrome" data-composer-layout="multiline"><textarea aria-label="消息"></textarea><button id="send">发送</button></div></div></div></div>';
      const fade = layout === 'legacy-fade'
        ? '<div data-app-shell-main-content-top-fade="full-bleed" class="decoration" aria-hidden="true"></div>' + content
        : '<div data-app-shell-main-content-top-fade="visible"><div aria-hidden="true" class="_MainContentTopFade_fixture decoration"></div>' + content + '</div>';
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><title>Native skin compatibility</title><style>
        *{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{font:14px system-ui;color:#222;background:white}#root{display:flex}.app-shell-left-panel{width:220px;flex:none;background:#fafafa;padding:12px}main{position:relative;flex:1;min-width:0;display:flex;flex-direction:column}header{height:52px;flex:none;padding:12px}.decoration{position:absolute;inset:0 0 auto;height:40px;pointer-events:none;background:linear-gradient(white,transparent)}[data-app-shell-main-content-top-fade=visible]{position:relative;flex:1;min-height:0;display:flex}[data-app-shell-focus-area=main]{display:flex;flex:1;min-height:0;flex-direction:column}[data-app-action-timeline-scroll]{flex:1;min-height:0;overflow:auto;padding:24px}[data-user-message-bubble]{max-width:420px;margin-left:auto;padding:12px;border-radius:16px}[data-response-annotation-conversation]{max-width:740px;margin:24px auto}.spacer{height:900px}[data-thread-scroll-footer]{padding:16px}[data-codex-composer-root]{max-width:740px;margin:auto}.composer-surface-chrome{padding:12px;border-radius:20px}textarea{display:block;width:100%;height:56px;color:inherit;background:transparent;border:0}button{color:inherit}#send{float:right}table{width:100%}
      </style></head><body><div id="root"><aside class="app-shell-left-panel"><button aria-haspopup="menu" aria-label="Codex"><span>Codex</span></button><p>项目</p></aside><main class="_MainContentSurface_fixture" data-app-shell-main-surface="default"><header data-pip-obstacle="app-shell-header"><div data-testid="app-shell-header-context-menu-surface">原生聊天操作</div></header>${fade}</main></div></body></html>`));
      await evaluate(bundle.outputFiles[0].text);
      await evaluate(`(() => {
        globalThis.editor=document.querySelector('textarea');editor.value='保留正在编辑的草稿';editor.setSelectionRange(2,5);
        globalThis.sent=0;globalThis.toolClicks=0;
        document.querySelector('#send').addEventListener('click',()=>sent++);
        document.querySelector('#tool').addEventListener('click',()=>{toolClicks++;document.querySelector('#output').hidden=!document.querySelector('#output').hidden;});
        globalThis.originalNodes=[...document.querySelectorAll('#root *')];
        globalThis.nativeGeometry=(()=>{const r=document.querySelector('main').getBoundingClientRect();return {width:r.width,height:r.height};})();
      })()`);
      const ids = await evaluate('Skins.RENDERER_SKIN_IDS');
      for (const id of ids) {
        await evaluate(`Skins.applyRendererSkin(${JSON.stringify(id)},document,null)`);
        const state = await evaluate(`(() => {
          const visible=el=>{for(let n=el;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<.99)return false;}const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
          const r=document.querySelector('main').getBoundingClientRect();
          const send=document.querySelector('#send'),b=send.getBoundingClientRect();
          return {visible:[editor,document.querySelector('article'),document.querySelector('[data-user-message-bubble]')].every(visible),
            reachable:send.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)),
            draft:editor.value,selection:[editor.selectionStart,editor.selectionEnd],sameNodes:originalNodes.every(n=>n.isConnected),
            geometry:{width:r.width,height:r.height},nativeGeometry};
        })()`);
        assert.equal(state.visible, true, `${layout}/${id}: transcript and composer remain visible`);
        assert.equal(state.reachable, true, `${layout}/${id}: composer remains reachable`);
        assert.equal(state.draft, '保留正在编辑的草稿');
        assert.deepEqual(state.selection, [2, 5]);
        assert.equal(state.sameNodes, true);
        assert.deepEqual(state.geometry, state.nativeGeometry);
        const interactions = await evaluate(`(() => {
          document.querySelector('#send').click();document.querySelector('#tool').click();
          const shown=!document.querySelector('#output').hidden;document.querySelector('#tool').click();
          const scroll=document.querySelector('[data-app-action-timeline-scroll]');scroll.scrollTop=150;const scrolled=scroll.scrollTop>0;scroll.scrollTop=0;
          return {shown,scrolled,sent,toolClicks};
        })()`);
        assert.equal(interactions.shown, true);
        assert.equal(interactions.scrolled, true);
        cases++;
        if (layout === 'content-parent-fade' && ['miku-488137', 'genshin-night', 'retro-qq', 'palette-nord-dark'].includes(id)) {
          await fs.writeFile(path.join(screenshots, id + '.png'), (await win.webContents.capturePage()).toPNG());
        }
      }
      assert.equal(await evaluate('sent'), ids.length);
      assert.equal(await evaluate('toolClicks'), ids.length * 2);
      win.setSize(760, 700);
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const id of ids) {
        const visible = await evaluate(`(() => { Skins.applyRendererSkin(${JSON.stringify(id)},document,null);const r=editor.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth; })()`);
        assert.equal(visible, true, `${layout}/${id}: narrow composer is not clipped`);
        cases++;
      }
      await evaluate('Skins.applyRendererSkin("native",document,null)');
      assert.equal(await evaluate('document.getElementById(Skins.RENDERER_SKIN_STYLE_ID) === null && !document.documentElement.hasAttribute(Skins.RENDERER_SKIN_ATTRIBUTE)'), true);
      win.setSize(1280, 820);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS: ${cases} skin/layout/viewport cases; native DOM, draft/caret, message/composer visibility, scroll, tool/send clicks and native restore`);
    console.log('Screenshots: ' + screenshots);
  } finally { win.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
