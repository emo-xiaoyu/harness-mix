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
  const bundle = await esbuild.build({ stdin: { contents: `export { createRendererAgentIcon } from './src/native-ui/renderer-extension/src/renderer-agent-icon.ts'; export { mountRendererModelPicker, renderRendererModelPicker } from './src/native-ui/renderer-extension/src/renderer-model-picker.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', globalName: 'NativeUI', write: false, loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' });
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<html><head><style>body{background:%2317191d;color:white;font:16px Arial;padding:40px}button{background:%23272a30;color:white;border:0;padding:12px}img{vertical-align:middle}main{display:flex;gap:25px;margin-bottom:40px}</style></head><body><h2>Harness Mix native components</h2><main></main></body></html>');
  await win.webContents.executeJavaScript(`globalThis.__HARNESS_MIX_ICONS__=${JSON.stringify(icons)};globalThis.__HARNESS_MIX_MODEL_FAMILIES__=${JSON.stringify(MODEL_FAMILIES.map(f => ({ id: f.id, pattern: f.regex.source })))};${bundle.outputFiles[0].text}`);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const agents = ['codex','pi','claude-code','deepseek-harness','antigravity'];
    for(const agent of agents) { const el=document.createElement('div'); el.append(NativeUI.createRendererAgentIcon(agent,28),document.createTextNode(' '+agent));document.querySelector('main').append(el); }
    let selected;
    const picker=NativeUI.mountRendererModelPicker('test',id=>selected=id,()=>{});
    document.body.append(picker.root);
    NativeUI.renderRendererModelPicker(picker,{status:'ready',selected:{id:'a'},catalog:{models:[{ref:{id:'a'},label:'Claude Sonnet'},{ref:{id:'b'},label:'DeepSeek'},{ref:{id:'c'},label:'Gemini'}],thinkingOptions:[]}},true);
    picker.trigger.click(); picker.modelButton.click();
    const option=picker.options.get('b').button;
    option.click();
    picker.trigger.click();picker.modelButton.click();
    await Promise.all([...document.images].map(i=>i.decode()));
    return {selected,icons:[...document.images].map(i=>i.dataset.harnessMixIcon),loaded:[...document.images].every(i=>i.naturalWidth>0)};
  })()`);
  assert.equal(result.selected, 'b');
  assert.equal(result.loaded, true);
  for (const id of ['harnesses/codex','harnesses/pi','harnesses/claude-code','harnesses/deepseek-harness','harnesses/antigravity','models/claude','models/deepseek','models/gemini']) assert.ok(result.icons.includes(id), id);
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(out, 'native-components.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  console.log('PASS: real Electron native picker selection and all project Harness/model SVGs load');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
