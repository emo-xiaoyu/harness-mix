window.GitPanel = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function render(content, options) {
    const { target, current, notice, confirm } = options;
    const api = window.harnessMix;
    let data;
    try { data = await api.gitStatus(target); }
    catch (e) {
      if (!current()) return;
      content.innerHTML = `<p class="wb-empty">${esc(e.message)}</p>`;
      if (/not a git repository/i.test(e.message)) {
        const button = document.createElement('button'); button.textContent = '在当前项目初始化 Git'; content.append(button);
        button.onclick = () => change('init');
      }
      return;
    }
    if (!current()) return;
    const busy = options.status === 'working' || options.status === 'opening';
    content.innerHTML = `<section class="git-panel"><div class="wb-review-toolbar"><b>⑂ ${esc(data.branch)}</b><button class="git-refresh">刷新</button></div><p class="wb-caption">${esc(data.root)}${busy ? ' · 任务执行中，仅查看' : ''}</p><form class="git-commit"><textarea aria-label="提交说明" placeholder="提交说明（仅提交已暂存内容）" rows="2"></textarea><button ${busy || !data.files.some(f => f.staged) ? 'disabled' : ''}>提交已暂存</button></form><div class="git-files"></div><div class="git-preview" hidden></div><details class="git-history"><summary>最近提交 · ${data.log.length}</summary>${data.log.map(c => `<div><code>${esc(c.hash)}</code> ${esc(c.subject)}<small>${esc(c.author)} · ${esc(c.age)}</small></div>`).join('') || '<p>尚无提交</p>'}</details></section>`;
    content.querySelector('.git-refresh').onclick = () => render(content, options);
    content.querySelector('form').onsubmit = e => { e.preventDefault(); void change('commit', { message: content.querySelector('textarea').value }); };
    const list = content.querySelector('.git-files');
    for (const staged of [true, false]) {
      const entries = data.files.filter(f => staged ? f.staged : f.changed);
      const heading = document.createElement('h4'); heading.textContent = `${staged ? '已暂存' : '工作区变更'} · ${entries.length}`; list.append(heading);
      for (const file of entries) {
        const row = document.createElement('div'); row.className = 'git-row';
        row.innerHTML = `<button class="git-path" title="${esc(file.path)}"><code>${esc(staged ? file.index : file.worktree)}</code><span>${esc(file.path)}</span></button><button class="git-action" ${busy ? 'disabled' : ''}>${staged ? '取消暂存' : '暂存'}</button>`;
        row.querySelector('.git-action').onclick = () => change(staged ? 'unstage' : 'stage', { path: file.path });
        row.querySelector('.git-path').onclick = async () => {
          const preview = content.querySelector('.git-preview'); preview.hidden = false; preview.textContent = '正在读取差异…';
          try {
            const detail = await api.gitDiff({ ...target, path: file.path, staged });
            if (!current() || !preview.isConnected) return;
            preview.innerHTML = `<h4>${esc(file.path)} · ${staged ? '暂存区' : '工作区'}</h4><pre>${detail.text.split('\n').map(line => `<span class="${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : ''}">${esc(line)}\n</span>`).join('') || '没有文本差异'}</pre>`;
          } catch (e) { if (current() && preview.isConnected) preview.textContent = e.message; }
        };
        list.append(row);
      }
    }
    async function change(action, extra = {}) {
      if (!current()) return;
      if (action === 'commit' && !await confirm({ title: '提交已暂存的更改？', message: extra.message || '尚未填写提交说明', okText: '提交' })) return;
      if (!current()) return;
      content.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { await api.gitMutate({ ...target, action, ...extra }); if (current()) await render(content, options); }
      catch (e) { notice(e.message); if (current()) await render(content, options); }
    }
  }
  return { render };
})();
