/* Native transcript presentation, independent of the Desktop's project UI. */
window.Transcript = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const duration = (start, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
  };
  const liveLabel = (start, now = Date.now()) => `正在执行 · ${duration(start, now) || '计时未记录'}`;
  function updateClocks(root = document) {
    root.querySelectorAll('[data-started-at]').forEach(el => {
      const start = Number(el.dataset.startedAt);
      if (Number.isFinite(start) && start > 0) el.textContent = liveLabel(start);
    });
  }
  function group(items, message, thread) {
    const tools = items.filter(i => i.kind === 'tool').map(i => (thread.tools ?? []).find(t => t.id === i.toolId && t.messageId === message.id)).filter(Boolean);
    const counts = new Map();
    const categories = { bash: '命令', exec_command: '命令', read: '读取', edit: '编辑', write: '写入', grep: '搜索', glob: '搜索' };
    tools.forEach(t => { const kind = categories[t.title] ?? t.title; counts.set(kind, (counts.get(kind) ?? 0) + 1); });
    const labels = { '命令': n => `运行了 ${n} 次命令`, '读取': n => `读取了文件 · ${n} 次`, '编辑': n => `编辑了文件 · ${n} 次`, '写入': n => `写入了文件 · ${n} 次`, '搜索': n => `搜索了 ${n} 次` };
    const running = tools.findLast(t => t.state === 'running');
    const failed = tools.filter(t => t.state === 'error').length;
    let label = [...counts].map(([kind, n]) => labels[kind]?.(n) ?? `调用了 ${kind}${n > 1 ? ' × ' + n : ''}`).join(' · ');
    if (running) label = `正在执行 ${running.title}` + (tools.length > 1 ? ` · 共 ${tools.length} 次调用` : '');
    if (failed) label += ` · ${failed} 项失败`;
    if (!label) label = message.streaming && items.some(i => !i.endedAt) ? '正在思考…' : '已思考';
    const body = items.map(item => {
      if (item.kind === 'thinking') return thinking(item, message.streaming);
      const nativeTool = tools.find(t => t.id === item.toolId);
      return nativeTool ? tool(nativeTool, item.id) : '';
    }).join('');
    return `<details class="turn-process activity-group" data-activity-id="${esc(items[0].id)}-group"><summary><span class="activity-indicator" aria-hidden="true"></span><b>${esc(label)}</b><span class="activity-chevron">›</span></summary><div class="turn-process-content">${body}</div></details>`;
  }
  function activity(id, label, content, state = '') {
    return `<details class="activity ${esc(state)}" data-activity-id="${esc(id)}"><summary><span class="activity-indicator" aria-hidden="true"></span><span>${esc(label)}</span><span class="activity-chevron" aria-hidden="true">›</span></summary><div class="activity-content">${content}</div></details>`;
  }
  function thinking(item, streaming) {
    const running = streaming && !item.endedAt;
    const elapsed = duration(item.at, item.endedAt);
    return activity(item.id, running ? '正在思考…' : `已思考${elapsed ? ' ' + elapsed : ''}`,
      `<div class="reasoning-text">${esc(item.text)}</div>`, running ? 'running' : '');
  }
  function tool(tool, key = tool.id) {
    const labels = { bash: '运行了命令', exec_command: '运行了命令', edit: '编辑了文件', write: '写入了文件', read: '读取了文件', view_image: '查看了图像' };
    const label = tool.state === 'running' ? `正在执行 ${tool.title}`
      : tool.state === 'error' ? `${tool.title} 执行失败`
      : tool.state === 'interrupted' ? `${tool.title} 已中断`
      : labels[tool.title] ?? `调用了 ${tool.title}`;
    const input = tool.input ? `<h4>输入</h4><pre>${esc(tool.input)}</pre>` : '';
    const output = tool.output ?? tool.detail;
    const content = `<div class="activity-meta">${esc(tool.title)} · ${esc(({ done: '已完成', running: '执行中', error: '失败', interrupted: '已中断' })[tool.state] ?? tool.state)} ${duration(tool.at, tool.endedAt)}</div>${input}${output ? `<h4>输出</h4><pre>${esc(output)}</pre>` : '<p>原生 Harness 未提供更多详情。</p>'}`;
    return activity(key, label, content, tool.state);
  }
  function message(message, thread) {
    const fromCore = Boolean(message.coreTurn && message.coreItems);
    if (!fromCore) return '<p class="review-note">历史记录尚未迁移。</p>';
    if (fromCore) {
      const turn = message.coreTurn;
      const running = ['created', 'starting', 'running', 'waiting_interaction'].includes(turn.status);
      const tools = message.coreItems.filter(i => i.type === 'tool_call').map(i => ({
        ...i, messageId: message.id, at: i.createdAt,
        endedAt: ['completed', 'cancelled', 'error'].includes(i.status) ? i.updatedAt : undefined,
      }));
      const items = message.coreItems.filter(i => ['agent_message', 'reasoning', 'tool_call'].includes(i.type)).map(i => ({
        id: i.id, kind: ({ agent_message: 'text', reasoning: 'thinking', tool_call: 'tool' })[i.type],
        text: i.content, phase: i.phase, toolId: i.id, at: i.createdAt,
        endedAt: ['completed', 'cancelled', 'error'].includes(i.status) ? i.updatedAt : undefined,
      }));
      thread = { ...thread, tools };
      const plan = message.coreItems.find(i => i.type === 'plan');
      message = { ...message, review: message.coreReview ?? message.review, corePlan: plan };
      message = { ...message, items, streaming: running, at: turn.startedAt, endedAt: turn.completedAt,
        stopReason: turn.status, text: '', thinking: '', waitingInteraction: turn.status === 'waiting_interaction' };
    }
    let body;
    let final = '';
    const settled = !message.streaming;
    const items = message.items ?? [];
    if (message.items?.length) {
      const parts = [];
      let pending = [];
      const flush = () => { if (pending.length) parts.push(group(pending, message, thread)); pending = []; };
      message.items.forEach((item, index) => {
        if (item.kind === 'text') {
          flush();
          if (item.phase === 'final') final += `<div class="md final-answer">${window.renderMarkdown(item.text)}</div>`;
          else parts.push(`<div class="md progress-message">${window.renderMarkdown(item.text)}</div>`);
        } else if (item.kind === 'thinking' || item.kind === 'tool') pending.push(item);
      });
      flush();
      body = parts.join('');
    } else { body = ''; }
    body += message.coreItems.filter(i => i.type === 'notice').map(i => `<p class="review-note">${esc(i.content)}</p>`).join('');
    if (fromCore && message.corePlan?.entries?.length) body += activity(message.corePlan.id, '执行计划', '<ol>' + message.corePlan.entries.map(entry => `<li>${esc(entry.content ?? entry.text)} · ${esc(entry.status)}</li>`).join('') + '</ol>');
    const elapsed = duration(message.at, message.endedAt);
    const status = message.stopReason === 'cancelled' ? '已停止' : message.stopReason === 'error' ? '执行出错' : message.stopReason === 'interrupted' ? '会话已中断' : '已处理';
    if (settled) {
      return `<div class="turn-header">${status} ${elapsed || '计时未记录'}</div>` + body + (final || '<p class="waiting">本轮未返回最终结论，可展开查看执行过程。</p>') + changeCard(message);
    }
    const process = `<div class="turn-header is-live">${message.waitingInteraction ? '<span>等待你的回答 · </span>' : ''}<time data-started-at="${message.at || ''}">${liveLabel(message.at)}</time></div>` + body + (!body ? '<p class="waiting">正在等待原生 Harness 回复…</p>' : '');
    return process + (message.reviewId ? `<div class="live-changes"><button data-review-message="${esc(message.id)}" data-live-review="${esc(message.id)}">查看已更改文件 <span>↗</span></button></div>` : message.reviewError ? `<p class="review-note">${esc(message.reviewError)}</p>` : '');
  }
  function changeCard(message) {
    const review = message.review;
    if (!review) return message.reviewError ? `<p class="review-note">${esc(message.reviewError)}</p>` : '';
    if (!review.files.length) return `<p class="review-note">本轮未检测到可审查的文本变更${review.skipped ? '（部分文件已跳过）' : ''}。</p>`;
    const total = key => review.files.reduce((sum, f) => sum + f[key], 0);
    const row = f => `<button class="change-file" data-review-message="${esc(message.id)}" data-review-path="${esc(f.path)}"><span>${esc(f.path)}</span><small>${f.undone ? '已撤回' : `<em>+${f.added}</em> <i>-${f.removed}</i>`}</small></button>`;
    return `<section class="change-card"><div class="change-heading"><div><b>本轮变更 ${review.files.length} 个文件</b><small><em>+${total('added')}</em> <i>-${total('removed')}</i></small></div><button data-review-message="${esc(message.id)}">审查与撤回</button></div>${review.files.slice(0, 4).map(row).join('')}${review.files.length > 4 ? `<details class="more-changes"><summary>再显示 ${review.files.length - 4} 个文件</summary>${review.files.slice(4).map(row).join('')}</details>` : ''}<p class="review-note">任务期间的工作区差异${review.skipped ? ' · 部分非文本/大文件已跳过' : ''}</p></section>`;
  }
  return { message, duration, liveLabel, updateClocks };
})();

window.UsageView = (() => {
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const count = n => !valid(n) ? '—' : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(Math.round(n));
  const percent = n => valid(n) ? `${+n.toFixed(1)}%` : '—';
  function data(usage = {}) {
    const tokens = Object.hasOwn(usage, 'tokens') ? usage.tokens : usage.used;
    const windowSize = Object.hasOwn(usage, 'contextWindow') ? usage.contextWindow : usage.size;
    const pct = valid(tokens) && valid(windowSize) && windowSize > 0 ? 100 * tokens / windowSize
      : Object.hasOwn(usage, 'tokens') ? null : usage.contextPercent;
    return { pct, label: percent(pct), rows: [
      ['上下文', `${percent(pct)} / ${count(windowSize)}`], ['上下文已用', count(tokens)],
      ['最近缓存命中率', valid(usage.cacheHitPercent) ? `CH ${percent(usage.cacheHitPercent)}` : '—'],
      ['缓存读取', count(usage.cacheRead)], ['缓存写入', count(usage.cacheWrite)],
      ['会话累计 Token', count(usage.totalTokens)], ['累计输入 / 输出', `${count(usage.input)} / ${count(usage.output)}`],
      ['费用（USD）', valid(usage.cost) ? `$${usage.cost.toFixed(4)}` : '—'],
    ] };
  }
  return { data };
})();
