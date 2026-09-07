window.Workbench = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let context = {}, panel, content, active = '', selectedMessage, callbacks, generation = 0, sessions = [];
  let polling = false, selectedFile = '', filter = '';
  const liveCounts = new Map();
  function paintLiveCounts() {
    document.querySelectorAll('[data-live-review]').forEach(b => {
      const result = liveCounts.get(context.threadId + ':' + b.dataset.liveReview);
      if (result) b.innerHTML = `${result.files.length} 个文件已更改 <em>+${result.files.reduce((s, f) => s + f.added, 0)}</em> <i>-${result.files.reduce((s, f) => s + f.removed, 0)}</i> <span>↗</span>`;
    });
  }
  const api = () => window.harnessMix;
  const input = extra => ({ threadId: context.threadId, cwd: context.cwd, ...extra });
  const empty = text => `<p class="wb-empty">${esc(text)}</p>`;
  function init(options) {
    callbacks = options;
    panel = document.createElement('section'); panel.className = 'workbench'; panel.hidden = true;
    panel.innerHTML = `<div class="wb-tabs" role="tablist" aria-label="右侧工作区"><button data-wb="review" role="tab">审查</button><button data-wb="terminal" role="tab">终端</button><button data-wb="files" role="tab">文件</button><button class="wb-close" aria-label="关闭右侧工作区">×</button></div><div class="wb-context"></div><div class="wb-content"></div>`;
    document.querySelector('.app').append(panel); content = panel.querySelector('.wb-content');
    const handle = document.createElement('div');
    handle.className = 'wb-resize'; handle.tabIndex = 0; handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', '调整右侧面板宽度'); handle.setAttribute('aria-orientation', 'vertical');
    panel.prepend(handle);
    const layout = document.querySelector('.app');
    let preferredWidth = Number(localStorage.getItem('workbenchWidth')) || Math.round(innerWidth * .4);
    function resize(width, save = false) {
      const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect().width || (innerWidth <= 1150 ? 185 : 230);
      const maximum = Math.max(320, innerWidth - sidebar - 300);
      const next = Math.round(Math.max(320, Math.min(maximum, width)));
      layout.style.setProperty('--workbench-width', next + 'px');
      handle.setAttribute('aria-valuemin', '320'); handle.setAttribute('aria-valuemax', String(maximum)); handle.setAttribute('aria-valuenow', String(next));
      if (save) { preferredWidth = next; localStorage.setItem('workbenchWidth', String(next)); }
    }
    resize(preferredWidth);
    window.addEventListener('resize', () => resize(preferredWidth));
    handle.onpointerdown = e => { if (e.button !== 0) return; e.preventDefault(); handle.setPointerCapture(e.pointerId); layout.classList.add('resizing'); };
    handle.onpointermove = e => { if (handle.hasPointerCapture(e.pointerId)) resize(innerWidth - e.clientX, true); };
    handle.onpointerup = e => { if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); layout.classList.remove('resizing'); };
    handle.onlostpointercapture = () => layout.classList.remove('resizing');
    handle.ondblclick = () => resize(innerWidth * .4, true);
    handle.onkeydown = e => { if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return; e.preventDefault(); resize(e.key === 'Home' ? innerWidth * .4 : Number(handle.getAttribute('aria-valuenow')) + (e.key === 'ArrowLeft' ? 20 : -20), true); };
    panel.querySelector('.wb-close').onclick = toggle;
    const gitTab = document.createElement('button'); gitTab.dataset.wb = 'git'; gitTab.textContent = 'Git'; gitTab.setAttribute('role', 'tab');
    panel.querySelector('.wb-close').before(gitTab);
    panel.querySelectorAll('[data-wb]').forEach(button => { button.onclick = () => open(button.dataset.wb); });
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-review-message]');
      if (button) { selectedMessage = button.dataset.reviewMessage; void open('review', button.dataset.reviewPath); }
    });
    document.addEventListener('keydown', event => {
      if (!event.ctrlKey) return;
      const kind = event.shiftKey && event.key.toLowerCase() === 'g' ? 'review' : event.key === '`' ? 'terminal' : event.key.toLowerCase() === 'p' ? 'files' : null;
      if (kind) { event.preventDefault(); void open(kind); }
    });
  }
  async function onReview(event) {
    if (event.threadId !== context.threadId) return;
    const message = context.messages?.find(m => m.id === event.turnId);
    if (!message) return;
    if (event.error) {
      const caption = content.querySelector('.wb-caption');
      if (!panel.hidden && active === 'review' && caption) caption.textContent = '实时变更暂不可用：' + event.error;
      return;
    }
    const result = event.review;
    if (!result) return;
    liveCounts.set(event.threadId + ':' + message.id, result);
    paintLiveCounts();
    if (polling) return;
    polling = true;
    const token = generation;
    try {
      const editingFilter = content.contains(document.activeElement) && document.activeElement.matches('input, select');
      if (!panel.hidden && active === 'review' && selectedMessage === message.id && !editingFilter && !content.querySelector('.wb-file-preview')) {
        // Refresh open diffs too: same-sized edits can have different contents.
        const scroll = content.scrollTop;
        await review(token, selectedFile, result);
        if (token === generation) content.scrollTop = scroll;
      }
    } catch (e) {
      if (token === generation && !panel.hidden && active === 'review') {
        const caption = content.querySelector('.wb-caption');
        if (caption) caption.textContent = '实时变更暂不可用：' + e.message;
      }
    } finally { polling = false; }
  }
  function toggle() {
    if (panel.hidden) void open(active || 'home');
    else { panel.hidden = true; document.querySelector('.app').classList.remove('with-workbench'); generation++; }
  }
  function setContext(next) {
    const changed = next.threadId !== context.threadId || next.cwd !== context.cwd;
    const reviewChanged = JSON.stringify(next.messages.map(m => m.review)) !== JSON.stringify(context.messages?.map(m => m.review));
    context = structuredClone(next);
    if (!panel) return;
    panel.querySelector('.wb-context').textContent = context.cwd || '尚未选择项目';
    if (changed) { selectedMessage = null; selectedFile = ''; filter = ''; sessions = []; liveCounts.clear(); }
    for (const m of next.messages) if (m.liveReview) liveCounts.set(next.threadId + ':' + m.id, m.liveReview);
    paintLiveCounts();
    if (!panel.hidden && (changed || (reviewChanged && active === 'review'))) void open(active, selectedFile);
  }
  async function open(kind, file) {
    active = kind; panel.hidden = false; document.querySelector('.app').classList.add('with-workbench');
    panel.querySelectorAll('[data-wb]').forEach(b => { b.classList.toggle('active', b.dataset.wb === kind); b.setAttribute('aria-selected', String(b.dataset.wb === kind)); });
    const token = ++generation;
    content.innerHTML = empty('正在读取…');
    try {
      if (kind === 'review') await review(token, file);
      else if (kind === 'files') await directory('', token);
      else if (kind === 'terminal') await terminal(token);
      else if (kind === 'git') await window.GitPanel.render(content, { target: input(), current: () => token === generation, status: context.status, ...callbacks });
      else {
        content.innerHTML = '<div class="wb-home"><h3>工作区</h3><button data-open="review">审查 <kbd>Ctrl+Shift+G</kbd></button><button data-open="terminal">终端 <kbd>Ctrl+`</kbd></button><button data-open="files">文件 <kbd>Ctrl+P</kbd></button></div>';
        content.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => open(b.dataset.open); });
      }
    } catch (e) { if (token === generation) content.innerHTML = empty(e.message); }
  }
  async function review(token, file, snapshot) {
    const turns = context.messages.filter(m => m.review || m.reviewId);
    if (!turns.length) { content.innerHTML = empty('此任务尚无本轮文件快照。建立快照后即可查看执行中的变更。'); return; }
    let message = turns.find(m => m.id === selectedMessage) ?? turns.at(-1);
    selectedMessage = message.id;
    const result = snapshot ?? await api().review(input({ messageId: message.id }));
    if (token !== generation) return;
    selectedFile = result.files.some(f => f.path === file) ? file : result.files[0]?.path;
    const totals = `<em>+${result.files.reduce((s, f) => s + f.added, 0)}</em> <i>-${result.files.reduce((s, f) => s + f.removed, 0)}</i>`;
    content.innerHTML = `<div class="wb-review-toolbar"><select aria-label="选择审查轮次">${turns.map((m, i) => `<option value="${esc(m.id)}" ${m.id === message.id ? 'selected' : ''}>${m.streaming ? '正在执行' : '第 ' + (i + 1) + ' 轮'}</option>`).join('')}</select><small class="diff-count">${totals}</small><button class="wb-refresh">刷新</button></div><p class="wb-caption">${result.live ? '实时变更 · 每 2 秒更新 · 执行中只读' : '本轮前后差异 · 可审查与撤回'}${result.skipped ? ' · 部分文件已跳过' : ''}<br>同期手动编辑也会计入本轮变更。</p><div class="wb-review-layout"><div class="wb-diffs"></div><aside class="wb-change-tree"><input aria-label="筛选变更文件" placeholder="筛选文件…" value="${esc(filter)}"><div class="wb-tree-files"></div></aside></div>`;
    const tree = content.querySelector('.wb-tree-files');
    for (const change of result.files) {
      const button = document.createElement('button');
      button.className = 'wb-tree-file' + (change.path === selectedFile ? ' selected' : '');
      button.title = change.path;
      button.innerHTML = `<span>${esc(change.path)}</span><small class="diff-count"><em>+${change.added}</em> <i>-${change.removed}</i></small>`;
      button.hidden = !change.path.toLowerCase().includes(filter.toLowerCase());
      button.onclick = () => { selectedFile = change.path; void open('review', selectedFile); };
      tree.append(button);
    }
    content.querySelector('.wb-change-tree input').oninput = e => {
      filter = e.target.value;
      tree.querySelectorAll('button').forEach(b => { b.hidden = !b.title.toLowerCase().includes(filter.toLowerCase()); });
    };
    content.querySelector('select').onchange = e => { selectedMessage = e.target.value; void open('review'); };
    content.querySelector('.wb-refresh').onclick = () => open('review', selectedFile);
    const diffs = content.querySelector('.wb-diffs');
    if (!result.files.length) diffs.innerHTML = empty('本轮没有可审查的文本变更。');
    for (const change of result.files.filter(f => f.path === selectedFile)) {
      const card = document.createElement('details'); card.className = 'wb-diff';
      card.innerHTML = `<summary><span>${esc(change.path)}</span><small class="diff-count"><em>+${change.added}</em> <i>-${change.removed}</i></small></summary><div class="wb-diff-actions"><button class="wb-file">查看当前文件</button><button class="wb-undo" ${change.undone || result.live ? 'disabled' : ''}>${result.live ? '执行中不可撤回' : change.undone ? '已撤回' : '撤回此文件'}</button></div><div class="wb-code">正在读取差异…</div>`;
      diffs.append(card);
      let loaded = false;
      card.addEventListener('toggle', async () => {
        if (!card.open || loaded) return;
        loaded = true;
        try {
          const detail = await api().review(input({ messageId: message.id, path: change.path }));
          if (token !== generation) return;
          card.querySelector('.wb-code').innerHTML = (detail.coarse ? '<p>大文件使用整段替换差异。</p>' : '') + renderLines(detail.rows);
        } catch (e) { card.querySelector('.wb-code').textContent = e.message; }
      });
      card.querySelector('.wb-file').onclick = () => { void showFile(change.path, token); };
      card.querySelector('.wb-undo').onclick = async () => {
        const target = input({ messageId: message.id, path: change.path });
        if (!await callbacks.confirm({ title: '撤回此文件的本轮修改？', message: `${change.path} 将恢复至本轮开始前。后续修改冲突会阻止撤回；两份版本保留在审查记录中。`, okText: '撤回', danger: true })) return;
        try { await api().undoFile(target); callbacks.notice('已撤回此文件；审查记录保留修改前后版本。'); await open('review', change.path); }
        catch (e) { callbacks.notice(e.message); }
      };
      card.open = true;
    }
  }
  function renderLines(rows) {
    return rows.map(row => `<div class="code-line ${row.kind}"><span class="line-number">${row.old ?? ''}</span><span class="line-number">${row.next ?? ''}</span><span class="line-sign">${row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ''}</span><code>${esc(row.text)}</code></div>`).join('');
  }
  async function directory(relative, token = ++generation) {
    const entries = await api().listFiles(input({ path: relative }));
    if (token !== generation) return;
    const parent = relative.split(/[\\/]/).slice(0, -1).join('/');
    content.innerHTML = `<div class="wb-file-toolbar"><button class="wb-parent" ${!relative ? 'disabled' : ''}>上一级</button><span>${esc(relative || '项目根目录')}</span></div><div class="wb-file-list"></div><p class="wb-caption">只读预览 · 隐藏依赖、构建产物、敏感路径及链接。</p>`;
    content.querySelector('.wb-parent').onclick = () => safeDirectory(parent);
    const list = content.querySelector('.wb-file-list');
    entries.forEach(entry => {
      const button = document.createElement('button');
      button.className = entry.directory ? 'is-directory' : '';
      button.textContent = (entry.directory ? '▱  ' : '   ') + entry.name;
      button.onclick = () => entry.directory ? safeDirectory(entry.path) : void showFile(entry.path, token);
      list.append(button);
    });
  }
  async function safeDirectory(relative) { try { await directory(relative); } catch (e) { callbacks.notice(e.message); } }
  async function showFile(file, token) {
    try {
      const result = await api().readFile(input({ path: file }));
      if (token !== generation) return;
      const holder = document.createElement('div'); holder.className = 'wb-file-preview';
      holder.innerHTML = `<div class="wb-file-toolbar"><button>返回</button><span>${esc(file)}</span></div><div class="wb-code">${renderLines(result.text.split('\n').map((text, i) => ({ kind: 'same', next: i + 1, text })))}</div>`;
      const previous = [...content.childNodes]; content.replaceChildren(holder);
      holder.querySelector('button').onclick = () => content.replaceChildren(...previous);
    } catch (e) { callbacks.notice(e.message); }
  }
  async function terminal(token) {
    sessions = await api().terminalList(input());
    if (token !== generation) return;
    content.innerHTML = `<div class="wb-terminal"><p class="wb-caption">PowerShell 7 命令终端 · 每条命令从项目目录启动。暂不支持交互式 TUI、stdin 与跨命令 shell 状态。</p><div class="terminal-output" tabindex="0" aria-label="终端输出"></div><form class="terminal-form"><textarea aria-label="终端命令" placeholder="输入命令，例如 Get-Location" rows="2"></textarea><div><button type="submit">运行</button><button type="button" class="terminal-stop">停止</button></div></form></div>`;
    content.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const command = content.querySelector('textarea').value;
      try { const session = await api().terminalRun(input({ command })); onTerminal(session); }
      catch (error) { callbacks.notice(error.message); }
    };
    content.querySelector('.terminal-stop').onclick = async () => {
      try { for (const s of sessions.filter(s => s.running)) await api().terminalStop(input({ id: s.id })); }
      catch (e) { callbacks.notice(e.message); }
    };
    updateTerminal();
  }
  function onTerminal(session) {
    if (!context.cwd || session.root.toLowerCase() !== context.cwd.toLowerCase()) return;
    const index = sessions.findIndex(s => s.id === session.id);
    if (index < 0) sessions.push(session); else sessions[index] = session;
    if (active === 'terminal' && !panel.hidden) updateTerminal();
  }
  function updateTerminal() {
    const output = content.querySelector('.terminal-output'); if (!output) return;
    const bottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
    output.textContent = sessions.map(s => `PS> ${s.command}\n${s.output}\n${s.running ? '执行中…' : '[退出码 ' + s.exitCode + ']'}\n`).join('\n') || '尚未运行命令。';
    if (bottom) output.scrollTop = output.scrollHeight;
    content.querySelector('[type=submit]').disabled = sessions.some(s => s.running);
    content.querySelector('.terminal-stop').disabled = !sessions.some(s => s.running);
  }
  return { init, toggle, setContext, onTerminal, onReview, open };
})();
