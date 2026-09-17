const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const output = path.resolve('output/codex-accounts-ui-smoke');
  fs.mkdirSync(output, { recursive: true });
  const bundle = await esbuild.build({
    stdin: {
      contents: `export { createAccountsSettingsPage } from './src/native-ui/renderer-extension/src/settings/accounts-page.ts'; export { rendererSettingsMessages } from './src/native-ui/renderer-extension/src/settings/localization.ts'; export { installRendererSettingsShell } from './src/native-ui/renderer-extension/src/settings/shell.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    alias: { '@harnessmix/shared-contracts': path.resolve('src/native-ui/shared-contracts/src/index.ts') },
    platform: 'browser',
    format: 'iife',
    globalName: 'AccountUI',
    write: false,
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'text' },
    logLevel: 'silent',
  });
  const win = new BrowserWindow({ show: false, width: 1080, height: 720, webPreferences: { contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const accounts = [
      { accountId:'official-codex', label:'owner@example.com', email:'owner@example.com', planType:'plus', codexHome:'C:/Users/test/.codex', active:false, isDefault:true, authenticated:true, management:'native' },
      { accountId:'account-work', label:'work@example.com', email:'work@example.com', planType:'pro', codexHome:'C:/Profiles/work', active:true, isDefault:false, authenticated:true, management:'isolated' },
    ];
    const usage = {
      'official-codex': { usedPercent:31, periodType:'five_hour', resetsAt:'2026-09-14T03:00:00.000Z', productUsage:[{product:'7-day window',usagePercent:22,resetsAt:'2026-09-20T03:00:00.000Z'}] },
      'account-work': { usedPercent:68, periodType:'five_hour', resetsAt:'2026-09-14T05:00:00.000Z', productUsage:[{product:'7-day window',usagePercent:47,resetsAt:'2026-09-19T05:00:00.000Z'}] },
    };
    const client = {
      listCodexAccounts: async () => ({accounts}), refreshCodexAccounts: async () => ({accounts}),
      inspectCodexAccountUsage: async ({accountId}) => ({accountId,usage:null,accountCredits:usage[accountId]}),
      createCodexAccount: async () => ({account:accounts[1]}), deleteCodexAccount: async ({accountId}) => ({deletedAccountId:accountId}),
      activateCodexAccount: async ({accountId}) => ({account:accounts.find(account => account.accountId===accountId)}),
      startCodexAccountLogin: async () => { throw new Error('not expected'); }, cancelCodexAccountLogin: async () => ({cancelled:true}),
      logoutCodexAccount: async () => ({account:{...accounts[0],email:undefined,authenticated:false}}),
    };
    const messages=AccountUI.rendererSettingsMessages('zh-CN');
    const shell=AccountUI.installRendererSettingsShell([AccountUI.createAccountsSettingsPage(messages,()=>client)],messages,document);
    shell.openSettings(undefined,'accounts');
    await new Promise(resolve=>setTimeout(resolve,250));
    const shadow=shell.root.shadowRoot;
    const content=shadow.querySelector('.settings-page__content');
    const text=content.textContent;
    const add=[...shadow.querySelectorAll('button')].find(button=>button.textContent.includes('添加账号'));
    const rows=[...content.querySelectorAll('[data-account-id]')].map(row=>row.getAttribute('data-account-id'));
    return {text,addVisible:add && !add.hidden,rows,pathsVisible:text.includes('C:/Profiles')||text.includes('.codex')};
  })()`);
  assert.equal(result.addVisible, true);
  assert.deepEqual(result.rows, ['official-codex', 'account-work']);
  assert.match(result.text, /owner.*example\.com/s);
  assert.match(result.text, /work.*example\.com/s);
  assert.match(result.text, /Plus/);
  assert.match(result.text, /Pro/);
  assert.match(result.text, /5 小时|5小时/);
  assert.match(result.text, /7 天|7天/);
  assert.equal(result.pathsVisible, false, result.text);
  fs.writeFileSync(path.join(output, 'codex-multi-account.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  console.log('PASS: Codex multi-account settings, quota windows, refresh times and hidden CODEX_HOME render in Electron');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
