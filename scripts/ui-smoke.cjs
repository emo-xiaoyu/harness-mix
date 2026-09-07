// Deterministic renderer integration check; no Harness or model request is sent.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
app.setPath('userData', require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'hm-ui-smoke-')));
let threads = [], created = [], sent = [], approvals = [], models = [];
// 1x1 PNG，用于产物渲染检查（跨 Harness 统一 artifact 投影）
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CAPS = {
  pi: { streaming: true, thinking: true, tools: true, approvals: true, questions: true, models: true, thinkingLevels: true, permissionModes: true, resume: true, fork: true, usage: true, contextUsage: true },
  dsh: { streaming: true, thinking: true, tools: true, approvals: true, questions: false, models: true, thinkingLevels: true, permissionModes: false, resume: true, fork: false, usage: true, contextUsage: true },
};
const CATALOG = {
  models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek' }],
  thinkingLevels: [{ id: 'off', label: 'off' }, { id: 'medium', label: 'medium' }, { id: 'high', label: 'high' }],
  permissionModes: [{ id: 'default', label: '默认' }, { id: 'approve', label: '信任项目' }, { id: 'no-approve', label: '忽略项目资源' }],
};
ipcMain.handle('runtime:snapshot', () => ({ threads, adapters: [{ id: 'pi', name: 'Pi', available: true, capabilities: CAPS.pi }, { id: 'dsh', name: 'DeepSeek Harness', available: true, capabilities: CAPS.dsh }] }));
ipcMain.handle('workspace:pick', () => 'E:\\harness-mix');
ipcMain.handle('thread:create', (_, input) => {
  created.push(input);
  const thread = { ...input, id: 'fixture-' + created.length, status: 'ready', messages: [], tools: [], pendingApprovals: [] };
  threads.unshift(thread); return thread;
});
ipcMain.handle('thread:send', (_, input) => {
  sent.push(input);
  const t = threads.find(t => t.id === input.threadId);
  t.status = 'working';
  t.messages = [{ role: 'user', text: input.text }, { role: 'assistant', text: '验证回复 **加粗** 与 `行内代码`', thinking: '验证思考', streaming: true, artifacts: [
    { id: 'a1', type: 'image', name: 'prototype.png', mime: 'image/png', data: PNG_1PX },
    { id: 'a2', type: 'file', name: 'desktop-prototype-v2.png', uri: 'E:\\harness-mix\\design\\desktop-prototype-v2.png' },
  ] }];
  t.tools = [{ id: 'tool-1', title: 'bash', state: 'running', detail: 'ls -la' }];
  const m = t.messages.at(-1);
  m.id = 'assistant-' + t.id;
  m.items = [
    { id: m.id + '-thinking', kind: 'thinking', text: '验证思考：先检查原生事件与上下文统计，再验证桌面呈现。', at: 1000, endedAt: 8000 },
    { id: m.id + '-intro', kind: 'text', text: '先检查当前项目的事件转换与会话结构。' },
    { id: m.id + '-tool', kind: 'tool', toolId: 'tool-1' },
    { id: m.id + '-reply', kind: 'text', text: m.text },
  ];
  t.tools[0].messageId = m.id;
  t.tools[0].input = 'pwd';
  t.tools[0].output = 'E:\\harness-mix';
  t.usage = { contextPercent: 3.7209510803222656, tokens: 9754, contextWindow: 262144, input: 2400, output: 1600, cacheRead: 98000, cacheWrite: 0, totalTokens: 102000, cacheHitPercent: 97.6, cost: 0.021 };
  t.pendingApprovals = [{ requestId: 'req-1', method: 'permission', title: '允许执行 bash？', options: [{ id: 'allow', label: '允许一次', kind: 'allow_once' }, { id: 'deny', label: '拒绝', kind: 'reject_once' }] }];
});
ipcMain.handle('thread:cancel', (_, id) => { const t = threads.find(t => t.id === id); t.status = 'ready'; t.pendingApprovals = []; delete t.messages.at(-1).streaming; });
ipcMain.handle('approval:respond', (_, { threadId, requestId, response }) => {
  approvals.push({ threadId, requestId, response });
  threads.find(t => t.id === threadId).pendingApprovals = [];
});
ipcMain.handle('thread:listModels', () => CATALOG.models);
ipcMain.handle('thread:setModel', (_, { threadId, model }) => { models.push(model); threads.find(t => t.id === threadId).model = model; return model; });
ipcMain.handle('thread:setThinking', (_, { threadId, level }) => { const t = threads.find(t => t.id === threadId); (t.options ??= {}).thinking = level; });
ipcMain.handle('thread:setOptions', (_, { threadId, options }) => { const t = threads.find(t => t.id === threadId); t.options = { ...t.options, ...options }; return t.options; });
const push = () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('runtime:event', { type: 'snapshot' }); };
ipcMain.handle('thread:remove', (_, id) => { threads = threads.filter(t => t.id !== id); push(); });
ipcMain.handle('thread:move', (_, { threadId, cwd }) => { const t = threads.find(t => t.id === threadId); t.cwd = cwd; push(); return t; });
ipcMain.handle('harness:describe', () => CATALOG);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 960, show: true, webPreferences: { preload: path.resolve('src/main/preload.js'), contextIsolation: true, sandbox: true } });
  try {
    await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); // 保证项目组/选择状态确定性
    await win.loadFile(path.resolve('src/renderer/index.html'));
    await win.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(document.querySelector('#drawer button')){clearInterval(timer);resolve()}},20)})`);
    const testRun = win.webContents.executeJavaScript(`(async()=>{try{
 const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],wait=()=>new Promise(r=>setTimeout(r,100));
 const check=(value,message)=>{if(!value)throw Error(message)};
 check($('#drawer').hidden,'drawer starts closed');
 $('#trigger').click();check(!$('#drawer').hidden,'drawer opens');
 check($('[data-harness=codex]').disabled&&$('[data-harness=claude]').disabled,'unimplemented harnesses disabled');
 $('[data-harness=dsh]').click();check($('#drawer').hidden,'selection closes drawer');
 check($('#currentIcon').getAttribute('src').includes('deepseek'),'DSH icon selected');
 $('#message').value='UI integration fixture';$('#composer').requestSubmit();await wait();
 check($('#tabs .tab.active')?.textContent.includes('UI integration fixture'),'created active tab');
 check($('#conversation').textContent.includes('验证回复'),'response renders');
 check($('#conversation .message strong')?.textContent.includes('加粗'),'markdown bold renders');
 check($('#conversation .message code')?.textContent.includes('行内代码'),'markdown inline code renders');
 check($('#conversation .artifact-image img')?.getAttribute('src').startsWith('data:image/png'),'image artifact renders');
 check($('#conversation .artifact-file')?.textContent.includes('desktop-prototype-v2.png'),'file artifact renders');
 check($('#conversation').textContent.includes('验证思考'),'thinking renders');
 check($('#conversation').textContent.includes('bash'),'tool status renders');
 check(!$('.activity').open,'thinking collapsed by default');
 check(!$('.turn-process').open,'live process collapsed by default');
 check($('.progress-message').checkVisibility(),'live commentary visible');
 check(!$('.reasoning-text').checkVisibility(),'reasoning content hidden');
 $('.turn-process summary').click();
 const toolActivity=$$('.activity').find(d=>d.textContent.includes('正在执行 bash'));
 toolActivity.querySelector('summary').click();
 check(toolActivity.open&&toolActivity.textContent.includes('pwd'),'tool input expands');
 toolActivity.querySelector('summary').click();
 const items=[...$('.message.assistant').children];
 check(items.findIndex(n=>n.textContent.includes('先检查当前项目'))<items.findIndex(n=>n.classList.contains('activity-group')&&n.textContent.includes('bash')),'commentary precedes tool summary');
 $('.activity summary').click();check($('.activity').open,'thinking expands');
 check($('#contextText').textContent==='3.7%','context percentage rounded');
 $('#contextMeter').click();check(!$('#usagePopover').hidden,'usage opens');
 check($('#usagePopover').textContent.includes('CH 97.6%'),'latest cache hit rate');
 check($('#usagePopover').textContent.includes('0.0210'),'native cost renders');
 check(window.UsageView.data({contextPercent:NaN}).label==='—','invalid usage is unknown');
 check(window.UsageView.data({contextPercent:0}).label==='0%','zero usage retained');
 check(window.UsageView.data({contextPercent:150}).label==='100%','percentage clamped');
 check(window.Transcript.legacyTools({id:'old',tools:[{id:'old-tool',title:'bash',state:'done'}]}).includes('旧记录未保存事件顺序'),'legacy order not invented');
 check(!$('#stop').hidden,'stop visible while working');
 const approval=$('.approval');check(approval&&approval.textContent.includes('允许执行 bash'),'approval card renders');
 approval.querySelector('[data-approval-option=allow]').click();await wait();
 check(!$('.approval'),'approval clears after respond');
 check($('.activity').open,'disclosure survives snapshot rerender');
 $('.activity summary').click();
 $('#contextMeter').click();
 check(!$('#usagePopover').hidden,'usage reopens');
 check(getComputedStyle($('.activity summary')).color==='rgb(133, 135, 140)','activity uses neutral gray');
 window.__captureReady=true;
 while(!window.__captureDone) await wait();
 $('#stop').click();await wait();check($('#stop').hidden,'cancel settles');
 $('#modelBar').click();await wait();
 check(!$('#modelBarMenu').hidden&&$('#modelBarMenu').textContent.includes('DeepSeek V4 Pro'),'combined menu opens (thread)');
 check($('#modelBarMenu [data-kind=think]'),'thinking column present');
 $('#modelBarMenu [data-kind=model][data-idx="0"]').click();await wait();
 check($('#modelBar .model-name').textContent.includes('DeepSeek'),'model switch reflected');
 $('#forkBtn').click();await wait();check($('#notice').textContent.includes('不支持'),'DSH fork guard notice');
 $('#trigger').click();$('[data-harness=pi]').click();check(!$('#tabs .tab.active')&&!$('[data-tab="__draft"]'),'draft has no top tab');
 check($('#tabs').textContent.includes('UI integration fixture'),'first thread kept as open tab');
 check($('#projects').textContent.includes('UI integration fixture'),'original task retained in project group');
 await window.harnessMix.moveThread('fixture-1','E:\\\\study');await wait();
 const movedGroup=[...$$('#projects details')].find(d=>d.dataset.path==='E:\\\\study');
 check(movedGroup,'second project group appears after move');
 movedGroup.querySelector('summary').click();await wait();
 check($('#cwd').value==='E:\\\\study','project selection sets cwd');
 check($('#thinkBar')===null,'thinking merged into model pill');
 $('#modelBar').click();await wait();
 $('#modelBarMenu [data-kind=think][data-idx="2"]').click();await wait();
 check($('#modelBar .model-name').textContent.includes('high'),'thinking draft reflected as suffix');
 $('#permBar').click();await wait();
 $('#permMenu [data-idx="1"]').click();await wait();
 check($('#permBar .perm-name').textContent.includes('信任'),'permission draft reflected');
 $('#modelBar').click();await wait();
 $('#modelBarMenu [data-kind=model][data-idx="0"]').click();await wait();
 $('#message').value='fixture with options';$('#composer').requestSubmit();await wait();
 $('#stop').click();await wait();
 const navOf=cwd=>$$(('#projects nav.threads')).find(n=>n.dataset.path===cwd);
 check(navOf('E:\\\\study')?.textContent.includes('fixture with options'),'thread grouped under its project');
 await window.harnessMix.moveThread('fixture-2','E:\\\\harness-mix');await wait();
 check(navOf('E:\\\\harness-mix')?.textContent.includes('fixture with options'),'thread moved to target project');
 navOf('E:\\\\harness-mix').querySelector('[data-del="fixture-2"]').click();await wait();
 check($('.modal')?.textContent.includes('删除任务'),'delete confirm modal opens');
 $('.modal [data-modal-cancel]').click();await wait();await wait();
 check(!$('.modal')&&navOf('E:\\\\harness-mix').textContent.includes('fixture with options'),'cancel keeps thread');
 navOf('E:\\\\harness-mix').querySelector('[data-del="fixture-2"]').click();await wait();
 $('.modal [data-modal-ok]').click();await wait();await wait();
 check(!$('.modal')&&!$('#projects').textContent.includes('fixture with options'),'thread deleted via modal');
 const delGroup=$$('#projects details').find(d=>d.dataset.path==='E:\\\\study');
 check(delGroup?.querySelector('[data-del-project]'),'project delete affordance present');
 delGroup.querySelector('[data-del-project]').click();await wait();
 check($('.modal')?.textContent.includes('删除项目'),'project delete modal opens');
 $('.modal [data-modal-ok]').click();await wait();await wait();
 check(!$$('#projects details').some(d=>d.dataset.path==='E:\\\\study'),'project group removed');
 check(!$('#projects').textContent.includes('UI integration fixture'),'project threads cascade deleted');
 $('#trigger').click();
 const images=[...document.images];await Promise.all(images.map(i=>i.decode()));
 check(images.every(i=>i.naturalWidth>0),'SVG images loaded');
 check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow');
 return 'drawer, icons, disabled adapters, DSH routing, streaming, thinking, tools, approval respond, combined model+thinking menu, fork guard, project select/grouping, draft catalogs, options routing, markdown+artifact rendering, thread move+delete modal, project cascade delete, cancel, task preservation passed';
 }catch(e){return 'FAIL: '+(e.stack||e.message||e)}
 })()`);
    let testFinished = false;
    testRun.finally(() => { testFinished = true; });
    for (let i = 0; i < 100 && !testFinished; i++) {
      if (await win.webContents.executeJavaScript('Boolean(window.__captureReady)')) {
        await new Promise(r => setTimeout(r, 200));
        await fs.mkdir('output/playwright', { recursive: true });
        await fs.writeFile('output/playwright/transcript.png', (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript('window.__captureDone=true');
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    await win.webContents.executeJavaScript('window.__captureDone=true');
    const result = await testRun;
    if (typeof result === 'string' && result.startsWith('FAIL:')) throw Error(result);
    if (created[0].harnessId !== 'dsh' || sent.length !== 2) throw Error('Incorrect IPC route');
    if (created[1]?.options?.model?.id !== 'deepseek-v4-pro' || created[1].options.thinking !== 'high' || created[1].options.permissionMode !== 'approve') throw Error('Draft options not routed into createThread');
    if (approvals[0]?.response?.optionId !== 'allow') throw Error('Approval response not routed');
    if (models[0]?.id !== 'deepseek-v4-pro') throw Error('Model switch not routed');
    await win.webContents.executeJavaScript(`document.querySelector('#trigger').click();new Promise(r=>setTimeout(r,250))`);
    await fs.mkdir('output/playwright', { recursive: true });
    await fs.writeFile('output/playwright/desktop.png', (await win.webContents.capturePage()).toPNG());
    console.log(result); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
