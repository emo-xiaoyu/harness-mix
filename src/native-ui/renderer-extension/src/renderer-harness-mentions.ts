import { collaborationIcon } from "./collaboration-icon.js";

export interface CollaborationAgent {
  id: string;
  name: string;
  available: boolean;
  lead: boolean;
  description?: string;
}

export interface CollaborationSession {
  id: string;
  title: string;
  harnessId: string;
  cwd: string;
  running: boolean | null;
}

export interface CollaborationTeamTemplateMember {
  name: string;
  role: string;
  agent: string;
  available: boolean;
}

export interface CollaborationTeamTemplate {
  id: string;
  name: string;
  description: string;
  members: CollaborationTeamTemplateMember[];
  /** 项目作用域模板来自 <cwd>/.harness-mix/teams/*.md，随仓库走 */
  source?: 'project';
  builtin?: boolean;
}

export interface NativeCodexOption {
  id: string;
  title: string;
  description: string;
  category: string;
  icon?: string;
  action?: string;
}

export interface CollaborationMentionCatalog {
  agents: CollaborationAgent[];
  sessions: CollaborationSession[];
  templates?: CollaborationTeamTemplate[];
  codexOptions?: NativeCodexOption[];
  canDelegate?: boolean;
}

type MentionEntry =
  | ({ kind: 'agent' } & CollaborationAgent)
  | ({ kind: 'session' } & CollaborationSession)
  | ({ kind: 'template' } & CollaborationTeamTemplate)
  | ({ kind: 'codex' } & NativeCodexOption);

type MentionKind = MentionEntry["kind"];

const entryKey = (entry: MentionEntry): string => `${entry.kind}:${entry.id}`;

// The literal injected into the submitted text on behalf of a selected entry.
const entryLiteral = (entry: MentionEntry): string => {
  if (entry.kind === 'agent') return `#${entry.id} `;
  if (entry.kind === 'session') return `#[${entry.title.replace(/[\[\]()\r\n]/g, '')}](harness-mix://session/${entry.id}) `;
  if (entry.kind === 'template') return `#[${entry.name.replace(/[\[\]()\r\n]/g, '')}](harness-mix://team-template/${entry.id}) `;
  return '';
};

const AGENT_DESCRIPTIONS: Record<string, string> = {
  codex: '官方 Codex CLI 原生协同',
  'codex-cli': '官方 Codex CLI 原生协同',
  pi: '轻量快速原生编码 Harness',
  omp: 'Oh My Pi 增强版交互 Harness',
  dsh: 'DeepSeek Harness 原生深度推理与工具调用',
  'deepseek-harness': 'DeepSeek Harness 原生深度推理与工具调用',
  claude: 'Anthropic Claude Code 原生协同',
  'claude-code': 'Anthropic Claude Code 原生协同',
  antigravity: 'Google Antigravity 2.0 原生 Harness',
  opencode: '开源自主编码智能体',
  grok: 'xAI Grok 原生协同与深度推理',
  openclaw: 'OpenClaw 个人 AI 自主智能体',
  hermes: 'Nous Research Hermes 自我迭代智能体',
  qoder: 'Qoder 编程助手',
  codebuddy: 'CodeBuddy 原生智能体',
  zcode: 'ZCode 自动化工程代理',
  trae: 'Trae 原生协同',
  'kiro-cli': 'Kiro CLI 智能编程',
  'cursor-cli': 'Cursor CLI 原生协同',
  cline: 'Cline 自主编程智能体',
};

// Order matters: the first id fragment contained in an Agent id wins.
const AGENT_COLORS: Record<string, string> = {
  codex: '#3b82f6',
  'codex-cli': '#3b82f6',
  'codex-harness': '#3b82f6',
  grok: '#8b5cf6',
  opencode: '#a855f7',
  'claude-code': '#ea580c',
  claude: '#ea580c',
  antigravity: '#0284c7',
  pi: '#d97706',
  omp: '#d97706',
  dsh: '#2563eb',
  'deepseek-harness': '#2563eb',
  'kiro-cli': '#db2777',
  openclaw: '#dc2626',
  hermes: '#059669',
  qoder: '#7c3aed',
  codebuddy: '#0891b2',
  zcode: '#4f46e5',
  trae: '#0284c7',
  'cursor-cli': '#475569',
  cline: '#be185d',
};

function getAgentColor(agentId: string): string {
  const normalized = agentId.toLowerCase();
  for (const [fragment, color] of Object.entries(AGENT_COLORS)) {
    if (normalized.includes(fragment)) return color;
  }
  return '#6366f1';
}

const DEFAULT_CODEX_OPTIONS: NativeCodexOption[] = [
  { id: 'files', title: '文件和文件夹', description: '从本地工作区添加文件或文件夹上下文', category: '添加', icon: '📎', action: 'files' },
  { id: 'snapshot', title: '附加智能快照', description: '截取当前屏幕或窗口附加至上下文', category: '添加', icon: '📸', action: 'snapshot' },
  { id: 'work', title: '在项目中使用 Work', description: '为新聊天选择项目', category: '添加', icon: '📁', action: 'work' },
  { id: 'goal', title: '目标', description: '设置要持续追求的目标', category: '添加', icon: '🎯', action: 'goal' },
  { id: 'plan', title: '计划模式', description: '开启计划模式', category: '添加', icon: '💡', action: 'plan' },
  { id: 'sketch', title: '绘图', description: '绘制草图', category: '添加', icon: '✏️', action: 'sketch' },
  { id: 'canva', title: 'Canva', description: 'Create, review, edit designs', category: '插件', icon: '🎨', action: 'plugin-canva' },
  { id: 'github', title: 'GitHub', description: 'Triage PRs, issues, CI, and publish flows', category: '插件', icon: '🐙', action: 'plugin-github' },
  { id: 'product-design', title: 'Product Design', description: 'Explore and prototype ideas', category: '插件', icon: '📐', action: 'plugin-product-design' },
];

function getCodexNativeOptions(): NativeCodexOption[] {
  const overlay = document.querySelector('[data-composer-overlay-floating-ui="true"]');
  if (!overlay) return DEFAULT_CODEX_OPTIONS;
  const buttons = [...overlay.querySelectorAll<HTMLElement>('button, [role="option"]')];
  if (!buttons.length) return DEFAULT_CODEX_OPTIONS;
  const scanned: NativeCodexOption[] = [];
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    if (!btn) continue;
    const text = (btn.innerText || btn.textContent || '').trim();
    if (!text) continue;
    const parts = text.split('\n').map(s => s.trim()).filter(Boolean);
    const title = parts[0] || `选项 ${i + 1}`;
    const description = parts.slice(1).join(' ') || '';
    scanned.push({
      id: `native-${i}`,
      title,
      description,
      category: i < 6 ? '添加' : '插件',
      icon: title.includes('文件') ? '📎' : title.includes('快照') ? '📸' : title.includes('计划') ? '💡' : title.includes('绘图') ? '✏️' : '🧩',
      action: `native-click-${i}`,
    });
  }
  return scanned.length ? scanned : DEFAULT_CODEX_OPTIONS;
}

/** Installs the # mention picker on top of the stock composer editor. */
export function installHarnessMentions(load: (editor: Element, query: string) => Promise<CollaborationMentionCatalog>) {
  const menu = document.createElement('div');
  menu.dataset.harnessMixMentions = 'true';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '协作 Harness');
  menu.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;max-height:320px;overflow:auto;width:340px;max-width:calc(100vw - 16px);padding:6px;border:1px solid #8884;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 8px 30px #0002;font:13px system-ui';
  menu.hidden = true;
  document.body.append(menu);

  // Flex layout on the text-box container puts selected mention chips inline
  // with the caret on a single line. Codex's own @ overlay is never touched —
  // Harness Mix is keyed off #.
  const style = document.createElement('style');
  style.textContent = `
    [data-harness-mix-has-mentions="true"] {
      display: flex !important;
      flex-wrap: wrap !important;
      align-items: baseline !important;
      gap: 8px !important;
    }
    [data-harness-mix-has-mentions="true"] > [data-harness-mix-selected-mentions] {
      display: inline-flex !important;
      align-items: center !important;
      gap: 8px !important;
      flex-wrap: wrap !important;
      vertical-align: baseline !important;
      line-height: 1.5 !important;
    }
    [data-harness-mix-has-mentions="true"] > textarea,
    [data-harness-mix-has-mentions="true"] > [contenteditable="true"],
    [data-harness-mix-has-mentions="true"] > .ProseMirror {
      display: inline-block !important;
      width: auto !important;
      min-width: 60px !important;
      flex: 1 1 auto !important;
      margin: 0 !important;
      padding: 0 !important;
      vertical-align: baseline !important;
    }
    [data-harness-mix-mention-badge]:hover {
      background: rgba(128, 128, 128, 0.14) !important;
    }
  `;
  document.head.append(style);

  let activeComposer: Element | null = null;
  let generation = 0, disposed = false, selected = 0;
  let editor: HTMLTextAreaElement | HTMLElement | null = null;
  let selStart = 0, selEnd = 0;
  let entries: MentionEntry[] = [];
  let matches: MentionEntry[] = [];
  let activeKind: 'agent' | 'codex' | 'session' | 'template' = 'agent';
  let canDelegate = true;
  const catalogs = new Map<HTMLElement, CollaborationMentionCatalog>();
  const badges = new Map<HTMLElement, HTMLElement>();

  // Mention selections are keyed per conversation, so they survive switching
  // to another conversation and back.
  const sessionSelections = new Map<string, Map<string, MentionEntry>>();

  const conversationKeyFor = (target: HTMLElement): string => {
    const composer = target.closest('[data-codex-composer-root]');
    if (!composer) return (target as unknown as { __harnessMixEditorKey?: string }).__harnessMixEditorKey || 'default';
    const portal = composer.querySelector('[data-above-composer-portal]');
    const portalId = portal?.getAttribute('data-above-composer-conversation-id');
    if (portalId) return `conversation:${portalId}`;
    const convEl = composer.closest('[data-conversation-id]') || composer.querySelector('[data-conversation-id]');
    const convId = convEl?.getAttribute('data-conversation-id');
    if (convId) return `conversation:${convId}`;
    const draftId = composer.getAttribute('data-composer-draft-id');
    if (draftId) return `draft:${draftId}`;
    const all = composer.querySelectorAll('textarea, [contenteditable="true"]');
    if (all.length > 1) {
      const index = Array.from(all).indexOf(target);
      return `editor:${index >= 0 ? index : 'default'}`;
    }
    return 'default';
  };

  const selectionsFor = (target: HTMLElement): Map<string, MentionEntry> => {
    const key = conversationKeyFor(target);
    let selections = sessionSelections.get(key);
    if (!selections) {
      selections = new Map();
      sessionSelections.set(key, selections);
    }
    return selections;
  };

  const isEntrySelectable = (entry: MentionEntry): boolean => {
    if (entry.kind === 'agent') return entry.available && canDelegate;
    if (entry.kind === 'session') return entry.running !== true;
    if (entry.kind === 'template') return entry.members.some(member => member.available);
    return true;
  };

  // Overwrites the #query span [selStart, selEnd) with `text` in whichever
  // editor flavor is active.
  const replaceSelectionWith = (target: HTMLElement, text: string): boolean => {
    if (target instanceof HTMLTextAreaElement) {
      target.setSelectionRange(selStart, selEnd);
      target.setRangeText(text, selStart, selEnd, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // ProseMirror may swap out text nodes while its own popups render, so the
    // saved offsets are re-anchored onto the live tree instead of trusting a
    // stale Range.
    const fresh = document.createRange();
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let walked = 0, foundStart = false, foundEnd = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (!foundStart && selStart <= walked + length) { fresh.setStart(node, selStart - walked); foundStart = true; }
      if (foundStart && selEnd <= walked + length) { fresh.setEnd(node, selEnd - walked); foundEnd = true; break; }
      walked += length;
    }
    if (!foundEnd) return false;
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(fresh);
    document.dispatchEvent(new Event('selectionchange'));
    document.execCommand('insertText', false, text);
    return true;
  };

  const syncBadges = (target: HTMLElement) => {
    for (const [oldTarget, strip] of badges) {
      if (!oldTarget.isConnected) {
        strip.remove();
        badges.delete(oldTarget);
        catalogs.delete(oldTarget);
      }
    }
    const selections = selectionsFor(target);
    const hasAny = selections.size > 0;
    let strip = badges.get(target);

    // Toggle the flex layout so chips and the editor share one line.
    const container = target.parentElement;
    if (hasAny) container?.setAttribute('data-harness-mix-has-mentions', 'true');
    else container?.removeAttribute('data-harness-mix-has-mentions');

    if (!strip && !hasAny) return;
    if (!strip) {
      strip = document.createElement('div');
      strip.dataset.harnessMixSelectedMentions = 'true';
      strip.setAttribute('aria-label', '已提及的协作者');
      strip.style.cssText = 'display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0;margin:0 4px 0 0;vertical-align:baseline;line-height:normal;';
      target.before(strip);
      badges.set(target, strip);
    }

    const wantedKeys = [...selections.values()].map(entryKey).join(',');
    const shownKeys = [...strip.querySelectorAll<HTMLElement>('[data-harness-mix-mention-badge]')].map(b => b.dataset.harnessMixMentionBadge).join(',');
    if (strip.isConnected && shownKeys === wantedKeys && strip.style.display === (hasAny ? 'inline-flex' : 'none')) {
      return;
    }

    strip.replaceChildren();
    strip.style.display = hasAny ? 'inline-flex' : 'none';

    for (const entry of selections.values()) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.dataset.harnessMixMentionBadge = entryKey(entry);

      const removeLabel =
        entry.kind === 'agent'
          ? `移除协作 Agent ${entry.name}`
          : entry.kind === 'session'
            ? `移除历史会话 ${entry.title}`
            : entry.kind === 'template'
              ? `移除团队模板 ${entry.name}`
              : `移除 Codex 选项 ${entry.title}`;
      badge.setAttribute('aria-label', removeLabel);
      badge.title = `${removeLabel}（点击移除）`;

      const agentColor =
        entry.kind === 'agent'
          ? getAgentColor(entry.id)
          : entry.kind === 'template'
            ? '#0d9488'
            : entry.kind === 'codex'
              ? '#0ea5e9'
              : '#8b5cf6';

      badge.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:1px 5px;border:0;border-radius:4px;background:transparent;color:${agentColor};font:500 15px/1.4 system-ui,-apple-system,BlinkMacSystemFont,sans-serif;user-select:none;cursor:pointer;transition:background 0.15s,opacity 0.15s;`;
      badge.addEventListener('mouseenter', () => { badge.style.background = 'rgba(128,128,128,0.12)'; });
      badge.addEventListener('mouseleave', () => { badge.style.background = 'transparent'; });
      badge.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        selectionsFor(target).delete(entryKey(entry));
        syncBadges(target);
        target.focus();
      });

      const iconWrap = document.createElement('span');
      iconWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
      if (entry.kind === 'agent' || entry.kind === 'session') {
        iconWrap.append(
          collaborationIcon(entry.kind === 'agent' ? entry.id : entry.harnessId, entry.kind === 'agent' ? entry.name : entry.title, 16),
          document.createTextNode(entry.kind === 'agent' ? entry.name : entry.title),
        );
      } else if (entry.kind === 'template') {
        const teamIcon = document.createElement('span');
        teamIcon.textContent = '👥';
        teamIcon.style.cssText = 'font-size:13px;line-height:1;';
        iconWrap.append(teamIcon, document.createTextNode(entry.name));
      } else {
        const optionIcon = document.createElement('span');
        optionIcon.textContent = entry.icon || '📌';
        optionIcon.style.cssText = 'font-size:14px;line-height:1;';
        iconWrap.append(optionIcon, document.createTextNode(entry.title));
      }

      badge.append(iconWrap);
      strip.append(badge);
    }
  };

  const close = () => {
    generation++;
    menu.hidden = true;
    activeComposer?.removeAttribute('data-harness-mix-mention-active');
    activeComposer?.removeAttribute('data-harness-mix-show-native');
    activeComposer = null;
  };

  const choose = (entry: MentionEntry) => {
    if (!editor) return;
    if (!isEntrySelectable(entry)) return;
    const target = editor;
    close();
    target.focus();
    replaceSelectionWith(target, '');

    if (entry.kind === 'codex') {
      // A native Codex option: prefer clicking the real overlay button.
      const nativeOverlay = document.querySelector('[data-composer-overlay-floating-ui="true"]');
      if (nativeOverlay) {
        const buttons = [...nativeOverlay.querySelectorAll<HTMLElement>('button, [role="option"]')];
        const match = buttons.find(b => (b.innerText || b.textContent || '').includes(entry.title));
        if (match) {
          match.click();
          return;
        }
      }
      if (entry.action === 'files') {
        const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
        fileInput?.click();
      }
      return;
    }

    // Any other entry toggles its chip in this conversation's selection.
    const selections = selectionsFor(target);
    const key = entryKey(entry);
    if (selections.has(key)) selections.delete(key);
    else selections.set(key, entry);
    syncBadges(target);
  };

  const render = () => {
    menu.replaceChildren();
    const tabs = document.createElement('div');
    tabs.setAttribute('role', 'tablist');
    tabs.style.cssText = 'display:flex;gap:4px;padding:2px 2px 6px;border-bottom:1px solid #8882;margin-bottom:4px';

    const tabDefinitions: Array<{ kind: 'agent' | 'session' | 'template'; label: string }> = [
      { kind: 'agent', label: 'Agents' },
      { kind: 'session', label: '会话' },
      { kind: 'template', label: '团队' },
    ];

    for (const tabInfo of tabDefinitions) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(activeKind === tabInfo.kind));
      const count = matches.filter(entry => entry.kind === tabInfo.kind).length;
      tab.textContent = `${tabInfo.label}  ${count}`;
      tab.style.cssText = `border:0;border-radius:6px;padding:6px 10px;color:inherit;font:inherit;cursor:pointer;background:${activeKind === tabInfo.kind ? '#8882' : 'transparent'};transition:background .15s;`;
      tab.addEventListener('mousedown', event => event.preventDefault());
      tab.addEventListener('click', () => {
        activeKind = tabInfo.kind;
        selected = 0;
        render();
      });
      tabs.append(tab);
    }
    menu.append(tabs);

    entries = matches.filter(entry => entry.kind === activeKind);
    if (!entries.length || (activeKind === 'agent' && !canDelegate)) {
      const notice = document.createElement('div');
      notice.textContent = !canDelegate && activeKind === 'agent'
        ? '当前主 Agent 未接入协作工具。请切换到 Codex（协作）、Claude Code、Pi 或 Oh My Pi 后分派任务。'
        : activeKind === 'agent'
          ? '没有匹配的 Agent'
          : activeKind === 'template'
            ? '没有团队模板，可在 设置 → 协作 中创建'
            : '没有匹配的历史会话';
      notice.style.cssText = 'padding:10px 8px;font-size:12px;line-height:1.6;opacity:.65';
      menu.append(notice);
    }

    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', activeKind === 'agent' ? '协作 Agents' : activeKind === 'template' ? '团队模板' : '历史会话');
    menu.append(list);

    entries.forEach((entry, index) => {
      const selectable = isEntrySelectable(entry);
      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      row.disabled = !selectable;
      row.id = `harness-mention-option-${index}`;
      row.style.cssText = `display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;border-radius:7px;padding:7px 8px;color:inherit;font:inherit;cursor:pointer;background:${index === selected ? '#8882' : 'transparent'};opacity:${selectable ? 1 : .45}`;

      const copy = document.createElement('span');
      copy.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex:1;min-width:0';
      const name = document.createElement('span');
      name.textContent = entry.kind === 'agent' || entry.kind === 'template' ? entry.name : entry.title;
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;';

      if (entry.kind === 'template' && entry.source === 'project') {
        const projectBadge = document.createElement('span');
        projectBadge.textContent = '项目';
        projectBadge.title = '来自本仓库 .harness-mix/teams/ 的团队模板';
        projectBadge.setAttribute('data-harness-mix-template-source', 'project');
        projectBadge.style.cssText = 'flex:none;font-size:10px;line-height:1;padding:2px 5px;border-radius:4px;opacity:.9;border:1px solid currentColor;color:inherit;';
        name.append(projectBadge);
      }

      const detail = document.createElement('span');
      if (entry.kind === 'agent') detail.textContent = AGENT_DESCRIPTIONS[entry.id] || entry.description || `#${entry.id}`;
      else if (entry.kind === 'session') detail.textContent = entry.cwd;
      else if (entry.kind === 'template') detail.textContent = entry.description || entry.members.map(member => member.name).join(' · ');
      else detail.textContent = entry.description || entry.category;
      detail.style.cssText = 'font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      copy.append(name, detail);

      const status = document.createElement('span');
      if (entry.kind === 'agent') status.textContent = entry.available ? '可协作' : '未就绪';
      else if (entry.kind === 'session') status.textContent = entry.running ? '运行中' : '引用';
      else if (entry.kind === 'template') {
        status.textContent = entry.members.every(member => !member.agent)
          ? '待指定 Harness'
          : `拉起团队 · ${entry.members.length} 成员`;
      } else status.textContent = entry.category || '原生';
      status.style.cssText = 'font-size:11px;opacity:.6';

      let iconEl: HTMLElement;
      if (entry.kind === 'agent' || entry.kind === 'session') {
        iconEl = collaborationIcon(entry.kind === 'agent' ? entry.id : entry.harnessId, name.textContent || '', 18);
      } else if (entry.kind === 'template') {
        const teamIcon = document.createElement('span');
        teamIcon.textContent = '👥';
        teamIcon.style.cssText = 'font-size:16px;line-height:1;width:18px;text-align:center;';
        teamIcon.title = entry.members.map(member => `${member.name} · ${member.agent || '待指定 Harness'}${member.agent && !member.available ? '（不可用）' : ''}`).join('\n');
        iconEl = teamIcon;
      } else {
        const optionIcon = document.createElement('span');
        optionIcon.textContent = entry.icon || '📎';
        optionIcon.style.cssText = 'font-size:16px;line-height:1;width:18px;text-align:center;';
        iconEl = optionIcon;
      }

      row.append(iconEl, copy, status);
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
    if (editable instanceof HTMLTextAreaElement) {
      if (editable.selectionStart !== editable.selectionEnd) { close(); return; }
      selEnd = editable.selectionStart;
      prefix = editable.value.slice(0, selEnd);
    } else {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed) { close(); return; }
      const caret = selection.getRangeAt(0);
      if (!editable.contains(caret.startContainer) || caret.startContainer.nodeType !== Node.TEXT_NODE) { close(); return; }
      const before = caret.cloneRange();
      before.selectNodeContents(editable);
      before.setEnd(caret.startContainer, caret.startOffset);
      prefix = before.toString();
      selEnd = prefix.length;
    }

    const match = /(?:^|[\s，。；：])#([\p{L}\p{N}_-]*)$/u.exec(prefix);
    if (!match) { close(); return; }
    selStart = selEnd - (match[1]!.length + 1);
    const current = ++generation;

    try {
      const catalog = await load(editable, match[1]!.toLowerCase());
      if (disposed || current !== generation) return;
      catalogs.set(editable, catalog);
      syncBadges(editable);

      const query = match[1]!.toLowerCase();
      canDelegate = catalog.canDelegate !== false;

      const matchingAgents: MentionEntry[] = catalog.agents
        .filter(a => a.id.toLowerCase().includes(query) || a.name.toLowerCase().includes(query))
        .map(a => ({ kind: 'agent' as const, title: a.name, ...a }));

      const matchingSessions: MentionEntry[] = catalog.sessions
        .filter(s => `${s.title} ${s.cwd}`.toLowerCase().includes(query))
        .map(s => ({ kind: 'session' as const, ...s }));

      const matchingTemplates: MentionEntry[] = (catalog.templates ?? [])
        .filter(t => `${t.name} ${t.description}`.toLowerCase().includes(query))
        .map(t => ({ kind: 'template' as const, ...t }));

      matches = [...matchingAgents, ...matchingSessions, ...matchingTemplates];

      // Prefer the tab that actually has results for this query.
      if (query && !matchingAgents.length && !matchingSessions.length && matchingTemplates.length) {
        activeKind = 'template';
      } else if (query && !matchingAgents.length && matchingSessions.length) {
        activeKind = 'session';
      } else {
        activeKind = 'agent';
      }

      entries = matches.filter(entry => entry.kind === activeKind);
      selected = Math.max(0, entries.findIndex(isEntrySelectable));

      render();
      menu.hidden = !matches.length && catalog.canDelegate === undefined;
      activeComposer?.removeAttribute('data-harness-mix-mention-active');
      activeComposer = !menu.hidden ? editable.closest('[data-codex-composer-root]') : null;
      activeComposer?.setAttribute('data-harness-mix-mention-active', 'true');

      // Flip above the caret when there is room, else drop below.
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
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('[data-codex-composer-root]')) {
      const editable = target.closest('textarea,[contenteditable="true"]') as HTMLElement | null;
      if (editable && event.key === 'Backspace') {
        // Backspace on an empty editor pops the most recent mention chip.
        let isAtStart = false;
        if (editable instanceof HTMLTextAreaElement) {
          isAtStart = editable.selectionStart === 0 && editable.selectionEnd === 0;
        } else {
          const sel = window.getSelection();
          if (sel && sel.isCollapsed && sel.rangeCount > 0) {
            const r = sel.getRangeAt(0);
            isAtStart = r.startOffset === 0 && (r.startContainer === editable || r.startContainer.textContent === '' || editable.firstChild === r.startContainer);
          }
        }
        if (isAtStart) {
          const selections = selectionsFor(editable);
          if (selections.size > 0) {
            const lastKey = [...selections.keys()].pop();
            if (lastKey) selections.delete(lastKey);
            syncBadges(editable);
            event.preventDefault();
            return;
          }
        }
      }
    }

    if (menu.hidden || event.isComposing) return;
    if (event.key === 'Escape') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const kinds: Array<'agent' | 'session'> = ['agent', 'session'];
      const curIdx = kinds.indexOf(activeKind as 'agent' | 'session');
      const nextIdx = (curIdx + (event.key === 'ArrowRight' ? 1 : -1) + kinds.length) % kinds.length;
      const next = kinds[nextIdx];
      if (next) activeKind = next;
      selected = 0;
      render();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const entry = entries[selected];
      if (entry) choose(entry);
    } else {
      for (let i = 0; i < entries.length; i++) {
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
        if (isEntrySelectable(entries[selected]!)) break;
      }
      render();
      menu.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
  };

  const outside = (event: Event) => {
    if (event.target instanceof Node && !menu.contains(event.target)) close();
  };

  const findEditorIn = (root: Element | null): HTMLElement | null => {
    if (!root) return null;
    if (root.matches('textarea,[contenteditable="true"]')) return root as HTMLElement;
    return root.querySelector<HTMLElement>('textarea,[contenteditable="true"]');
  };

  // Prepends every pending mention literal to the editor contents.
  const injectMentionsInto = (target: HTMLElement): boolean => {
    const selections = selectionsFor(target);
    if (selections.size === 0) return false;
    const text = [...selections.values()].map(entryLiteral).join('');
    if (!text) return false;
    target.focus();
    if (target instanceof HTMLTextAreaElement) {
      target.value = `${text}${target.value}`;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const fresh = document.createRange();
      fresh.selectNodeContents(target);
      fresh.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(fresh);
      document.dispatchEvent(new Event('selectionchange'));
      document.execCommand('insertText', false, text);
    }
    selections.clear();
    syncBadges(target);
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

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('[data-codex-composer-root]')) {
      const editable = target.closest('textarea,[contenteditable="true"]') as HTMLElement | null;
      if (editable) syncBadges(editable);
    }
  };

  // Re-derive badge strips when Codex reshuffles composer DOM or conversation
  // ids. Mutations inside our own UI are ignored.
  const observer = new MutationObserver((mutations) => {
    let shouldSync = false;
    for (const m of mutations) {
      if (m.target instanceof Element) {
        if (m.target.closest('[data-harness-mix-selected-mentions]') || m.target.closest('[data-harness-mix-mentions]')) {
          continue;
        }
      }
      shouldSync = true;
      break;
    }
    if (!shouldSync) return;
    for (const composer of document.querySelectorAll('[data-codex-composer-root]')) {
      const el = findEditorIn(composer);
      if (el) syncBadges(el);
    }
  });

  try {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-above-composer-conversation-id', 'data-conversation-id', 'data-composer-draft-id'],
    });
  } catch {}

  document.addEventListener('input', input, true);
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('mousedown', outside);
  document.addEventListener('submit', onSubmitCapture, true);
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('blur', close);

  return {
    sync(target: HTMLElement) {
      syncBadges(target);
    },
    prepareSubmission(composer: Element): boolean {
      const editorEl = findEditorIn(composer);
      return !!editorEl && injectMentionsInto(editorEl);
    },
    dispose() {
      disposed = true;
      close();
      menu.remove();
      style.remove();
      observer.disconnect();
      for (const el of document.querySelectorAll('[data-harness-mix-has-mentions]')) {
        el.removeAttribute('data-harness-mix-has-mentions');
      }
      for (const strip of badges.values()) strip.remove();
      badges.clear();
      catalogs.clear();
      document.removeEventListener('input', input, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('submit', onSubmitCapture, true);
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('blur', close);
    },
  };
}
