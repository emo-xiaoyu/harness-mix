import { collaborationIcon } from './collaboration-icon.js';
export interface CollaborationAgent { id: string; name: string; available: boolean; lead: boolean }
export interface CollaborationSession { id: string; title: string; harnessId: string; cwd: string; running: boolean | null }
export interface CollaborationMentionCatalog { agents: CollaborationAgent[]; sessions: CollaborationSession[]; canDelegate?: boolean }
type MentionEntry = ({ kind: 'agent' } & CollaborationAgent) | ({ kind: 'session' } & CollaborationSession);

/** Adds native-Harness suggestions while preserving the original composer editor. */
export function installHarnessMentions(load: (editor: Element, query: string) => Promise<CollaborationMentionCatalog>) {
  const menu = document.createElement('div');
  menu.dataset.harnessMixMentions = 'true';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '协作 Harness');
  menu.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;max-height:320px;overflow:auto;width:340px;max-width:calc(100vw - 16px);padding:6px;border:1px solid #8884;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 8px 30px #0002;font:13px system-ui';
  menu.hidden = true;
  document.body.append(menu);
  // The native @ surface and our Harness picker otherwise open at the same time.
  // Scope suppression to this composer and this active mention only.
  const style = document.createElement('style');
  style.textContent = '[data-harness-mix-mention-active] [data-composer-overlay-floating-ui="true"]{display:none!important}';
  document.head.append(style);
  let activeComposer: Element | null = null;
  let generation = 0, disposed = false, selected = 0;
  let editor: HTMLTextAreaElement | HTMLElement | null = null;
  let range: Range | null = null, start = 0, end = 0;
  let entries: MentionEntry[] = [];
  let matches: MentionEntry[] = [], activeKind: 'agent' | 'session' = 'agent', canDelegate = true;
  const catalogs = new Map<HTMLElement, CollaborationMentionCatalog>();
  const badges = new Map<HTMLElement, HTMLElement>();
  const syncBadges = (target: HTMLElement) => {
    for (const [old, strip] of badges) if (!old.isConnected) { strip.remove(); badges.delete(old); catalogs.delete(old); }
    const text = (target instanceof HTMLTextAreaElement ? target.value : target.textContent ?? '').replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
    const ids = new Set([...text.matchAll(/(?:^|[\s，。；：])@([\w-]+)(?=$|[\s，。；：])/g)].map(m => m[1]));
    const catalog = catalogs.get(target) ?? { agents: [], sessions: [] };
    const selectedAgents = catalog.agents.filter(a => ids.has(a.id));
    const sessionIds = new Set([...text.matchAll(/\]\(harness-mix:\/\/session\/([A-Za-z0-9_-]+)\)/g)].map(match => match[1]));
    const selectedSessions = catalog.sessions.filter(session => sessionIds.has(session.id));
    let strip = badges.get(target);
    if (!strip && !selectedAgents.length && !selectedSessions.length) return;
    if (!strip) {
      strip = document.createElement('div'); strip.dataset.harnessMixSelectedMentions = 'true';
      strip.setAttribute('aria-label', '已提及的协作者');
      strip.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:6px 0';
      target.after(strip); badges.set(target, strip);
    }
    strip.replaceChildren(); strip.style.display = selectedAgents.length || selectedSessions.length ? 'flex' : 'none';
    for (const agent of selectedAgents) {
      const badge = document.createElement('span');
      badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #8883;border-radius:8px;font:12px inherit;background:#8881';
      badge.append(collaborationIcon(agent.id, agent.name, 16), document.createTextNode(agent.name));
      badge.title = `@${agent.id}${agent.available ? '' : ' · 未就绪'}`; strip.append(badge);
    }
    for (const session of selectedSessions) {
      const badge = document.createElement('span');
      badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #8883;border-radius:8px;font:12px inherit;background:#8881';
      badge.append(collaborationIcon(session.harnessId, session.harnessId, 16), document.createTextNode(session.title));
      badge.title = `历史会话 · ${session.cwd}`; strip.append(badge);
    }
  };
  const close = () => { generation++; menu.hidden = true; activeComposer?.removeAttribute('data-harness-mix-mention-active'); activeComposer = null; };
  const choose = (entry: MentionEntry) => {
    if (!editor || (entry.kind === 'agent' ? !entry.available || !canDelegate : entry.running === true)) return;
    const target = editor;
    const inserted = entry.kind === 'agent' ? `@${entry.id} ` : `@[${entry.title.replace(/[\[\]()\r\n]/g, '')}](harness-mix://session/${entry.id}) `;
    close(); target.focus();
    if (target instanceof HTMLTextAreaElement) {
      target.setSelectionRange(start, end);
      if (!document.execCommand('insertText', false, inserted)) {
        target.setRangeText(inserted, start, end, 'end');
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (range) {
      // ProseMirror may replace text nodes while its own suggestions render.
      // Rebuild the saved text offsets instead of reusing a live, stale Range.
      const replacement = document.createRange();
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let offset = 0, foundStart = false, foundEnd = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (!foundStart && start <= offset + length) { replacement.setStart(node, start - offset); foundStart = true; }
        if (foundStart && end <= offset + length) { replacement.setEnd(node, end - offset); foundEnd = true; break; }
        offset += length;
      }
      if (!foundEnd) return;
      const selection = window.getSelection();
      selection?.removeAllRanges(); selection?.addRange(replacement);
      document.dispatchEvent(new Event('selectionchange'));
      document.execCommand('insertText', false, inserted);
    }
    // Dismiss the native search opened by the inserted literal @ mention.
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    syncBadges(target);
  };
  const render = () => {
    menu.replaceChildren();
    const tabs = document.createElement('div'); tabs.setAttribute('role', 'tablist');
    tabs.style.cssText = 'display:flex;gap:4px;padding:2px 2px 6px;border-bottom:1px solid #8882;margin-bottom:4px';
    for (const kind of ['agent', 'session'] as const) {
      const tab = document.createElement('button'); tab.type = 'button'; tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(activeKind === kind));
      tab.textContent = `${kind === 'agent' ? 'Agents' : '会话'}  ${matches.filter(entry => entry.kind === kind).length}`;
      tab.style.cssText = `border:0;border-radius:6px;padding:6px 10px;color:inherit;font:inherit;cursor:pointer;background:${activeKind === kind ? '#8882' : 'transparent'}`;
      tab.addEventListener('mousedown', event => event.preventDefault());
      tab.addEventListener('click', () => { activeKind = kind; selected = 0; render(); }); tabs.append(tab);
    }
    menu.append(tabs);
    entries = matches.filter(entry => entry.kind === activeKind);
    if (!entries.length || (activeKind === 'agent' && !canDelegate)) {
      const notice = document.createElement('div');
      notice.textContent = !canDelegate && activeKind === 'agent'
        ? '当前主 Agent 未接入协作工具。请切换到 Codex（协作）、Claude Code、Pi 或 Oh My Pi 后分派任务。'
        : activeKind === 'agent' ? '没有匹配的 Agent' : '没有匹配的历史会话';
      notice.style.cssText = 'padding:10px 8px;font-size:12px;line-height:1.6;opacity:.65'; menu.append(notice);
    }
    const list = document.createElement('div'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', activeKind === 'agent' ? '协作 Agents' : '历史会话'); menu.append(list);
    entries.forEach((entry, index) => {
      const row = document.createElement('button');
      row.type = 'button'; row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      const available = entry.kind === 'agent' ? entry.available && canDelegate : entry.running !== true;
      row.disabled = !available;
      row.id = `harness-mention-option-${index}`;
      row.style.cssText = `display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;border-radius:7px;padding:7px 8px;color:inherit;font:inherit;cursor:pointer;background:${index === selected ? '#8882' : 'transparent'};opacity:${available ? 1 : .45}`;
      const copy = document.createElement('span'); copy.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex:1;min-width:0';
      const name = document.createElement('span'); name.textContent = entry.kind === 'agent' ? entry.name : entry.title; name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const detail = document.createElement('span'); detail.textContent = entry.kind === 'agent' ? `@${entry.id}` : entry.cwd; detail.style.cssText = 'font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      copy.append(name, detail);
      const status = document.createElement('span'); status.textContent = entry.kind === 'agent' ? (entry.available ? '可协作' : '未就绪') : (entry.running ? '运行中' : '引用'); status.style.cssText = 'font-size:11px;opacity:.6';
      row.append(collaborationIcon(entry.kind === 'agent' ? entry.id : entry.harnessId, name.textContent || ''), copy, status);
      row.addEventListener('mousedown', event => event.preventDefault());
      row.addEventListener('click', () => choose(entry));
      list.append(row);
    });
  };
  const input = async (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest('[data-codex-composer-root]')) return;
    const editable = target.closest('textarea,[contenteditable="true"]');
    if (!(editable instanceof HTMLElement)) return;
    editor = editable;
    syncBadges(editable);
    let prefix = '';
    range = null;
    if (editable instanceof HTMLTextAreaElement) {
      if (editable.selectionStart !== editable.selectionEnd) { close(); return; }
      end = editable.selectionStart; prefix = editable.value.slice(0, end);
    } else {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed) { close(); return; }
      const caret = selection.getRangeAt(0);
      if (!editable.contains(caret.startContainer) || caret.startContainer.nodeType !== Node.TEXT_NODE) { close(); return; }
      const before = caret.cloneRange(); before.selectNodeContents(editable); before.setEnd(caret.startContainer, caret.startOffset);
      prefix = before.toString(); end = prefix.length;
      range = caret.cloneRange();
    }
    const match = /(?:^|[\s，。；：])@([\p{L}\p{N}_-]*)$/u.exec(prefix);
    if (!match) { close(); return; }
    const length = match[1]!.length + 1;
    start = end - length;
    const current = ++generation;
    try {
      const catalog = await load(editable, match[1]!.toLowerCase());
      if (disposed || current !== generation) return;
      catalogs.set(editable, catalog); syncBadges(editable);
      const query = match[1]!.toLowerCase();
      canDelegate = catalog.canDelegate !== false;
      matches = [
        ...catalog.agents.filter(a => a.id.toLowerCase().includes(query) || a.name.toLowerCase().includes(query)).map(a => ({ kind: 'agent' as const, ...a })),
        ...catalog.sessions.filter(session => `${session.title} ${session.cwd}`.toLowerCase().includes(query)).map(session => ({ kind: 'session' as const, ...session })),
      ];
      activeKind = query && !matches.some(entry => entry.kind === 'agent') && matches.some(entry => entry.kind === 'session') ? 'session' : 'agent';
      entries = matches.filter(entry => entry.kind === activeKind);
      selected = Math.max(0, entries.findIndex(entry => entry.kind === 'agent' ? entry.available && canDelegate : entry.running !== true));
      render(); menu.hidden = !catalog.agents.length && !catalog.sessions.length && catalog.canDelegate === undefined;
      activeComposer?.removeAttribute('data-harness-mix-mention-active');
      activeComposer = !menu.hidden ? editable.closest('[data-codex-composer-root]') : null;
      activeComposer?.setAttribute('data-harness-mix-mention-active', 'true');
      menu.scrollTop = 0;
      const rect = editable.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 348))}px`;
      const above = rect.top - 16;
      menu.style.maxHeight = `${Math.max(80, Math.min(320, above >= 160 ? above : window.innerHeight - rect.bottom - 16))}px`;
      menu.style.bottom = above >= 160 ? `${window.innerHeight - rect.top + 8}px` : 'auto';
      menu.style.top = above >= 160 ? 'auto' : `${rect.bottom + 8}px`;
    } catch { close(); }
  };
  const keydown = (event: KeyboardEvent) => {
    if (menu.hidden || event.isComposing) return;
    // Let the native editor dismiss its own mention state as well.
    if (event.key === 'Escape') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { activeKind = activeKind === 'agent' ? 'session' : 'agent'; selected = 0; render(); }
    else if (event.key === 'Enter' || event.key === 'Tab') { const entry = entries[selected]; if (entry) choose(entry); }
    else {
      for (let i = 0; i < entries.length; i++) { selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length; const entry = entries[selected]; if (entry && (entry.kind === 'agent' ? entry.available && canDelegate : entry.running !== true)) break; }
      render(); menu.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
  };
  const outside = (event: Event) => { if (event.target instanceof Node && !menu.contains(event.target)) close(); };
  document.addEventListener('input', input, true);
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('mousedown', outside);
  window.addEventListener('blur', close);
  return { dispose() {
    disposed = true; close(); menu.remove(); style.remove();
    for (const strip of badges.values()) strip.remove(); badges.clear(); catalogs.clear();
    document.removeEventListener('input', input, true);
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('mousedown', outside);
    window.removeEventListener('blur', close);
  } };
}
