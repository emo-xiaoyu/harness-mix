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
  const bundle = await esbuild.build({ stdin: { contents: `export { createRendererAgentIcon } from './src/native-ui/renderer-extension/src/renderer-agent-icon.ts'; export { mountRendererAgentPicker, renderRendererAgentPicker } from './src/native-ui/renderer-extension/src/renderer-agent-picker.ts'; export { mountRendererModelPicker, renderRendererModelPicker } from './src/native-ui/renderer-extension/src/renderer-model-picker.ts'; export { mountRendererHarnessHandoff } from './src/native-ui/renderer-extension/src/renderer-harness-handoff.ts'; export { restoredThreadOwnership } from './src/native-ui/renderer-extension/src/renderer-binding-probe.ts'; export { installRendererSidebarAgentIcons } from './src/native-ui/renderer-extension/src/renderer-sidebar-agent-icons.ts'; export { createAccountsSettingsPage } from './src/native-ui/renderer-extension/src/settings/accounts-page.ts'; export { aboutPage } from './src/native-ui/renderer-extension/src/settings/pages.ts'; export { rendererSettingsMessages } from './src/native-ui/renderer-extension/src/settings/localization.ts'; export { installRendererSettingsShell } from './src/native-ui/renderer-extension/src/settings/shell.ts';`, resolveDir: process.cwd() }, bundle: true, alias: { '@codexhost/shared-contracts': path.resolve('src/native-ui/shared-contracts/src/index.ts') }, platform: 'browser', format: 'iife', globalName: 'NativeUI', write: false, loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'text' }, logLevel: 'silent' });
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<html><head><style>body{background:%2317191d;color:white;font:16px Arial;padding:40px}button{background:%23272a30;color:white;border:0;padding:12px}img{vertical-align:middle}main{display:flex;gap:25px;margin-bottom:40px}</style></head><body><h2>Harness Mix native components</h2><main></main></body></html>');
  await win.webContents.executeJavaScript(`globalThis.__HARNESS_MIX_ICONS__=${JSON.stringify(icons)};globalThis.__HARNESS_MIX_MODEL_FAMILIES__=${JSON.stringify(MODEL_FAMILIES.map(f => ({ id: f.id, pattern: f.regex.source })))};${bundle.outputFiles[0].text}`);
  const { NativeProtocol } = require('../src/main/native/protocol');
  const nativeThreads = ['pi', 'claude', 'dsh', 'antigravity'].map((harnessId, index) => ({ id: 'sidebar-' + index, harnessId, model: { id: 'model-' + index, provider: 'native' }, options: {} }));
  const protocol = new NativeProtocol({ threads: nativeThreads, subscribe: () => () => {}, core: { subscribe: () => () => {} }, describe: async () => ({}), getCapabilities: () => ({}) }, () => {});
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
      NativeUI.aboutPage(messages, () => ({ readCurrentVersion:async () => ({version:'0.1.4'}), checkUpdate:async () => { throw new Error('not expected'); } })),
    ], messages, document);
    shell.openSettings(undefined, 'accounts');
    await new Promise(resolve => setTimeout(resolve, 150));
    const shadow = shell.root.shadowRoot;
    return { text:shadow.textContent, addHidden:[...shadow.querySelectorAll('button')].find(button => button.textContent.includes('添加账号'))?.hidden };
  })()`);
  assert.match(settingsResult.text, /native.*example\.com/s);
  assert.match(settingsResult.text, /Plus/);
  assert.equal(settingsResult.addHidden, true);
  fs.writeFileSync(path.join(out, 'settings-account.png'), (await win.webContents.capturePage()).toPNG());
  const aboutText = await win.webContents.executeJavaScript(`(async () => {
    globalThis.__codexhostSettingsShellV1.openSettings(undefined, 'about');
    await new Promise(resolve => setTimeout(resolve, 100));
    return globalThis.__codexhostSettingsShellV1.root.shadowRoot.textContent;
  })()`);
  assert.match(aboutText, /v0\.1\.4/);
  fs.writeFileSync(path.join(out, 'settings-about.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  console.log('PASS: real Electron native picker, graphical Harness handoff, official Account/Usage, live About version and all project Harness/model SVGs load');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
