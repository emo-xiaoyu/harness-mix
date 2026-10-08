const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const bundle = await esbuild.build({ stdin: { contents: "export * from './src/native-ui/renderer-extension/src/renderer-harness-mentions.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Mentions', write: false });
  const win = new BrowserWindow({ show: false, width: 950, height: 720, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><body></body>'));
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const catalog = { agents: [{ id:'pi', name:'Pi', available:true, lead:true }, { id:'claude', name:'Claude Code', available:true, lead:true }], sessions: [], templates: [{ id:'review', name:'Review Team', description:'Review', members:[{name:'Reviewer',role:'review',agent:'pi',available:true}] }], canDelegate:true };
      const composer = () => {
        const root = document.createElement('div'); root.setAttribute('data-codex-composer-root','');
        root.style.cssText = 'position:absolute;left:40px;bottom:40px;width:600px';
        root.innerHTML = '<div data-above-composer-portal></div><textarea></textarea>'; document.body.append(root); return root;
      };
      const tick = () => new Promise(resolve => setTimeout(resolve, 30));
      const input = async (root, text) => {
        const editor = root.querySelector('textarea'); editor.focus(); editor.value=text; editor.setSelectionRange(text.length,text.length);
        editor.dispatchEvent(new Event('input',{bubbles:true})); await tick(); return editor;
      };
      const choosePi = async root => { await input(root,'#pi'); document.querySelector('[role=option]').click(); };
      const hasPi = root => !!root.querySelector('[data-harness-mix-mention-badge="agent:pi"]');
      const a = composer(), b = composer();
      const anonymous = Mentions.installHarnessMentions(async () => catalog);
      await choosePi(a); b.querySelector('textarea').focus(); await tick();
      const anonymousIsolated = !hasPi(b);
      b.querySelector('textarea').value='independent message'; anonymous.prepareSubmission(b);
      const anonymousText = b.querySelector('textarea').value;
      anonymous.dispose();
      const identities = new WeakMap([[a,'local:draft-a'],[b,'local:draft-b']]);
      const identified = Mentions.installHarnessMentions(async () => catalog, { getComposerIdentity: root => identities.get(root) ?? null });
      await choosePi(a); b.querySelector('textarea').focus(); await tick();
      const nativeIsolated = !hasPi(b);
      a.remove(); const replacement = composer(); identities.set(replacement,'local:draft-a');
      replacement.querySelector('textarea').focus(); await tick();
      const restored = hasPi(replacement);
      identities.set(replacement,'remote:draft-a'); identified.sync(replacement.querySelector('textarea'));
      const hostIsolated = !hasPi(replacement);
      identities.set(replacement,'local:draft-a'); identified.sync(replacement.querySelector('textarea'));
      replacement.querySelector('textarea').value='original task'; identified.prepareSubmission(replacement);
      const originalText = replacement.querySelector('textarea').value;
      const keyboardEditor = await input(replacement,'#');
      const selectedTabs = [];
      for (let i=0; i<3; i++) {
        keyboardEditor.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
        selectedTabs.push(document.querySelector('[role=tab][aria-selected=true]').textContent.trim());
      }
      keyboardEditor.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
      const leftTab = document.querySelector('[role=tab][aria-selected=true]').textContent.trim();
      keyboardEditor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      const teamChosen = !!replacement.querySelector('[data-harness-mix-mention-badge="template:review"]');
      const teamSvg = !!replacement.querySelector('[data-harness-mix-mention-badge="template:review"] svg');
      keyboardEditor.value='review changes'; identified.prepareSubmission(replacement);
      const teamText = keyboardEditor.value;
      identified.dispose();
      let rejectOld, resolveOld;
      const raced = Mentions.installHarnessMentions(async (_editor, query) => {
        if (query === 'pi') return await new Promise((_resolve, reject) => { rejectOld=reject; });
        if (query === 'slow') return await new Promise(resolve => { resolveOld=resolve; });
        if (query === 'bad') throw new Error('Current catalog request failed');
        return catalog;
      });
      const currentMenuReady = () => {
        const menu = document.querySelector('[data-harness-mix-mentions]');
        return !!menu && !menu.hidden && menu.querySelector('[role=option]')?.textContent.includes('Claude Code');
      };
      await input(replacement,'#pi'); await input(replacement,'#cl');
      const readyBeforeFailure = currentMenuReady();
      rejectOld(new Error('Old catalog request failed')); await tick();
      const staleFailureIgnored = currentMenuReady();
      await input(replacement,'#slow'); await input(replacement,'#cl');
      resolveOld(catalog); await tick();
      const staleSuccessIgnored = currentMenuReady();
      await input(replacement,'#bad');
      const currentFailureClosed = document.querySelector('[data-harness-mix-mentions]').hidden;
      await input(replacement,'#cl'); const recovered = currentMenuReady();
      await input(replacement,'#slow'); raced.dispose(); resolveOld(catalog); await tick();
      const disposedStayedClosed = !document.querySelector('[data-harness-mix-mentions]');
      return {anonymousIsolated,anonymousText,nativeIsolated,restored,hostIsolated,originalText,selectedTabs,leftTab,teamChosen,teamSvg,teamText,
        readyBeforeFailure,staleFailureIgnored,staleSuccessIgnored,currentFailureClosed,recovered,disposedStayedClosed};
    })()`);
    assert.equal(result.anonymousIsolated, true);
    assert.equal(result.anonymousText, 'independent message');
    assert.equal(result.nativeIsolated, true);
    assert.equal(result.restored, true, 'Native draft identity survives composer replacement');
    assert.equal(result.hostIsolated, true, 'Equal draft ids on different hosts do not share authorizations');
    assert.equal(result.originalText, '#pi original task');
    assert.deepEqual(result.selectedTabs.map(tab => tab.split(/\s+/)[0]), ['会话','团队','Agents']);
    assert.match(result.leftTab, /^团队/);
    assert.equal(result.teamChosen, true);
    assert.equal(result.teamSvg, true);
    assert.equal(result.teamText, '#[Review Team](harness-mix://team-template/review) review changes');
    assert.equal(result.readyBeforeFailure, true);
    assert.equal(result.staleFailureIgnored, true, 'A stale failure cannot dismiss a current menu');
    assert.equal(result.staleSuccessIgnored, true);
    assert.equal(result.currentFailureClosed, true);
    assert.equal(result.recovered, true);
    assert.equal(result.disposedStayedClosed, true);
    console.log('PASS: # mention draft/host isolation, restoration, team keyboard selection and stale/current catalog request handling');
  } finally { win.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
