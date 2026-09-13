const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { Integrations } = require('../src/main/host/integrations');
const { buildAdapters } = require('../src/main/adapters');
const { NativeProtocol } = require('../src/main/native/protocol');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const out = path.resolve('output/integrations-ui', `${Date.now()}`), project = path.join(out, 'project');
  await fs.mkdir(project, { recursive: true });
  const adapters = new Map(buildAdapters(() => {}).map(a => [a.manifest.id, a]));
  const runtime = { adapters, sessions: new Map(), status: { claude: { available: true } }, store: { directory: path.join(out, 'data') }, resolveHarnessId: id => id };
  runtime.integrations = new Integrations(runtime, { home: path.join(out, 'home') });
  const source = path.join(out, 'skill-source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: ui-skill\ndescription: UI fixture\n---\n# Test\n');
  const preload = path.join(out, 'preload.cjs');
  await fs.writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('integrationTest',{request:(method,params)=>ipcRenderer.invoke('integrations-test',method,params)});`);
  ipcMain.handle('integrations-test', (_event, method, params) => {
    assert.ok(method.startsWith('codexhost/integrations/'));
    return NativeProtocol.prototype.request.call({ runtime }, method, params);
  });
  const build = await esbuild.build({ stdin: { contents: `export {createIntegrationsSettingsPage} from './src/native-ui/renderer-extension/src/settings/integrations-page.ts'; export {mountRendererSettingsShell} from './src/native-ui/renderer-extension/src/settings/shell.ts'; export {createRendererSettingsPageRegistry} from './src/native-ui/renderer-extension/src/settings/core.ts'; export {rendererSettingsMessages} from './src/native-ui/renderer-extension/src/settings/localization.ts'; export {createRendererIntegrationsClient} from './src/native-ui/renderer-extension/src/renderer-integrations-client.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', globalName: 'IntegrationUI', write: false, alias: { '@codexhost/shared-contracts': path.resolve('src/native-ui/shared-contracts/src/index.ts') }, loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'text' } });
  const consoleProblems = [];
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { preload, contextIsolation: true, sandbox: true, offscreen: true } });
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error' || details.level === 'warning') consoleProblems.push(details.message); });
  try {
    await win.loadURL('data:text/html,<html><head><title>Harness Mix Integrations QA</title><meta http-equiv="Content-Security-Policy" content="default-src %27none%27; script-src %27none%27; style-src %27unsafe-inline%27; img-src data:"></head><body style="background:%23191919;color:white;font-family:Arial"></body></html>');
    await win.webContents.executeJavaScript(build.outputFiles[0].text);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const messages=IntegrationUI.rendererSettingsMessages('zh-CN');
      const client=IntegrationUI.createRendererIntegrationsClient((m,p)=>window.integrationTest.request(m,p));
      const registry=IntegrationUI.createRendererSettingsPageRegistry([IntegrationUI.createIntegrationsSettingsPage(messages,()=>client)]);
      const shell=IntegrationUI.mountRendererSettingsShell(registry,document,messages); shell.openSettings();
      const root=shell.root.shadowRoot;
      const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,30));}throw Error('UI timed out');};
      await wait(()=>root.querySelector('select')?.options.length===16 && !root.querySelector('select').disabled);
      const [harness,scope]=root.querySelectorAll('select');harness.value='claude';harness.dispatchEvent(new Event('change'));
      await wait(()=>root.querySelector('.settings-integrations-form')&&!harness.disabled);
      scope.value='project';scope.dispatchEvent(new Event('change'));
      const cwd=root.querySelector('.settings-integrations-controls input');cwd.value=${JSON.stringify(project)};cwd.dispatchEvent(new Event('change'));
      await wait(()=>root.querySelector('.settings-integrations-form')&&!harness.disabled);
      const form=root.querySelector('form'); const fields=form.querySelectorAll('input');fields[0].value='ui-probe';fields[1].value='node';form.querySelector('textarea').value='["probe.cjs"]';form.requestSubmit();
      await wait(()=>root.textContent.includes('ui-probe')&&!harness.disabled&&!!root.querySelector('.settings-integrations-row'));
      const mcpRow=()=>Array.from(root.querySelectorAll('.settings-integrations-row')).find(r=>r.querySelector('strong')?.textContent==='ui-probe');
      mcpRow().querySelector('button').click();await wait(()=>mcpRow()?.textContent.includes('已停用')&&!harness.disabled);
      mcpRow().querySelector('button').click();await wait(()=>mcpRow()?.textContent.includes('已配置')&&!harness.disabled);
      const skillForm=root.querySelectorAll('form')[1];const skillFields=skillForm.querySelectorAll('input');skillFields[0].value='ui-skill';skillFields[1].value=${JSON.stringify(source)};skillForm.requestSubmit();
      const skillRow=()=>Array.from(root.querySelectorAll('.settings-integrations-row')).find(r=>r.querySelector('strong')?.textContent==='ui-skill');
      await wait(()=>skillRow()&&!harness.disabled);skillRow().querySelector('button').click();await wait(()=>skillRow()?.textContent.includes('已停用')&&!harness.disabled);
      skillRow().querySelector('button').click();await wait(()=>skillRow()?.textContent.includes('已发现')&&!harness.disabled);
      return {mcpSaved:true,mcpToggled:true,skillInstalled:true,skillRestored:true,scope:scope.value,text:root.textContent.slice(-2000)};
    })()`);
    assert.equal(await win.webContents.executeJavaScript('document.title'), 'Harness Mix Integrations QA');
    assert.ok(result.mcpSaved && result.skillRestored); assert.deepEqual(consoleProblems, []);
    const list = await runtime.integrations.list({ harnessId: 'claude', scope: 'project', cwd: project });
    assert.equal(list.servers[0].enabled, true); assert.equal(list.skills[0].enabled, true);
    await fs.writeFile(path.join(out, 'settings.png'), (await win.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
    console.log(`Integrations rendered UI -> typed client -> NativeProtocol -> real files PASS: ${out}`);
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
