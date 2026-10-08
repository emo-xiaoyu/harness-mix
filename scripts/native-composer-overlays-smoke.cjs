const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const bundle = await esbuild.build({
    stdin: { contents: "export * from './src/native-ui/renderer-extension/src/renderer-harness-mentions.ts'; export * from './src/native-ui/renderer-extension/src/settings/trigger.ts';", resolveDir: process.cwd() },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'Overlays', write: false,
    loader: { '.png': 'dataurl' },
  });
  const win = new BrowserWindow({ show: false, width: 1280, height: 820, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 'warning') errors.push(event.message); });
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Harness Mix composer overlay regression</title><style>
      :root { color-scheme:light; --color-background-surface:#fff; --color-text-primary:#353535; --border-token-border:#e8e8e8; --color-background-surface-hover:#f2f3f3 }
      body { margin:0; font:13px system-ui; background:var(--color-background-surface); color:var(--color-text-primary) }
      aside { position:absolute; inset:0 auto 0 0; width:260px; background:#fafafa; border-right:1px solid var(--border-token-border); padding:24px; box-sizing:border-box }
      [data-app-shell-page-header] { position:absolute; left:280px; right:20px; top:20px; height:36px; display:flex; align-items:center; justify-content:space-between }
      [data-app-shell-header-toolbar] { display:flex; align-items:center; gap:8px }
      [data-app-shell-header-toolbar] > button { background:transparent; border:0; color:inherit; font-size:20px }
      main { margin-left:280px; padding:100px 130px }
      [data-codex-composer-root] { position:absolute; left:410px; bottom:24px; width:740px; box-sizing:border-box; padding:14px; border:1px solid var(--border-token-border); border-radius:24px }
      textarea { width:100%; height:38px; box-sizing:border-box; resize:none; border:0; outline:0; background:transparent; color:inherit; font:14px system-ui }
      footer { display:flex; justify-content:space-between; padding-top:12px; opacity:.65 }
      @media(max-width:800px) { aside { display:none } [data-app-shell-page-header] { left:16px } main { margin:0; padding:90px 24px } [data-codex-composer-root] { left:16px; width:calc(100vw - 32px) } }
    </style></head><body><aside>Codex<br><br>项目<br><br>harness-mix</aside>
    <div data-app-shell-page-header><span>协作菜单</span><div data-app-shell-header-toolbar><button aria-label="聊天操作">⋯</button><button aria-label="打开侧栏">⊞</button></div></div>
    <main>输入 # 选择协作 Harness、历史会话或团队。</main>
    <div data-codex-composer-root><textarea aria-label="消息"></textarea><footer><span>＋　绕过权限 (YOLO)</span><span>Claude Code　↑</span></footer></div></body></html>`));
    await evaluate(`globalThis.__HARNESS_MIX_ICONS__ = ${JSON.stringify(require('../src/main/native/icons').getAllIconsDictionary())}; ${bundle.outputFiles[0].text}`);
    await evaluate(`(() => {
      globalThis.openedSettings = 0;
      globalThis.trigger = Overlays.installRendererSettingsHeaderTrigger({ available:true, onOpen:() => openedSettings++ });
      globalThis.mentions = Overlays.installHarnessMentions(async () => ({
        agents: [
          ['antigravity','Antigravity'], ['pi','Pi'], ['omp','Oh My Pi'], ['dsh','DeepSeek Harness'], ['claude','Claude Code'], ['codex','Codex'],
          ['opencode','OpenCode'], ['grok','Grok'], ['hermes','Hermes'], ['qoder','Qoder'], ['codebuddy','CodeBuddy'], ['zcode','ZCode'],
          ['trae','Trae'], ['kiro-cli','Kiro CLI'], ['cursor-cli','Cursor CLI'], ['cline','Cline'], ['kimi-code','Kimi Code'], ['openclaw','OpenClaw'],
        ].map(([id,name]) => ({ id,name,available:id !== 'omp',lead:true })),
        sessions:[{ id:'past',title:'历史聊天',harnessId:'pi',cwd:'C:/workspace',running:false }],
        templates:['review','builtin-bug-review','builtin-feature-squad','builtin-code-review','builtin-refactor','builtin-test-hardening','builtin-research'].map((id,index)=>({id,name:['自定义团队','缺陷评审组','功能开发小队','代码评审组','重构小队','测试加固小队','技术调研组'][index],description:'实现与审查',members:[{name:'审查员',role:'review',agent:'claude',available:true}]})), canDelegate:true,
      }));
      globalThis.editor = document.querySelector('textarea');
      editor.focus(); editor.value = '#'; editor.setSelectionRange(1,1); editor.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    const layout = await evaluate(`(() => {
      const menu=document.querySelector('[data-harness-mix-mentions]'), root=editor.closest('[data-codex-composer-root]');
      const a=menu.getBoundingClientRect(), b=root.getBoundingClientRect(), row=menu.querySelector('[role=option]'), spans=row.children[1].children;
      return { title:document.title, hidden:menu.hidden, left:a.left, width:a.width, composerLeft:b.left, composerWidth:b.width, gap:b.top-a.bottom,
        inline:Math.abs(spans[0].getBoundingClientRect().top-spans[1].getBoundingClientRect().top)<2, rowHeight:row.getBoundingClientRect().height,
        count:menu.querySelectorAll('[role=option]').length, scroll:menu.querySelector('[role=listbox]').scrollHeight>menu.querySelector('[role=listbox]').clientHeight,
        selected:getComputedStyle(row).backgroundColor, triggerCount:document.querySelectorAll('[data-harnessmix-settings-trigger]').length };
    })()`);
    assert.equal(layout.title, 'Harness Mix composer overlay regression');
    assert.equal(layout.hidden, false);
    assert.equal(layout.width, layout.composerWidth);
    assert.equal(layout.left, layout.composerLeft);
    assert.equal(layout.gap, 6);
    assert.equal(layout.inline, true);
    assert.ok(layout.rowHeight <= 32);
    assert.equal(layout.count, 18);
    assert.equal(layout.scroll, true);
    assert.equal(layout.selected, 'rgb(242, 243, 243)');
    assert.equal(layout.triggerCount, 1);
    const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mix-overlays-'));
    await fs.writeFile(path.join(screenshotDir, 'desktop-light.png'), (await win.webContents.capturePage()).toPNG());
    const teamIcons = await evaluate(`(() => {
      const menu=document.querySelector('[data-harness-mix-mentions]');menu.querySelectorAll('[role=tab]')[2].click();
      return [...menu.querySelectorAll('[role=option]')].map(row=>{const icon=row.querySelector('[data-harness-mix-team-icon] svg');return {svg:!!icon,shape:icon?.innerHTML,width:icon?.getAttribute('width'),stroke:icon?.getAttribute('stroke-width'),hidden:icon?.getAttribute('aria-hidden'),emoji:row.textContent.includes('👥')};});
    })()`);
    assert.equal(teamIcons.length, 7);
    assert.equal(new Set(teamIcons.map(icon=>icon.shape)).size, 7, 'Built-in teams and custom teams have distinct SVG glyphs');
    assert.ok(teamIcons.every(icon=>icon.svg&&icon.width==='18'&&icon.stroke==='1.75'&&icon.hidden==='true'&&!icon.emoji));
    await fs.writeFile(path.join(screenshotDir, 'team-svg-icons.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await evaluate(`(() => {
      document.querySelectorAll('[data-harness-mix-mentions] [role=option]')[1].click();
      const badge=document.querySelector('[data-harness-mix-mention-badge="template:builtin-bug-review"]');
      const ok=badge?.querySelector('svg')?.getAttribute('width')==='14'&&!badge.textContent.includes('👥');badge?.click();
      editor.focus();editor.value='#';editor.setSelectionRange(1,1);editor.dispatchEvent(new Event('input',{bubbles:true}));return ok;
    })()`), true, 'Selected team chips use the same SVG and can still be removed');
    await new Promise(resolve => setTimeout(resolve, 120));
    await evaluate(`document.querySelectorAll('[data-harness-mix-mentions] [role=tab]')[0].click()`);
    assert.equal(await evaluate(`(() => {
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
      return document.querySelector('[role=option][aria-selected=true]').textContent.includes('DeepSeek');
    })()`), true, 'Keyboard selection skips unavailable Harnesses');
    await evaluate(`(() => {
      const menu=document.querySelector('[data-harness-mix-mentions]');
      menu.querySelectorAll('[role=tab]')[1].click(); menu.querySelector('[role=option]').click();
    })()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-harness-mix-mentions]')).display`), 'none');
    assert.equal(await evaluate(`!!document.querySelector('[data-harness-mix-mention-badge="session:past"]')`), true);
    await evaluate(`(() => {
      trigger.setUpdateAvailable(true);
      const old=document.querySelector('[data-app-shell-page-header]');
      const next=old.cloneNode(true); next.querySelector('[data-harnessmix-settings-trigger]').remove(); old.replaceWith(next);
    })()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await evaluate(`(() => {
      const roots=document.querySelectorAll('[data-harnessmix-settings-trigger]'); roots[0].querySelector('button').click();
      return roots.length === 1 && roots[0].hasAttribute('data-update-available') && openedSettings === 1;
    })()`), true, 'Header replacement automatically restores a single working trigger and update state');
    await evaluate(`editor.focus(); editor.value='#'; editor.setSelectionRange(1,1); editor.dispatchEvent(new Event('input',{bubbles:true}));`);
    await new Promise(resolve => setTimeout(resolve, 120));
    win.setSize(560, 700);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await evaluate(`(() => { const r=document.querySelector('[data-harness-mix-mentions]').getBoundingClientRect(), c=editor.closest('[data-codex-composer-root]').getBoundingClientRect(); return r.left === c.left && r.width === c.width && r.right <= innerWidth-8; })()`), true);
    await fs.writeFile(path.join(screenshotDir, 'narrow-light.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate(`document.documentElement.style.cssText='color-scheme:dark;--color-background-surface:#202020;--color-text-primary:#eee;--border-token-border:#444;--color-background-surface-hover:#343434'`);
    await fs.writeFile(path.join(screenshotDir, 'narrow-dark.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-harness-mix-mentions]')).backgroundColor`), 'rgb(32, 32, 32)');
    win.setSize(1280, 820);
    await evaluate(`(() => {
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      const old=document.querySelector('[data-app-shell-page-header]');
      const header=document.createElement('header');
      header.setAttribute('data-pip-obstacle','app-shell-header');
      header.style.cssText='position:absolute;left:290px;right:0;top:44px;height:52px';
      header.innerHTML='<div data-test-id="header-shell-slot" data-app-shell-header-slot="start" style="width:6px;height:52px"></div><div data-testid="app-shell-header-context-menu-surface" style="position:absolute;inset:0"><span>原生聊天标题</span><div style="position:absolute;right:53px;top:12px;display:flex;gap:6px"><button data-native-action="chat" style="width:28px;height:28px">⋯</button><button data-native-action="summary" style="width:28px;height:28px">☷</button></div></div><div style="position:absolute;inset:0;pointer-events:none;clip-path:inset(0px 47px 0px 6px)"></div><div data-test-id="header-shell-slot" data-app-shell-header-slot="end" style="position:absolute;right:0;width:47px;height:52px"><button data-native-action="tab" style="position:absolute;left:7px;top:12px;width:28px;height:28px">＋</button></div>';
      old.replaceWith(header);
      globalThis.nativeClicks=0;
      for(const button of header.querySelectorAll('[data-native-action]'))button.addEventListener('click',()=>nativeClicks++);
    })()`);
    const checkNativeHeader = async () => {
      await new Promise(resolve => setTimeout(resolve, 120));
      const result = await evaluate(`(() => {
        const header=document.querySelector('header[data-pip-obstacle="app-shell-header"]'), root=trigger.root, box=root.getBoundingClientRect();
        const native=[...header.querySelectorAll('[data-native-action]')];
        const left=Math.min(...native.map(el=>el.getBoundingClientRect().left));
        return { count:header.querySelectorAll('[data-harnessmix-settings-trigger]').length, pinned:root.style.position,
          gap:left-box.right, left:box.left, headerLeft:header.getBoundingClientRect().left,
          reachable:native.every(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}) };
      })()`);
      assert.equal(result.count, 1);
      assert.equal(result.pinned, 'absolute');
      assert.equal(result.gap, 8, 'Trigger leaves an 8px gap before all native titlebar actions');
      assert.ok(result.left >= result.headerLeft);
      assert.equal(result.reachable, true, 'Native actions remain reachable by pointer hit testing');
    };
    await checkNativeHeader();
    await evaluate(`document.querySelector('[data-native-action="chat"]').style.width='96px'`);
    await checkNativeHeader();
    await evaluate(`for(const button of document.querySelectorAll('[data-native-action]'))button.click()`);
    assert.equal(await evaluate('nativeClicks'), 3);
    win.setSize(900, 700);
    await checkNativeHeader();
    await fs.writeFile(path.join(screenshotDir, 'native-titlebar-spacing.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate(`mentions.dispose(); trigger.dispose()`);
    assert.equal(await evaluate(`document.querySelectorAll('[data-harness-mix-mentions],[data-harnessmix-settings-trigger]').length`), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: native-style # menu geometry, inline rows, scrolling, keyboard, session chips, narrow/dark mode, header recovery, native titlebar spacing/hit testing/resize and cleanup');
    console.log('Screenshots: ' + screenshotDir);
  } finally { win.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
