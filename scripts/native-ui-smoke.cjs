const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { getAllIconsDictionary, MODEL_FAMILIES } = require('../src/main/native/icons');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const out = path.resolve('output/native-ui-smoke');
  fs.mkdirSync(out, { recursive: true });
  const icons = getAllIconsDictionary();
  icons.harnesses['claude-code'] = icons.harnesses.claude;
  icons.harnesses['deepseek-harness'] = icons.harnesses.dsh;
  const bundle = await esbuild.build({ stdin: { contents: `export { createRendererAgentIcon } from './src/native-ui/renderer-extension/src/renderer-agent-icon.ts'; export { mountRendererAgentPicker, renderRendererAgentPicker } from './src/native-ui/renderer-extension/src/renderer-agent-picker.ts'; export { mountRendererModelPicker, renderRendererModelPicker } from './src/native-ui/renderer-extension/src/renderer-model-picker.ts'; export { mountRendererHarnessHandoff } from './src/native-ui/renderer-extension/src/renderer-harness-handoff.ts'; export { restoredThreadOwnership } from './src/native-ui/renderer-extension/src/renderer-binding-probe.ts'; export { installRendererSidebarAgentIcons } from './src/native-ui/renderer-extension/src/renderer-sidebar-agent-icons.ts'; export { installRendererSettingsLifecycle } from './src/native-ui/renderer-extension/src/harness-mix-settings.ts'; export { createAccountsSettingsPage } from './src/native-ui/renderer-extension/src/settings/accounts-page.ts'; export { createStorageSettingsPage } from './src/native-ui/renderer-extension/src/settings/storage-page.ts'; export { createSkinSettingsPage } from './src/native-ui/renderer-extension/src/settings/skin-market.ts'; export { applyRendererSkin } from './src/native-ui/renderer-extension/src/settings/skin-runtime.ts'; export { aboutPage } from './src/native-ui/renderer-extension/src/settings/pages.ts'; export { rendererSettingsMessages } from './src/native-ui/renderer-extension/src/settings/localization.ts'; export { installRendererSettingsShell } from './src/native-ui/renderer-extension/src/settings/shell.ts';`, resolveDir: process.cwd() }, bundle: true, alias: { '@codexhost/shared-contracts': path.resolve('src/native-ui/shared-contracts/src/index.ts') }, platform: 'browser', format: 'iife', globalName: 'NativeUI', write: false, loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.css': 'text' }, logLevel: 'silent' });
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<html><head><style>body{background:%2317191d;color:white;font:16px Arial;padding:40px}button{background:%23272a30;color:white;border:0;padding:12px}img{vertical-align:middle}main{display:flex;gap:25px;margin-bottom:40px}</style></head><body><h2>Harness Mix native components</h2><main></main></body></html>');
  await win.webContents.executeJavaScript(`globalThis.__HARNESS_MIX_ICONS__=${JSON.stringify(icons)};globalThis.__HARNESS_MIX_MODEL_FAMILIES__=${JSON.stringify(MODEL_FAMILIES.map(f => ({ id: f.id, pattern: f.regex.source })))};${bundle.outputFiles[0].text}`);
  const liveSettingsPages = await win.webContents.executeJavaScript(`(() => {
    const lifecycle = NativeUI.installRendererSettingsLifecycle(window, {});
    const pageIds = globalThis.__codexhostSettingsShellV1.registry.pages.map(page => page.id);
    lifecycle.dispose();
    return pageIds;
  })()`);
  assert.deepEqual(liveSettingsPages, ['connections', 'accounts', 'mcp', 'skills', 'session-import', 'storage', 'skins', 'pets', 'updates', 'about']);
  const { NativeProtocol } = require('../src/main/native/protocol');
  const nativeThreads = ['pi', 'claude', 'dsh', 'antigravity'].map((harnessId, index) => ({ id: 'sidebar-' + index, harnessId, model: { id: 'model-' + index, provider: 'native' }, options: {} }));
  const protocol = new NativeProtocol({ threads: nativeThreads, getThread: id => nativeThreads.find(thread => thread.id === id), subscribe: () => () => {}, core: { subscribe: () => () => {} }, describe: async () => ({}), getCapabilities: () => ({}) }, () => {});
  const inspections = await Promise.all(nativeThreads.map(thread => protocol.request('codexhost/thread/inspect', { threadId: thread.id })));
  await win.webContents.executeJavaScript(`globalThis.testInspections=${JSON.stringify(inspections)}`);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const agents = ['codex','pi','claude-code','deepseek-harness','antigravity','omp','opencode','grok'];
    const restored = testInspections.map(inspection => NativeUI.restoredThreadOwnership(inspection));
    const sidebar = document.createElement('aside'); document.body.append(sidebar);
    sidebar.style.cssText = 'margin:24px 0;padding:16px;border:1px solid #555;line-height:30px';
    for (const [index, agent] of agents.entries()) {
      const row = document.createElement('div');
      const attrs = { 'data-app-action-sidebar-thread-row': 'true', 'data-app-action-sidebar-thread-id': 'local:row-' + index, 'data-app-action-sidebar-thread-host-id': 'local' };
      for (const [key, value] of Object.entries(attrs)) row.setAttribute(key, value);
      row.innerHTML = '<span data-thread-title-trigger><span data-thread-title>' + agent + ' session</span></span>';
      row.__reactFiber$test = { memoizedProps: { conversationId: 'row-' + index, dataAttributes: attrs } };
      sidebar.append(row);
    }
    const decoration = NativeUI.installRendererSidebarAgentIcons({ getClient: () => ({ listThreadOwnership: async ({threadIds}) => ({threads: threadIds.map(threadId => { const agent = agents[Number(threadId.slice(4))]; return agent === 'codex' ? {threadId, owner:'codex'} : {threadId, owner:'external', harnessId:agent}; })}) }) });
    await new Promise(resolve => setTimeout(resolve, 50));
    const sidebarIcons = [...sidebar.querySelectorAll('[data-codexhost-sidebar-agent-icon]')].map(icon => icon.getAttribute('data-codexhost-sidebar-agent-icon'));
    // Rescan a React-updated row: no duplicate icon and no loss of ownership.
    decoration.refresh(); await new Promise(resolve => setTimeout(resolve, 50));
    const sidebarIconCount = sidebar.querySelectorAll('[data-codexhost-sidebar-agent-icon]').length;
    globalThis.testSidebarDecoration = decoration;
    for(const agent of agents) { const el=document.createElement('div'); el.append(NativeUI.createRendererAgentIcon(agent,28),document.createTextNode(' '+agent));document.querySelector('main').append(el); }
    let selected;
    const picker=NativeUI.mountRendererModelPicker('test',id=>selected=id,()=>{});
    globalThis.testModelPicker = picker;
    document.body.append(picker.root);
    NativeUI.renderRendererModelPicker(picker,{status:'ready',selected:{id:'a'},catalog:{models:[{ref:{id:'a'},label:'Claude Sonnet'},{ref:{id:'b'},label:'DeepSeek'},{ref:{id:'c'},label:'Gemini'}],thinkingOptions:[]}},true);
    picker.trigger.click();
    const option=picker.options.get('b').button;
    option.click();
    picker.close(); picker.trigger.click();
    const levels = [{id:'low',label:'Low'},{id:'high',label:'High'}];
    const view = {status:'ready',selected:{id:'a'},catalog:{models:[{ref:{id:'a'},label:'Claude Sonnet'}, {ref:{id:'b'},label:'DeepSeek',supportedThinkingOptionIds:['low','high']}],thinkingOptions:levels}};
    let thinking;
    const flow=NativeUI.mountRendererModelPicker('flow', id=>{ view.selected={id}; NativeUI.renderRendererModelPicker(flow,view,true); },id=>{thinking=id;view.selectedThinkingOptionId=id;NativeUI.renderRendererModelPicker(flow,view,true);});
    document.body.append(flow.root);
    NativeUI.renderRendererModelPicker(flow,view,true);
    flow.trigger.click();
    const modelFirst = flow.menu.dataset.twoColumn === 'false';
    flow.options.get('b').button.click();
    const stayedOpen = flow.menu.matches(':popover-open');
    const modelRect = flow.options.get('b').button.getBoundingClientRect();
    const thinkingRect = flow.thinkingOptions.get('high').button.getBoundingClientRect();
    const thinkingOnRight = thinkingRect.left >= modelRect.right;
    flow.thinkingOptions.get('high').button.click();
    const confirmed = flow.thinkingOptions.get('high').button.getAttribute('aria-checked') === 'true';
    const closedAfterThinking = !flow.menu.matches(':popover-open');
    flow.trigger.click();
    const reopenedModelFirst = flow.menu.dataset.twoColumn === 'false';
    flow.dispose();
    await Promise.all([...document.images].map(i=>i.decode()));
    return {selected,modelFirst,stayedOpen,thinkingOnRight,thinking,confirmed,closedAfterThinking,reopenedModelFirst,restored,sidebarIcons,sidebarIconCount,icons:[...document.images].map(i=>i.dataset.harnessMixIcon),loaded:[...document.images].every(i=>i.naturalWidth>0)};
  })()`);
  assert.equal(result.selected, 'b');
  for (const key of ['modelFirst','stayedOpen','thinkingOnRight','confirmed','closedAfterThinking','reopenedModelFirst']) assert.equal(result[key], true, key);
  assert.equal(result.thinking, 'high');
  assert.equal(result.loaded, true);
  assert.deepEqual(result.sidebarIcons, ['codex','pi','claude-code','deepseek-harness','antigravity','omp','opencode','grok']);
  assert.equal(result.sidebarIconCount, 8);
  assert.deepEqual(result.restored.map(item => item.agent), ['pi','claude-code','deepseek-harness','antigravity']);
  assert.deepEqual(result.restored.map(item => item.model), inspections.map(item => item.effectiveModel));
  for (const id of ['harnesses/codex','harnesses/pi','harnesses/claude-code','harnesses/deepseek-harness','harnesses/antigravity','models/claude','models/deepseek','models/gemini']) assert.ok(result.icons.includes(id), id);
  const handoffView = await win.webContents.executeJavaScript(`(() => {
    globalThis.handoffRequest = null;
    globalThis.testHandoff = NativeUI.mountRendererHarnessHandoff('smoke', request => { globalThis.handoffRequest = request; });
    globalThis.testAgentPicker = NativeUI.mountRendererAgentPicker('handoff-entry', ['codex','pi','claude-code'], target => testHandoff.open('pi', target, 'zh-CN'), () => {}, () => {});
    document.body.append(testAgentPicker.root);
    NativeUI.renderRendererAgentPicker(testAgentPicker, {agent:'pi',phase:'locked'}, 'ready', false, {pi:'ready','claude-code':'ready'});
    testAgentPicker.trigger.click();
    testAgentPicker.options['claude-code'].button.click();
    testHandoff.note.value = '按上一位给出的方案继续执行';
    return { open:testHandoff.dialog.open, title:testHandoff.dialog.querySelector('h2').textContent, text:testHandoff.dialog.textContent, pickerLabel:testAgentPicker.trigger.getAttribute('aria-label'), targetEnabled:!testAgentPicker.options['claude-code'].button.disabled };
  })()`);
  assert.equal(handoffView.open, true);
  assert.equal(handoffView.title, '接力当前任务');
  assert.match(handoffView.text, /Pi.*Claude Code/s);
  assert.match(handoffView.text, /对话记录和文件现场/);
  assert.match(handoffView.pickerLabel, /Hand off task from Pi/);
  assert.equal(handoffView.targetEnabled, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(out, 'harness-handoff.png'), (await win.webContents.capturePage()).toPNG());
  const handoffRequest = await win.webContents.executeJavaScript(`(() => { testHandoff.confirm.click(); const request = globalThis.handoffRequest; testHandoff.close(); testHandoff.dispose(); return request; })()`);
  assert.deepEqual(handoffRequest, {
    from:'pi', to:'claude-code', note:'按上一位给出的方案继续执行', intent:'continue',
    includes:{ conversation:true, plan:true, evidence:true, files:true, unresolved:true },
  });
  await win.webContents.executeJavaScript('testAgentPicker.dispose()');
  await win.webContents.executeJavaScript('testModelPicker.trigger.click();document.querySelector("main").style.flexWrap="wrap"');
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(out, 'native-components.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.body.style.background='#fff';document.body.style.color='#17191d';document.querySelector('main').style.flexWrap='wrap'`);
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(out, 'native-components-light.png'), (await win.webContents.capturePage()).toPNG());
  const settingsResult = await win.webContents.executeJavaScript(`(async () => {
    document.body.innerHTML = '';
    const messages = NativeUI.rendererSettingsMessages('zh-CN');
    const account = { accountId:'official-codex', label:'native@example.com', email:'native@example.com', planType:'plus', codexHome:'C:/Users/test/.codex', active:true, isDefault:true, authenticated:true, management:'native' };
    const client = {
      listCodexAccounts: async () => ({ accounts:[account] }),
      refreshCodexAccounts: async () => ({ accounts:[account] }),
      inspectCodexAccountUsage: async () => ({ accountId:account.accountId, usage:{planFiveHourUsedPercent:33,planSevenDayUsedPercent:29}, accountCredits:{usedPercent:33,periodType:'five_hour',productUsage:[{product:'7-day window',usagePercent:29}]} }),
      createCodexAccount: async () => ({account}), deleteCodexAccount: async () => ({deletedAccountId:account.accountId}), activateCodexAccount: async () => ({account}),
      startCodexAccountLogin: async () => { throw new Error('not expected'); }, cancelCodexAccountLogin: async () => ({cancelled:true}), logoutCodexAccount: async () => ({account:{...account,email:undefined,authenticated:false}}),
    };
    const shell = NativeUI.installRendererSettingsShell([
      NativeUI.createAccountsSettingsPage(messages, () => client),
      NativeUI.createStorageSettingsPage(messages, () => ({
        inspectStorage:async () => ({storageSchemaVersion:3,threadCount:12,loadedThreadCount:2,indexBytes:2048,recordBytes:5242880,recordCount:12,legacyBytes:0}),
        optimizeStorage:async () => ({before:{storageSchemaVersion:3,threadCount:12,loadedThreadCount:2,indexBytes:2048,recordBytes:5242880,recordCount:12,legacyBytes:0},after:{storageSchemaVersion:3,threadCount:12,loadedThreadCount:2,indexBytes:2048,recordBytes:4194304,recordCount:12,legacyBytes:0}}),
      })),
      NativeUI.createSkinSettingsPage(messages),
      NativeUI.aboutPage(messages, () => ({ readCurrentVersion:async () => ({version:'0.1.4'}), checkUpdate:async () => { throw new Error('not expected'); } })),
    ], messages, document);
    shell.openSettings(undefined, 'accounts');
    await new Promise(resolve => setTimeout(resolve, 150));
    const shadow = shell.root.shadowRoot;
    return { text:shadow.textContent, addHidden:[...shadow.querySelectorAll('button')].find(button => button.textContent.includes('添加账号'))?.hidden };
  })()`);
  assert.match(settingsResult.text, /native.*example\.com/s);
  assert.match(settingsResult.text, /Plus/);
  assert.equal(settingsResult.addHidden, false, 'multi-account Add Account action remains visible');
  fs.writeFileSync(path.join(out, 'settings-account.png'), (await win.webContents.capturePage()).toPNG());
  const storageText = await win.webContents.executeJavaScript(`(async () => {
    globalThis.__codexhostSettingsShellV1.openSettings(undefined, 'storage');
    await new Promise(resolve => setTimeout(resolve, 100));
    return globalThis.__codexhostSettingsShellV1.root.shadowRoot.textContent;
  })()`);
  assert.match(storageText, /Schema v3/);
  assert.match(storageText, /12 个任务/);
  fs.writeFileSync(path.join(out, 'settings-storage.png'), (await win.webContents.capturePage()).toPNG());
  const skinResult = await win.webContents.executeJavaScript(`(async () => {
    globalThis.__codexhostSettingsShellV1.openSettings(undefined, 'skins');
    const shadow = globalThis.__codexhostSettingsShellV1.root.shadowRoot;
    const firstButton = shadow.querySelector('button[data-skin-action="styler-nocturne-studio"]');
    const mikuButton = shadow.querySelector('button[data-skin-action="miku-488137"]');
    firstButton.click();
    mikuButton.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    return {
      text: shadow.textContent,
      active: document.documentElement.getAttribute('data-harness-mix-skin'),
      style: Boolean(document.getElementById('harness-mix-renderer-skin')),
      cardCount: shadow.querySelectorAll('.skin-card').length,
      bundledPreviewCount: [...shadow.querySelectorAll('.skin-preview')].filter(preview => preview.style.backgroundImage.includes('data:image/webp')).length,
    };
  })()`);
    assert.match(skinResult.text, /Native Codex.*Miku 488137.*原神 · 晨曦.*鸣潮 · 共鸣.*龙珠 · 筋斗云.*金辉盛境.*夜曲工作室.*静谧花园/s);
    assert.equal(skinResult.active, 'miku-488137');
  assert.equal(skinResult.style, true);
    assert.equal(skinResult.cardCount, 17);
    assert.equal(skinResult.bundledPreviewCount, 16);
    fs.writeFileSync(path.join(out, 'settings-skins.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(() => {
      const shadow = globalThis.__codexhostSettingsShellV1.root.shadowRoot;
      const page = shadow.querySelector('.settings-page');
      page.scrollTop = page.scrollHeight;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(out, 'settings-skins-discovery.png'), (await win.webContents.capturePage()).toPNG());
  const aboutText = await win.webContents.executeJavaScript(`(async () => {
    globalThis.__codexhostSettingsShellV1.openSettings(undefined, 'about');
    await new Promise(resolve => setTimeout(resolve, 100));
    return globalThis.__codexhostSettingsShellV1.root.shadowRoot.textContent;
  })()`);
  assert.match(aboutText, /v0\.1\.4/);
  fs.writeFileSync(path.join(out, 'settings-about.png'), (await win.webContents.capturePage()).toPNG());
  await win.setSize(1055, 616);
  const skinShowcase = await win.webContents.executeJavaScript(`(async () => {
    document.body.innerHTML = '<div id="root"><aside class="app-shell-left-panel"><button aria-haspopup="menu" aria-label="Open Codex menu"><span>Codex</span></button><nav><strong>新建任务</strong><span>拉取请求</span><span>云端</span><span>已安排</span><span>插件</span><small>项目</small><span class="active" data-app-action-sidebar-thread-active="true">Miku Codex</span><span>开源项目</span><span>Harness Mix</span></nav><footer>Harness Mix</footer></aside><main class="main-surface" data-app-shell-main-surface="default"><section class="welcome"><h1>你想让我们在 Miku Codex 中构建什么？</h1><div class="suggestions"><button class="bg-card">探索并理解代码</button><button class="bg-card">构建新功能、应用或工具</button><button class="bg-card">审查代码并提出修改建议</button><button class="bg-card">修复问题和失败</button></div></section><section class="composer-surface-chrome"><small>Miku Codex　 本地　 main</small><div>随心输入</div><footer>＋　完全访问 <span>5.6 Luna　↑</span></footer></section></main></div>';
    const fixtureStyle = document.createElement('style');
    fixtureStyle.textContent = '*{box-sizing:border-box}html,body,#root{width:100%;height:100%;margin:0}body{padding:0!important;overflow:hidden;font-family:Arial,"Microsoft YaHei",sans-serif}#root{display:flex}.app-shell-left-panel{display:flex;flex:0 0 204px;flex-direction:column;padding:6px 10px 12px}.app-shell-left-panel button{border:0;color:inherit;font:700 16px inherit;text-align:left}.app-shell-left-panel nav{display:flex;flex-direction:column;gap:12px;padding:5px 2px;font-size:13px}.app-shell-left-panel nav small{margin-top:6px;opacity:.55}.app-shell-left-panel nav .active{padding:7px;border-radius:7px}.app-shell-left-panel>footer{margin-top:auto;font-size:12px}.main-surface{position:relative;display:flex;flex:1;align-items:center;justify-content:center;overflow:hidden}.welcome{width:min(660px,70vw);text-align:center;transform:translateY(-35px)}.welcome h1{margin:0 0 26px;font-size:23px;font-weight:500}.suggestions{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.suggestions button{min-height:76px;padding:12px;border:1px solid #fff8;border-radius:9px;color:inherit;text-align:left;font-weight:600}.composer-surface-chrome{position:absolute;right:13%;bottom:12px;left:13%;min-height:94px;padding:12px 18px;border:1px solid transparent;border-radius:16px}.composer-surface-chrome>div{padding:13px 0;color:#52617a99}.composer-surface-chrome footer{font-size:11px}.composer-surface-chrome footer span{float:right}';
    document.head.append(fixtureStyle);
    NativeUI.applyRendererSkin('miku-488137', document);
    await new Promise(resolve => setTimeout(resolve, 150));
    const root = getComputedStyle(document.getElementById('root'));
    const main = getComputedStyle(document.querySelector('.main-surface'));
    const logo = getComputedStyle(document.querySelector('.app-shell-left-panel button'));
    const polaroid = getComputedStyle(document.body, '::after');
    return { rootBackground:root.backgroundImage, mainBackground:main.backgroundImage, logoBackground:logo.backgroundImage, polaroidBackground:polaroid.backgroundImage };
  })()`);
  assert.match(skinShowcase.rootBackground, /data:image\/webp/);
  assert.match(skinShowcase.mainBackground, /linear-gradient/);
  assert.match(skinShowcase.logoBackground, /data:image\/webp/);
  assert.match(skinShowcase.polaroidBackground, /data:image\/webp/);
  fs.writeFileSync(path.join(out, 'skin-miku-full.png'), (await win.webContents.capturePage()).toPNG());
  await win.setSize(1024, 716);
  const responsiveHome = await win.webContents.executeJavaScript(`(async () => {
    document.body.innerHTML = '<div id="root"><aside class="app-shell-left-panel"></aside><main class="main-surface" data-app-shell-main-surface="default"><div data-app-shell-main-content-top-fade="full-bleed"></div><header data-pip-obstacle="app-shell-header"><div data-testid="app-shell-header-context-menu-surface"><div data-app-shell-page-header="true"><div data-app-shell-header-toolbar="true"><div class="thread-title-surface"><div>新任务</div></div><button class="header-action" aria-label="聊天操作" aria-haspopup="menu" data-state="open">...</button></div></div></div></header><div role="main" style="container-type:size;container-name:home-main-content;width:100%;height:100%;display:flex;flex-direction:column"><section class="_Hero_smoke_2"><h1 data-feature="game-source">你想让我们在 harness-mix 中构建什么？</h1></section><section class="[--thread-content-max-width:42rem]"><div data-composer-placement="home" class="composer-surface-chrome">随心输入<table><tbody><tr><td>响应式验证</td></tr></tbody></table></div></section></div></main></div>';
    const fixtureStyle = document.createElement('style');
    fixtureStyle.textContent = 'html,body,#root{width:100%;height:100%;margin:0}#root{display:flex}.app-shell-left-panel{flex:0 0 240px}.main-surface{position:relative;min-width:0;flex:1}.main-surface>header{position:absolute;z-index:2;width:100%;height:44px}.main-surface>header>div{display:flex;justify-content:space-between;padding:8px 12px}._Hero_smoke_2{display:flex;flex:0 0 44%;align-items:flex-end;justify-content:center;min-block-size:260px;padding-bottom:32px}h1{font-size:32px}.\\[--thread-content-max-width\\:42rem\\]{width:var(--thread-content-max-width);max-width:100%;margin:auto}.composer-surface-chrome{padding:24px}';
    document.head.append(fixtureStyle);
    NativeUI.applyRendererSkin('miku-488137', document);
    await new Promise(resolve => setTimeout(resolve, 100));
    const hero = getComputedStyle(document.querySelector('._Hero_smoke_2'));
    const heading = getComputedStyle(document.querySelector('[data-feature="game-source"]'));
    const header = getComputedStyle(document.querySelector('[data-pip-obstacle="app-shell-header"]'));
    const headerAction = getComputedStyle(document.querySelector('.header-action'));
    const titleSurface = getComputedStyle(document.querySelector('.thread-title-surface'));
    const topFade = getComputedStyle(document.querySelector('[data-app-shell-main-content-top-fade]'));
    const table = getComputedStyle(document.querySelector('table'));
    return { flexBasis:hero.flexBasis, minBlockSize:parseFloat(hero.minBlockSize), fontSize:parseFloat(heading.fontSize), headerBackground:header.backgroundColor, headerActionBackground:headerAction.backgroundColor, titleBackground:titleSurface.backgroundColor, topFadeImage:topFade.backgroundImage, topFadeOpacity:topFade.opacity, tableBackground:table.backgroundColor };
  })()`);
  assert.equal(responsiveHome.flexBasis, 'auto');
  assert.ok(responsiveHome.minBlockSize <= 200, `responsive hero remained too tall: ${responsiveHome.minBlockSize}px`);
  assert.ok(responsiveHome.fontSize <= 28, `responsive heading remained too large: ${responsiveHome.fontSize}px`);
  assert.equal(responsiveHome.headerBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(responsiveHome.headerActionBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(responsiveHome.titleBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(responsiveHome.topFadeImage, 'none');
  assert.equal(responsiveHome.topFadeOpacity, '0');
  assert.notEqual(responsiveHome.tableBackground, 'rgba(0, 0, 0, 0)');
  fs.writeFileSync(path.join(out, 'skin-responsive-home.png'), (await win.webContents.capturePage()).toPNG());
  await win.setSize(1920, 1000);
  const wideThreadWidth = await win.webContents.executeJavaScript(`(() => getComputedStyle(document.querySelector('[class*="thread-content-max-width"]')).getPropertyValue('--thread-content-max-width').trim())()`);
  assert.match(wideThreadWidth, /72rem/);
  await win.setSize(1020, 716);
  const readableConversation = await win.webContents.executeJavaScript(`(async () => {
    document.body.innerHTML = '<div id="root"><aside class="app-shell-left-panel"><button aria-haspopup="menu" aria-label="Open Codex menu"><span>Codex</span></button><nav><strong>新建任务</strong><span>Pull Request</span><span>定时任务</span><span>插件</span><small>项目</small><span>snipaste-pro</span><span>harness-mix</span><span class="active" data-app-action-sidebar-thread-active="true">查找换肤界面差异原因</span></nav><footer>Harness Mix</footer></aside><main class="main-surface chat" data-app-shell-main-surface="default"><header>查找换肤界面差异原因</header><div class="chat-scroll"><article data-local-conversation-final-assistant><div data-response-annotation-conversation><small>用时 19秒</small><p>是的，准确说是修改了 Codex UI 的运行时表现层。</p><p>它会：</p><ul><li>注入 CSS、替换颜色变量和背景图。</li><li>把部分原生面板变成半透明。</li><li>增加 Logo、拍立得等纯视觉装饰。</li><li>保留原有按钮、输入框、会话和交互逻辑。</li></ul><p>它不会修改 Codex 的安装包、模型调用、账号、权限或会话归属。</p></div></article></div><section class="composer-surface-chrome"><div>随心输入</div><footer>＋　完全访问 <span>GPT-5.6 Sol　↑</span></footer></section></main></div>';
    const chatStyle = document.createElement('style');
    chatStyle.textContent = '.app-shell-left-panel button{background:transparent}.chat.main-surface{display:block;padding:0 22px}.chat>header{height:56px;padding:18px 4px;border-bottom:1px solid #6b789633;font-size:14px}.chat-scroll{height:calc(100% - 180px);overflow:auto;padding:42px 8px 80px}.chat article{max-width:760px;margin:0 auto;font-size:15px;line-height:1.7}.chat article small{opacity:.55}.chat article p{margin:13px 0}.chat article li{margin:4px 0}.chat .composer-surface-chrome{right:22px;bottom:14px;left:22px;background:#fff}';
    document.head.append(chatStyle);
    NativeUI.applyRendererSkin('dragonball-nimbus', document);
    await new Promise(resolve => setTimeout(resolve, 150));
    const response = getComputedStyle(document.querySelector('[data-response-annotation-conversation]'));
    return { background:response.backgroundColor, color:response.color, padding:response.padding, radius:response.borderRadius };
  })()`);
  assert.notEqual(readableConversation.background, 'rgba(0, 0, 0, 0)');
  assert.notEqual(readableConversation.background, 'transparent');
  assert.equal(readableConversation.padding, '14px 16px 12px');
  assert.equal(readableConversation.radius, '18px');
  fs.writeFileSync(path.join(out, 'skin-conversation-readable.png'), (await win.webContents.capturePage()).toPNG());
  const darkSurfaceResult = await win.webContents.executeJavaScript(`(async () => {
    document.body.innerHTML = '<div id="root"><aside class="app-shell-left-panel"><button aria-haspopup="menu" aria-label="Open Codex menu"><span>Codex</span></button><nav><strong>新对话</strong><span>Pull Request</span><span>定时任务</span><span>插件</span><small>项目</small><span class="active" data-app-action-sidebar-thread-active="true">暗色皮肤全界面适配</span></nav></aside><main class="main-surface dark-fixture" data-app-shell-main-surface="default"><header>暗色皮肤全界面适配</header><div data-user-message-bubble="true"><div data-markdown-text-tone="user-message"><p data-markdown-han-text="true">暗色皮肤里的用户消息必须清晰可读。</p></div></div><article data-response-annotation-conversation><p>正文、工具状态、评审卡和输入区都需要保持清晰。</p><section class="review-card"><div>已编辑 3 个文件</div><button class="review-action">审核</button><button class="review-row">src/settings/skin-runtime.ts</button><button class="review-row">scripts/native-ui-smoke.cjs</button></section></article><section class="composer-real" data-composer-layout="multiline"><input placeholder="随心输入"><button>完全访问</button><button>GPT-5.6 Sol</button></section></main></div>';
    const darkFixtureStyle = document.createElement('style');
    darkFixtureStyle.textContent = 'html,body,#root{width:100%;height:100%;margin:0}.dark-fixture{position:relative;display:block;padding:24px}.dark-fixture>header{padding:12px 0}.dark-fixture>[data-user-message-bubble]{max-width:520px;margin:24px 0 0 auto;padding:12px 16px;border-radius:16px}.dark-fixture article{max-width:700px;margin:60px auto}.review-card{margin-top:24px;padding:14px;border:1px solid var(--color-token-border-default);border-radius:12px;background:color-mix(in srgb,var(--color-surface-elevated-secondary) 50%,transparent)}.review-card button{color:var(--color-text-primary)}.review-action{float:right;background:var(--color-background-primary-soft-alpha)}.review-row{display:block;width:100%;margin-top:10px;padding:10px;text-align:left;border:0;background:color-mix(in srgb,var(--color-surface) 70%,transparent)}.composer-real{position:absolute;right:24px;bottom:16px;left:24px;padding:18px;border-radius:20px;background:color-mix(in srgb,var(--color-surface-elevated-secondary) 86%,transparent)}.composer-real input{width:70%;padding:8px;color:var(--color-text-primary);background:transparent;border:0}.composer-real button{margin-left:8px;color:var(--color-text-secondary);background:transparent;border:0}';
    document.head.append(darkFixtureStyle);
    NativeUI.applyRendererSkin('dragonball-nimbus', document);
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = { buttons:document.querySelectorAll('button').length, inputs:document.querySelectorAll('input').length };
    const lightReviewBackground = getComputedStyle(document.querySelector('.review-card')).backgroundColor;
    NativeUI.applyRendererSkin('genshin-night', document);
    await new Promise(resolve => setTimeout(resolve, 150));
    const review = getComputedStyle(document.querySelector('.review-card'));
    const row = getComputedStyle(document.querySelector('.review-row'));
    const composer = getComputedStyle(document.querySelector('.composer-real'));
    const userBubble = getComputedStyle(document.querySelector('[data-user-message-bubble]'));
    const userText = getComputedStyle(document.querySelector('[data-markdown-text-tone="user-message"]'));
    const after = { buttons:document.querySelectorAll('button').length, inputs:document.querySelectorAll('input').length };
    return { before, after, active:document.documentElement.getAttribute('data-harness-mix-skin'), lightReviewBackground, reviewBackground:review.backgroundColor, rowBackground:row.backgroundColor, composerBackground:composer.backgroundColor, color:review.color, userBubbleColor:userBubble.color, userTextColor:userText.color, userBubbleBackground:userBubble.backgroundColor };
  })()`);
  assert.deepEqual(darkSurfaceResult.after, darkSurfaceResult.before);
  assert.equal(darkSurfaceResult.active, 'genshin-night');
  assert.notEqual(darkSurfaceResult.reviewBackground, darkSurfaceResult.lightReviewBackground);
  assert.doesNotMatch(darkSurfaceResult.reviewBackground, /255, 255, 255/);
  assert.doesNotMatch(darkSurfaceResult.rowBackground, /255, 255, 255/);
  assert.doesNotMatch(darkSurfaceResult.composerBackground, /255, 255, 255/);
  assert.equal(darkSurfaceResult.color, 'rgb(240, 230, 200)');
  assert.equal(darkSurfaceResult.userBubbleColor, 'rgb(240, 230, 200)');
  assert.equal(darkSurfaceResult.userTextColor, 'rgb(240, 230, 200)');
  assert.notEqual(darkSurfaceResult.userBubbleBackground, 'rgba(0, 0, 0, 0)');
  fs.writeFileSync(path.join(out, 'skin-dark-all-surfaces.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  console.log('PASS: real Electron native picker, graphical Harness handoff, official Account/Usage, sharded Storage metrics, live About version and all project Harness/model SVGs load');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
