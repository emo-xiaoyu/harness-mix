import { collaborationIcon } from './collaboration-icon.js';
export interface CollaborationAgent { id: string; name: string; available: boolean; lead: boolean }
export interface CollaborationSession { id: string; title: string; harnessId: string; cwd: string; running: boolean | null }
export interface CollaborationMentionCatalog { agents: CollaborationAgent[]; sessions: CollaborationSession[]; canDelegate?: boolean }
type MentionEntry = ({ kind: 'agent' } & CollaborationAgent) | ({ kind: 'session' } & CollaborationSession);

const entryKey = (entry: MentionEntry): string => entry.kind === 'agent' ? `agent:${entry.id}` : `session:${entry.id}`;

// Encode an entry as the @agent literal the Host expects in the submitted text.
const entryLiteral = (entry: MentionEntry): string => entry.kind === 'agent'
  ? `@${entry.id} `
  : `@[${entry.title.replace(/[\[\]()\r\n]/g, '')}](harness-mix://session/${entry.id}) `;

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

  // Per-editor mention state, decoupled from editor text so the literal
  // @agent handles never leak into the visible composer.
  const selections = new Map<HTMLElement, Map<string, MentionEntry>>();
  const selectionsFor = (target: HTMLElement): Map<string, MentionEntry> => {
    let perEditor = selections.get(target);
    if (!perEditor) {
      perEditor = new Map();
      selections.set(target, perEditor);
    }
    return perEditor;
  };

  const replaceSelectionWith = (target: HTMLElement, replacement: string): boolean => {
    if (target instanceof HTMLTextAreaElement) {
      target.setSelectionRange(start, end);
      target.setRangeText(replacement, start, end, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // ProseMirror may replace text nodes while its own suggestions render.
    // Rebuild the saved text offsets instead of reusing a live, stale Range.
    const fresh = document.createRange();
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let offset = 0, foundStart = false, foundEnd = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (!foundStart && start <= offset + length) { fresh.setStart(node, start - offset); foundStart = true; }
      if (foundStart && end <= offset + length) { fresh.setEnd(node, end - offset); foundEnd = true; break; }
      offset += length;
    }
    if (!foundEnd) return false;
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(fresh);
    document.dispatchEvent(new Event('selectionchange'));
    document.execCommand('insertText', false, replacement);
    return true;
  };

  const syncBadges = (target: HTMLElement) => {
    for (const [old, strip] of badges) if (!old.isConnected) { strip.remove(); badges.delete(old); catalogs.delete(old); }
    const perEditor = selections.get(target);
    const hasAny = !!perEditor && perEditor.size > 0;
    let strip = badges.get(target);
    if (!strip && !hasAny) return;
    if (!strip) {
      strip = document.createElement('div'); strip.dataset.harnessMixSelectedMentions = 'true';
      strip.setAttribute('aria-label', '已提及的协作者');
      strip.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:6px 0';
      target.after(strip); badges.set(target, strip);
    }
    strip.replaceChildren(); strip.style.display = hasAny ? 'flex' : 'none';
    if (!perEditor) return;
    for (const entry of perEditor.values()) {
      const badge = document.createElement('span');
      badge.dataset.harnessMixMentionBadge = entry.kind === 'agent' ? `agent:${entry.id}` : `session:${entry.id}`;
      badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #8883;border-radius:8px;font:12px inherit;background:#8881';
      const iconWrap = document.createElement('span');
      iconWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
      iconWrap.append(
        collaborationIcon(entry.kind === 'agent' ? entry.id : entry.harnessId, entry.kind === 'agent' ? entry.name : entry.title, 16),
        document.createTextNode(entry.kind === 'agent' ? entry.name : entry.title),
      );
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.harnessMixMentionRemove = entry.kind === 'agent' ? `agent:${entry.id}` : `session:${entry.id}`;
      const removeLabel = entry.kind === 'agent' ? `移除 ${entry.name}` : `移除会话 ${entry.title}`;
      remove.setAttribute('aria-label', removeLabel);
      remove.title = removeLabel;
      remove.textContent = '×';
      remove.style.cssText = 'border:0;background:transparent;color:inherit;cursor:pointer;padding:0 0 0 2px;margin:0;font:600 14px/1 inherit;opacity:.55;line-height:1;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%';
      remove.addEventListener('mouseenter', () => { remove.style.opacity = '1'; remove.style.background = '#8883'; });
      remove.addEventListener('mouseleave', () => { remove.style.opacity = '.55'; remove.style.background = 'transparent'; });
      remove.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
      remove.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const live = selections.get(target);
        if (!live) return;
        live.delete(entryKey(entry));
        syncBadges(target);
      });
      badge.append(iconWrap, remove);
      badge.title = entry.kind === 'agent' ? `@${entry.id}${entry.available ? '' : ' · 未就绪'}` : `历史会话 · ${entry.cwd}`;
      strip.append(badge);
    }
  };
  const close = () => { generation++; menu.hidden = true; activeComposer?.removeAttribute('data-harness-mix-mention-active'); activeComposer = null; };
  const choose = (entry: MentionEntry) => {
    if (!editor || (entry.kind === 'agent' ? !entry.available || !canDelegate : entry.running === true)) return;
    const target = editor;
    close();
    target.focus();
    // Drop the @query trigger text the user typed to open the picker so the
    // editor stays free of literal @agent handles. The chip below carries
    // the same intent and is the only visible signal.
    replaceSelectionWith(target, '');
    // Toggle the entry in the per-editor selections; a second click removes it.
    const perEditor = selectionsFor(target);
    const key = entryKey(entry);
    if (perEditor.has(key)) perEditor.delete(key);
    else perEditor.set(key, entry);
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

  // The Host detects mentions by parsing `@agent` literals out of the submitted
  // text. The composer no longer carries those literals while the user is
  // typing, so before the native form submit reads the editor we re-attach
  // the mentions at the start of the value. The editor then clears itself
  // after Codex Desktop finishes dispatching the turn, hiding the literal
  // text again.
  const findEditorIn = (root: Element | null): HTMLElement | null => {
    if (!root) return null;
    if (root.matches('textarea,[contenteditable="true"]')) return root as HTMLElement;
    return root.querySelector<HTMLElement>('textarea,[contenteditable="true"]');
  };
  const injectMentionsInto = (target: HTMLElement): boolean => {
    const perEditor = selections.get(target);
    if (!perEditor || perEditor.size === 0) return false;
    const text = [...perEditor.values()].map(entryLiteral).join('');
    if (!text) return false;
    target.focus();
    if (target instanceof HTMLTextAreaElement) {
      target.value = `${text}${target.value}`;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const selection = window.getSelection();
    const fresh = document.createRange();
    fresh.selectNodeContents(target);
    fresh.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(fresh);
    document.dispatchEvent(new Event('selectionchange'));
    document.execCommand('insertText', false, text);
    return true;
  };
  const onSubmitCapture = (event: Event) => {
    const composerRoot = (event.target instanceof Element ? event.target : null)?.closest?.('[data-codex-composer-root]');
    const candidate = composerRoot ?? (event.target instanceof Element ? event.target : null);
    const editorEl = findEditorIn(candidate);
    if (!editorEl) return;
    if (!editorEl.closest('[data-codex-composer-root]')) return;
    injectMentionsInto(editorEl);
  };

  document.addEventListener('input', input, true);
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('mousedown', outside);
  document.addEventListener('submit', onSubmitCapture, true);
  window.addEventListener('blur', close);
  return { dispose() {
    disposed = true; close(); menu.remove(); style.remove();
    for (const strip of badges.values()) strip.remove(); badges.clear(); catalogs.clear();
    for (const [target, perEditor] of selections) if (!target.isConnected) selections.delete(target);
    document.removeEventListener('input', input, true);
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('submit', onSubmitCapture, true);
    window.removeEventListener('blur', close);
  } };
}