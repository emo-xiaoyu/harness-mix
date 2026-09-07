/**
 * 轻量 Markdown 渲染（零依赖、XSS 安全）：先整体转义，再做块级/行内变换。
 * 所有 Harness 的回复统一经此渲染，保证跨 Harness 的对话呈现一致（对齐层在 Renderer，
 * 与 Adapter 无关，新增 Harness 自动获得同样的排版）。
 */
(function () {
  const PRE = '\u0000';   // 代码块占位符（转义后仍保持不变）
  const CODE = '\u0001'; // 行内代码占位符
  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** 行内规则：代码、加粗、斜体、删除线、链接（渲染为不可导航文本，URL 入 title，避免窗口跳转） */
  function inline(s) {
    const codes = [];
    // 行内代码先抽离为占位符，避免其中的 ** 等被后续规则误伤
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => { codes.push(`<code>${c}</code>`); return CODE + (codes.length - 1) + CODE; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]+)\]\((https?:[^\s)]+)\)/g, '<span class="md-link" title="$2">$1</span>');
    return s.replace(new RegExp(CODE + '(\\d+)' + CODE, 'g'), (_m, i) => codes[Number(i)]);
  }

  function renderTable(rows) {
    const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    return '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
      + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
  }

  function renderMarkdown(src) {
    const pres = [];
    // 围栏代码块最先抽离，内部内容不参与任何块级/行内规则
    const text = String(src ?? '').replace(/\r\n?/g, '\n')
      .replace(/```([^\n`]*)\n?([\s\S]*?)(?:\n?```|$)/g, (_m, _lang, code) => {
        pres.push(`<pre class="md-pre"><code>${escHtml(code.replace(/\n+$/, ''))}</code></pre>`);
        return `\n${PRE}${pres.length - 1}${PRE}\n`;
      });
    const lines = escHtml(text).split('\n');
    const out = [];
    let para = [], listItems = null, listType = 'ul', quote = [], tableRows = null;
    const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushList = () => { if (listItems) { out.push(`<${listType}>` + listItems.map(i => `<li>${inline(i)}</li>`).join('') + `</${listType}>`); listItems = null; } };
    const flushQuote = () => { if (quote.length) { out.push('<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>'); quote = []; } };
    const flushTable = () => {
      if (!tableRows) return;
      // 需要表头行 + 分隔行（---）才判定为表格，否则按普通段落处理
      if (tableRows.length >= 2 && /^\|?[\s:|-]+\|?$/.test(tableRows[1]) && tableRows[1].includes('-')) out.push(renderTable(tableRows));
      else out.push('<p>' + tableRows.map(inline).join('<br>') + '</p>');
      tableRows = null;
    };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };
    const preLine = new RegExp(`^${PRE}(\\d+)${PRE}$`);

    for (const line of lines) {
      const pre = line.match(preLine);
      if (pre) { flushAll(); out.push(pres[Number(pre[1])]); continue; }
      const trimmed = line.trim();
      if (!trimmed) { flushAll(); continue; }
      if (trimmed.includes('|') && /^\|.*\|?$/.test(trimmed)) { flushPara(); flushList(); flushQuote(); (tableRows ??= []).push(trimmed); continue; }
      flushTable();
      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (heading) { flushAll(); out.push(`<div class="md-h md-h${heading[1].length}">${inline(heading[2])}</div>`); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push('<hr class="md-hr">'); continue; }
      const ul = trimmed.match(/^[-*•]\s+(.+)$/);
      if (ul) { flushPara(); flushQuote(); if (!listItems || listType !== 'ul') { flushList(); listType = 'ul'; listItems = []; } listItems.push(ul[1]); continue; }
      const ol = trimmed.match(/^\d{1,3}[.)]\s+(.+)$/);
      if (ol) { flushPara(); flushQuote(); if (!listItems || listType !== 'ol') { flushList(); listType = 'ol'; listItems = []; } listItems.push(ol[1]); continue; }
      const q = trimmed.match(/^&gt;\s?(.*)$/);
      if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
      flushList(); flushQuote();
      para.push(trimmed);
    }
    flushAll();
    return out.join('');
  }

  window.renderMarkdown = renderMarkdown;
})();
