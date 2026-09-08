const $ = s => document.querySelector(s);
// 静态 UI 目录（图标/名称/排序）；可用性与能力由 snapshot 中 Adapter manifest 提供
const HARNESS_UI = [
  ['claude', 'Claude Code', 'claude-color.svg'],
  ['codex', 'Codex', 'codex-harness.svg'],
  ['dsh', 'DeepSeek Harness', 'deepseek-color.svg'],
  ['pi', 'Pi', 'pi.svg'],
];
let state = { threads: [], adapters: [] }, selectedId = null, draftHarness = 'pi', busy = false, refreshing = false, refreshAgain = false;
let openTabs = []; // 顶部标签栏：打开过的对话（内存态；关闭标签不删除任务）
let catalogs = {};                    // harnessId -> describe() 结果（模型目录/思考档位/权限模式）
try { const saved = JSON.parse(localStorage.getItem('hm:catalogs:v1') || '{}'); if (Date.now() - saved.at < 86400000) catalogs = saved.catalogs || {}; } catch { /* ignore damaged cache */ }
const commandCache = new Map();
function modelIcon(model = {}) {
  const name = typeof model === 'string' ? model : [model.id, model.name, model.provider].filter(Boolean).join(' ');
  const families = [[/deepseek/i, 'deepseek'], [/mimo|xiaomi/i, 'xiaomimimo'], [/qwen|qwq/i, 'qwen-color'], [/minimax|abab/i, 'minimax'], [/claude|anthropic/i, 'claude'], [/kimi|moonshot/i, 'kimi'], [/glm|zhipu|智谱|z[.-]?ai\b/i, 'zai'], [/gpt|openai|o[134](?:-|\b)/i, 'openai']];
  return 'icons/model-' + (families.find(([test]) => test.test(name))?.[1] || 'astra') + '.svg';
}
const catalogRequests = new Map();
let menuGeneration = 0;
let closeProjectMenu = () => {};
const projectMeta = JSON.parse(localStorage.getItem('hm:projectMeta') ?? '{}');
let draftOptions = {};                // harnessId -> { model, thinking, permissionMode } 草稿期选择
let selectedProject = localStorage.getItem('hm:project') || 'E:\\harness-mix';
let menuItems = [], menuPick = null;  // 单列菜单（权限模式）的条目与回调
let menuModelItems = [], menuThinkItems = []; // 合并菜单（模型 + 思考强度）的条目
const esc = v => { const n = document.createElement('span'); n.textContent = String(v ?? ''); return n.innerHTML; };
const ui = id => HARNESS_UI.find(([key]) => key === id) ?? [id, id, 'pi.svg'];
const icon = id => 'icons/' + ui(id)[2];
const adapter = id => state.adapters.find(a => a.id === id);
const available = id => Boolean(adapter(id)?.available);
const capabilities = id => {
  const caps = current()?.harnessId === id ? current().capabilities : adapter(id)?.coreCapabilities;
  if (caps) return { models: caps.model.selection, thinkingLevels: caps.model.thinkingLevel,
    permissionModes: caps.interaction.permissionMode, fork: caps.session.fork, forkFromMessage: caps.session.forkFromMessage };
  return adapter(id)?.capabilities ?? {}; // old snapshot compatibility
};
const current = () => state.threads.find(t => t.id === selectedId);
const coreTurnFor = t => t?.currentTurn;
const coreStatuses = { created: '正在执行', starting: '正在执行', running: '正在执行', waiting_interaction: '等待你的回答', completed: '准备就绪', cancelled: '已停止', error: '发生错误' };
const statuses = { opening: '正在连接', working: '正在执行', ready: '准备就绪', error: '发生错误' };
const notice = text => { $('#notice').textContent = text; };
const describeError = e => /No handler registered/.test(e.message) ? '主进程功能未加载：请完全退出并重启 Harness Mix。' : e.message;

// Keep the usage disclosure in the composer without coupling it to model choice.
{
  const old = $('#contextMeter'), wrap = document.createElement('span');
  wrap.className = 'model-wrap usage-wrap';
  const button = document.createElement('button');
  button.type = 'button'; button.id = old.id; button.className = old.className;
  button.innerHTML = old.innerHTML;
  button.setAttribute('aria-controls', 'usagePopover');
  button.setAttribute('aria-expanded', 'false');
  old.replaceWith(wrap);
  wrap.append(button);
  const popover = document.createElement('section');
  popover.id = 'usagePopover'; popover.className = 'usage-popover'; popover.hidden = true;
  popover.setAttribute('aria-label', '上下文与用量'); wrap.append(popover);
  button.onclick = async () => {
    const opening = popover.hidden; closeMenus(); popover.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    const thread = current();
    if (!opening || !thread) return;
    const note = document.createElement('p'); note.textContent = '正在核对原生上下文…'; popover.appendChild(note);
    try { await window.harnessMix.refreshUsage(thread.id); if (current()?.id === thread.id) await refresh(); }
    catch (error) { if (current()?.id === thread.id) note.textContent = describeError(error); }
  };
}

const SVG = {
  spinner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8.5 12.2 11 14.7 15.8 9.6"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10z"/><polyline points="9 11.8 11 13.8 14.8 9.8"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

/* ---------- 应用内模态框（替代原生 confirm/prompt，保持视觉统一） ---------- */
function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false, icon }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-icon ${danger ? 'danger' : ''}">${icon ?? SVG.alert}</div><div class="modal-text"><div class="modal-title">${esc(title)}</div>${message ? `<div class="modal-message">${esc(message)}</div>` : ''}</div><div class="modal-actions"><button type="button" data-modal-cancel>${esc(cancelText)}</button><button type="button" class="${danger ? 'danger' : 'primary'}" data-modal-ok>${esc(okText)}</button></div></div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 150);
      resolve(value);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    document.addEventListener('keydown', onKey, true); // 捕获阶段拦截，避免触发全局 Esc 处理
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    overlay.querySelector('[data-modal-cancel]').addEventListener('click', () => done(false));
    overlay.querySelector('[data-modal-ok]').addEventListener('click', () => done(true));
    overlay.querySelector('[data-modal-ok]').focus();
  });
}

/** 图片产物灯箱预览 */
function showLightbox(src, caption) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay lightbox open';
  overlay.innerHTML = `<figure class="lightbox-body"><img src="${esc(src)}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', close);
  document.body.appendChild(overlay);
}

function drawer(open) { $('#drawer').hidden = !open; $('#trigger').setAttribute('aria-expanded', String(open)); $('#trigger').classList.toggle('open', open); }
function closeMenus() { menuGeneration++; for (const id of ['#modelTopMenu', '#modelBarMenu', '#permMenu', '#usagePopover', '#commandMenu']) $(id).hidden = true; $('#contextMeter').setAttribute('aria-expanded', 'false'); $('#commandButton').setAttribute('aria-expanded', 'false'); }

// Commands are discovered only when the user opens this menu.
{
  const wrap = document.createElement('span');
  wrap.className = 'model-wrap command-wrap';
  wrap.innerHTML = '<button type="button" id="commandButton" class="command-button" title="Harness 指令" aria-label="Harness 指令" aria-expanded="false" aria-controls="commandMenu"><img src="icons/commands.svg" alt=""></button><div id="commandMenu" class="menu command-menu" hidden></div>';
  $('.bar-spacer').after(wrap);
  const menu = $('#commandMenu'), button = $('#commandButton');
  button.onclick = async () => {
    const opening = menu.hidden; closeMenus();
    if (!opening) return;
    menu.hidden = false; button.setAttribute('aria-expanded', 'true');
    const generation = menuGeneration, thread = current(), hid = thread?.harnessId ?? draftHarness;
    menu.innerHTML = '<div class="command-hint">正在读取指令…</div>';
    try {
      const key = thread?.id || hid;
      const commands = commandCache.get(key) ?? await window.harnessMix.listCommands({ threadId: thread?.id, harnessId: hid });
      commandCache.set(key, commands);
      if (generation !== menuGeneration) return;
      menu.innerHTML = `<div class="command-hint">${esc(ui(hid)[1])} 指令</div>`;
      if (!commands.length) menu.innerHTML += '<div class="command-hint">当前原生接口尚未提供快捷指令。</div>';
      for (const command of commands) {
        const item = document.createElement('button'); item.type = 'button';
        item.className = 'command-item'; item.dataset.command = command.id;
        item.innerHTML = `<span>${esc(command.label)}</span><small>${esc(command.description || '')}</small>`;
        item.disabled = command.action === 'execute' && (!thread?.messages.length || thread.status === 'working' || thread.reviewPending || busy);
        if (item.disabled) item.title = '请在会话回复完成后执行';
        item.onclick = async () => {
          closeMenus();
          if (command.action === 'insert') { $('#message').value = command.text; $('#message').focus(); return; }
          busy = true; notice('正在执行：' + command.label); render();
          try { await window.harnessMix.executeCommand(thread.id, command.id); notice(command.label + '已完成'); }
          catch (error) { notice(describeError(error)); }
          finally { busy = false; await refresh(); }
        };
        menu.append(item);
      }
    } catch (error) {
      if (generation === menuGeneration) menu.innerHTML = `<div class="command-hint">${esc(describeError(error))}</div>`;
    }
  };
}

/** Harness 原生目录（模型/思考档位/权限模式），渲染进程侧缓存 */
async function catalog(hid) {
  if (catalogs[hid]) return catalogs[hid];
  if (!catalogRequests.has(hid)) catalogRequests.set(hid, window.harnessMix.describe(hid).then(c => {
    catalogs[hid] = c;
    try { localStorage.setItem('hm:catalogs:v1', JSON.stringify({ at: Date.now(), catalogs })); } catch { /* storage may be full */ }
    return c;
  }).finally(() => catalogRequests.delete(hid)));
  return catalogRequests.get(hid);
}

/** 当前上下文的有效选项：任务态取 thread，草稿态取 per-harness 草稿 */
function effOptions() {
  const t = current();
  if (t) return { model: t.model ?? t.options?.model, thinking: t.options?.thinking, permissionMode: t.options?.permissionMode };
  return draftOptions[draftHarness] ?? {};
}

/* ---------- 项目分组与任务项 ---------- */
const projectNavs = () => [...document.querySelectorAll('#projects nav.threads')];
const findProject = path => [...document.querySelectorAll('#projects details')].find(d => d.dataset.path === path);
function ensureProjectGroup(path) {
  if (!path || findProject(path)) return;
  const det = document.createElement('details');
  det.dataset.path = path;
  det.innerHTML = '<summary></summary><nav class="threads" aria-label="真实任务"></nav>';
  det.querySelector('nav').dataset.path = path;
  $('#projects').appendChild(det);
  decorateProjectSummary(det);
}

/** 静态示例项目组（index.html）补删除按钮；裸文本节点包进 .project-name 便于布局与取名 */
function decorateProjectSummary(det) {
  const sum = det.querySelector(':scope > summary');
  const path = det.dataset.path, meta = projectMeta[path] ?? {};
  sum.innerHTML = `<span class="folder-closed">${SVG.folder}</span><span class="folder-open"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 18V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 20h15l4-10H7L3 20Z"/></svg></span><span class="project-name">${esc(meta.name || path.split(/[\\/]/).filter(Boolean).pop() || path)}</span>${meta.pinned ? '<span class="project-pin" title="已置顶">⌖</span>' : ''}<button type="button" class="project-action" data-project-menu aria-label="项目操作" title="项目操作">···</button><button type="button" class="project-action" data-project-new aria-label="新建对话" title="在此项目新建对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 5 5-11 11-6 1 1-6L16 3Z"/><path d="m14 5 5 5"/></svg></button>`;
  sum.title = path;
}
const threadButtonHtml = t => `<button class="task ${t.id === selectedId ? 'active' : ''}" data-thread="${esc(t.id)}" draggable="true" title="${esc(t.title)}"><img src="${icon(t.harnessId)}" alt="">${esc(t.title)}<span class="task-x" data-del="${esc(t.id)}" title="删除任务">×</span></button>`;

function renderThreads() {
  for (const t of state.threads) if (t.cwd) ensureProjectGroup(t.cwd);
  for (const nav of projectNavs()) {
    const list = state.threads.filter(t => t.cwd === nav.dataset.path);
    nav.innerHTML = list.map(threadButtonHtml).join('') || '<p class="hint">还没有任务</p>';
  }
  const groups = [...$('#projects').querySelectorAll('details[data-path]')];
  groups.sort((a, b) => Number(Boolean(projectMeta[b.dataset.path]?.pinned)) - Number(Boolean(projectMeta[a.dataset.path]?.pinned)));
  for (const group of groups) $('#projects').appendChild(group);
}

/** 各 Harness 返回的图片 / 文件产物统一渲染（对齐层） */
function renderArtifacts(m) {
  if (!m.artifacts?.length) return '';
  return '<div class="artifacts">' + m.artifacts.map(a => {
    if (a.type === 'image' && a.data) {
      return `<figure class="artifact artifact-image" data-zoom="${esc(a.id)}" title="点击放大"><img src="data:${esc(a.mime || 'image/png')};base64,${esc(a.data)}" alt="${esc(a.name || '图片')}" loading="lazy"><figcaption>${esc(a.name || '图片')}</figcaption></figure>`;
    }
    return `<div class="artifact artifact-file">${SVG.file}<span class="artifact-meta"><b>${esc(a.name || a.uri || '文件')}</b>${a.uri && a.uri !== a.name ? `<small>${esc(a.uri)}</small>` : ''}</span></div>`;
  }).join('') + '</div>';
}

function renderMessages(t, harnessId) {
  return t.messages.map(m => {
    if (m.role === 'user') return `<article class="message user" aria-label="你的消息">${esc(m.text)}</article>`;
    const canFork = capabilities(harnessId).forkFromMessage && m.coreTurn && !['created', 'starting', 'running', 'waiting_interaction'].includes(m.coreTurn.status);
    const settled = m.coreTurn && !['created', 'starting', 'running', 'waiting_interaction'].includes(m.coreTurn.status);
    const completedAt = m.coreTurn?.completedAt ?? m.endedAt;
    const time = Number.isFinite(completedAt) ? new Date(completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const actions = settled ? `<div class="message-actions"><button type="button" data-copy-message="${esc(m.id)}" title="复制回复" aria-label="复制回复"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button>${canFork ? `<button type="button" data-fork-message="${esc(m.id)}" title="分支到新聊天" aria-label="分支到新聊天" ${busy || t.reviewPending || t.status === 'working' ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v5a7 7 0 0 0 7 7h7M14 12l5 5-5 5M5 10l7-7M7 3h5v5"/></svg></button>` : ''}${time ? `<time datetime="${new Date(completedAt).toISOString()}" title="${esc(new Date(completedAt).toLocaleString('zh-CN'))}">${esc(time)}</time>` : ''}</div>` : '';
    return `<article class="message assistant">${window.Transcript.message(m, t)}${renderArtifacts(m)}${actions}</article>`;
  }).join('');
}

function renderTools(t) {
  return '';
}

function renderApprovals(t) {
  const requests = t.interactions ?? [];
  if (!requests?.length) return '';
  return requests.map(a => {
    let actions = '';
    if (a.method === 'confirm') {
      actions = `<button class="primary" data-approval-confirm="true">允许</button><button class="danger" data-approval-confirm="false">拒绝</button>`;
    } else if (a.method === 'input' || a.method === 'editor') {
      actions = `<div class="approval-input"><input placeholder="${esc(a.placeholder ?? '请输入…')}" aria-label="回复 Harness"><button data-approval-submit>提交</button></div>`;
    } else {
      actions = (a.options ?? []).map((o, i) =>
        `<button class="${i === 0 ? 'primary' : ''} ${/reject|deny|拒|block/i.test(o.kind ?? o.label) ? 'danger' : ''}" data-approval-option="${esc(o.id)}">${esc(o.label)}</button>`
      ).join('');
    }
    return `<div class="approval" data-request="${esc(a.requestId)}"><div class="approval-title">${SVG.shield}${esc(a.title)}</div>${a.message ? `<p class="approval-message">${esc(a.message)}</p>` : ''}<div class="approval-actions">${actions}</div></div>`;
  }).join('');
}

/* ---------- 顶部标签栏 ---------- */
function openTab(id) { if (id && !openTabs.includes(id)) openTabs.push(id); }

function renderTabs() {
  const el = $('#tabs');
  if (!el) return;
  const tabs = openTabs.map(id => state.threads.find(t => t.id === id)).filter(Boolean);
  openTabs = tabs.map(t => t.id); // 清理已删除任务
  el.innerHTML = tabs.map(t =>
    `<div class="tab ${t.id === selectedId ? 'active' : ''}" data-tab="${esc(t.id)}" role="tab" aria-selected="${t.id === selectedId}" title="${esc(t.title)}"><img class="tab-kind" src="icons/${t.forkedFrom ? 'thread-fork.svg' : 'home-chat.svg'}" alt=""><span class="tab-title">${esc(t.title)}</span><button class="tab-x" data-tab-close="${esc(t.id)}" title="关闭标签" aria-label="关闭标签">×</button></div>`
  ).join('');
  requestAnimationFrame(() => el.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}

function render() {
  const t = current(), id = t?.harnessId || draftHarness;
  const caps = capabilities(id), cat = catalogs[id], opts = effOptions();
  renderThreads();
  renderTabs();
  $('#drawer').innerHTML = HARNESS_UI.map(([key, name, file]) => `<button type="button" class="option" role="radio" aria-label="${name}${available(key) ? '' : '（尚不可用）'}" title="${name}${available(key) ? '' : ' · 尚未接入或不可用'}" aria-checked="${key === id}" data-harness="${key}" ${!available(key) || busy ? 'disabled' : ''}><img src="icons/${file}" alt=""></button>`).join('');
  $('#currentIcon').src = icon(id); $('#trigger').title = ui(id)[1]; $('#trigger').setAttribute('aria-label', '选择 Harness，当前 ' + ui(id)[1]);
  $('#taskStatus').textContent = t ? (t.connectionStatus === 'error' || t.connectionStatus === 'opening' ? statuses[t.connectionStatus] : coreStatuses[coreTurnFor(t)?.status] ?? statuses[t.status] ?? t.status) : '准备就绪';
  $('#bridgeStatus').textContent = state.adapters.filter(a => a.available).length + ' 个可用';
  // 模型胶囊（Codex 风格：模型名 + 思考强度后缀），权限胶囊
  const modelLabel = (opts.model?.name ?? '原生默认模型') + (opts.thinking ? ' ' + opts.thinking : '');
  document.querySelectorAll('.model-name').forEach(n => { n.textContent = modelLabel; });
  document.querySelectorAll('#modelTop > img, #modelBar > img').forEach(img => { img.src = modelIcon(opts.model); });
  const permBtn = $('#permBar');
  permBtn.hidden = !caps.permissionModes;
  permBtn.querySelector('.perm-name').textContent = cat?.permissionModes?.find(m => m.id === opts.permissionMode)?.label ?? (opts.permissionMode || '权限');
  // 上下文占用环形表（事件投影：DSH 实时 / Pi 回合结算后权威值）
  const meter = $('#contextMeter'), usage = window.UsageView.data(t?.coreUsage);
  meter.hidden = !t;
  const c = 2 * Math.PI * 9;
  const filled = Math.max(0, Math.min(100, usage.pct || 0)) / 100 * c;
  $('#contextRing').style.strokeDasharray = `${filled} ${c - filled}`;
  $('#contextText').textContent = usage.label;
  meter.title = '上下文与用量';
  $('#usagePopover').innerHTML = '<h3>上下文与用量</h3><dl>' + usage.rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('') + '</dl><p>占用 = 当前上下文 Token ÷ 模型窗口，按原生 Harness 最近提供的数值显示。会话累计 Token 不代表上下文占用。— 表示尚未提供或压缩后待更新。</p>';
  document.querySelectorAll('#projects details').forEach(d => d.classList.toggle('active-project', d.dataset.path === selectedProject));
  const area = $('#conversation'), bottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
  const expanded = new Set([...area.querySelectorAll('details[data-activity-id][open]')].map(d => d.dataset.activityId));
  const processScroll = new Map([...area.querySelectorAll('.turn-process')].map(d => [d.dataset.activityId, d.querySelector('.turn-process-content')?.scrollTop ?? 0]));
  area.innerHTML = t
    ? renderMessages(t, id) + renderTools(t) + renderApprovals(t) + (t.error ? `<div class="error">${esc(t.error)}</div>` : '')
    : `<section class="home-hero"><div class="home-copy"><span>欢迎使用 Harness Mix</span><h1>一个工作台，<em>多种原生能力</em></h1><p>选择项目、Harness 与模型，开始新的任务。</p></div><div class="home-aside">MORE AGENTS<br>A BRIGHTER<br>TOMORROW<i></i></div><div class="home-cards">${[
      ['home-folder.svg', 'project', '项目与任务', '围绕工作目录组织会话，随时回溯和继续。'],
      ['home-chat.svg', 'chat', '流式对话', '查看回复、工具执行与审批请求。'],
      ['activity-terminal.svg', 'terminal', '原生命令', '在对话中直接运行命令，连接你的开发环境。'],
      ['activity-edit.svg', 'files', '文件变更', '创建、编辑和审查文件，让想法快速落地。'],
    ].map(([asset, tone, title, copy]) => `<button class="home-card ${tone}" type="button" data-home-action="new"><span class="home-card-icon"><img src="icons/${asset}" alt=""></span><b>${title}</b><p>${copy}</p><span class="home-card-arrow">→</span></button>`).join('')}</div><div class="home-tagline"><i></i><span>更强的 AI 协作，从这里开始</span><i></i></div></section>`;
  area.querySelectorAll('details[data-activity-id]').forEach(d => { d.open = expanded.has(d.dataset.activityId); });
  area.querySelectorAll('.turn-process').forEach(d => { d.querySelector('.turn-process-content').scrollTop = processScroll.get(d.dataset.activityId) ?? 0; });
  if (bottom) area.scrollTop = area.scrollHeight;
  const turn = coreTurnFor(t);
  const running = Boolean(turn && ['created', 'starting', 'running', 'waiting_interaction'].includes(turn.status));
  $('#send').hidden = running; $('#stop').hidden = !running;
  $('#stop').disabled = Boolean(t?.reviewPending);
  $('#send').disabled = busy || Boolean(t?.reviewPending) || t?.status === 'opening' || (!t && !available(draftHarness));
  $('#runStatus').textContent = t?.reviewPending ? '正在整理文件变更…' : busy ? '处理中…' : '';
  $('#cwd').disabled = Boolean(t) || busy; $('#folder').disabled = Boolean(t) || busy; if (t) $('#cwd').value = t.cwd;
  $('#topHarness').innerHTML = HARNESS_UI.map(([key, name, file]) => `<button class="top-icon ${id === key ? 'active' : ''}" data-top="${key}" aria-label="${name}" title="${name}${available(key) ? '' : ' · 尚未接入'}" ${!available(key) || busy ? 'disabled' : ''}><img src="icons/${file}" alt=""><span>${name.replace(' Code', '')}</span></button>`).join('');
  window.Workbench?.setContext({ threadId: t?.id, cwd: t?.cwd ?? selectedProject, messages: t?.messages ?? [], status: t?.status });
}

async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try { state = await window.harnessMix.snapshot(); render(); }
  catch (e) { notice(e.message); }
  finally { refreshing = false; if (refreshAgain) { refreshAgain = false; void refresh(); } }
}

/* ---------- 通用单列菜单（权限模式） ---------- */
function openMenu(menu, items, activeId, onPick) {
  const wasOpen = !menu.hidden;
  closeMenus();
  if (wasOpen) return;
  menuItems = items; menuPick = onPick;
  menu.innerHTML = items.length
    ? items.map((it, i) => `<button data-idx="${i}" class="${it.id === activeId ? 'active' : ''}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('')
    : '<div class="menu-empty">无可用项</div>';
  menu.hidden = false;
}
$('#permMenu').addEventListener('click', async e => {
  const b = e.target.closest('[data-idx]'); if (!b) return;
  const item = menuItems[Number(b.dataset.idx)], pick = menuPick;
  closeMenus();
  if (item && pick) await pick(item);
});
$('#permBar').onclick = async () => {
  const menu = $('#permMenu');
  if (!menu.hidden) { closeMenus(); return; }
  const t = current(), hid = t?.harnessId || draftHarness;
  closeMenus();
  const generation = menuGeneration;
  menu.innerHTML = '<div class="menu-empty">正在读取权限选项…</div>'; menu.hidden = false;
  try {
    const cat = await catalog(hid);
    if (generation !== menuGeneration || current()?.id !== t?.id || (!t && draftHarness !== hid)) return;
    menu.hidden = true;
    const modes = cat.permissionModes ?? [];
    if (!modes.length) { notice(`${ui(hid)[1]} 无权限模式可配置；审批请求将逐次呈现。`); return; }
    const activeId = t ? t.options?.permissionMode : draftOptions[hid]?.permissionMode;
    openMenu(menu, modes.map(m => ({ id: m.id, label: m.label, sub: m.hint })), activeId ?? 'default', async item => {
      if (t) {
        try {
          await window.harnessMix.setOptions(t.id, { permissionMode: item.id });
          notice(`权限模式：${item.label}${hid === 'pi' ? '（将在下次拉起原生进程时生效）' : ''}`);
        } catch (err) { notice(err.message); }
        await refresh();
      } else {
        (draftOptions[hid] ??= {}).permissionMode = item.id;
        notice(`已选择权限模式：${item.label}（创建任务时生效）`); render();
      }
    });
  } catch (error) { if (generation === menuGeneration) menu.innerHTML = `<div class="menu-empty">${esc(describeError(error))} · 关闭后点击重试</div>`; }
};

/* ---------- 模型 + 思考强度合并菜单（Codex 风格双列） ---------- */
async function openModelMenu(which) {
  const menu = which === 'top' ? $('#modelTopMenu') : $('#modelBarMenu');
  if (!menu.hidden) { closeMenus(); return; }
  closeMenus();
  const generation = menuGeneration;
  const t = current(), hid = t?.harnessId || draftHarness, caps = capabilities(hid);
  if (!caps.models && !caps.thinkingLevels) { notice(`${ui(hid)[1]} 暂不支持在桌面层选择模型或思考强度。`); return; }
  menu.innerHTML = '<div class="menu-empty">正在读取模型与思考选项…</div>'; menu.hidden = false;
  try {
    let models = null, levels = [];
    if (caps.models) {
      if (t) models = t.models ?? (await catalog(hid)).models;
      else models = (await catalog(hid)).models;
    }
    const catalogValue = await catalog(hid);
    if (caps.thinkingLevels) levels = catalogValue.thinkingLevels ?? [];
    if (generation !== menuGeneration || current()?.id !== t?.id || (!t && draftHarness !== hid)) return;
    const activeModel = t ? (t.model?.id ?? t.model) : draftOptions[hid]?.model?.id;
    const selectedModel = (models ?? []).find(model => model.id === activeModel);
    if (selectedModel?.efforts?.length) levels = selectedModel.efforts;
    menuModelItems = (models ?? []).map(m => ({ id: m.id, label: m.name, sub: [m.id, m.provider].filter(Boolean).join(' · '), raw: m }));
    menuThinkItems = levels.map(l => ({ id: l.id, label: l.label ?? l.id, sub: l.hint }));
    const activeThink = t ? t.options?.thinking : draftOptions[hid]?.thinking;
    const col = (head, items, kind, active) => `<div class="menu-col"><div class="menu-head">${head}</div>${items.length ? items.map((it, i) => `<button data-kind="${kind}" data-idx="${i}" class="${it.id === active ? 'active' : ''}">${kind === 'model' ? `<img class="model-brand" src="${modelIcon(it.raw)}" alt="">` : ''}${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('') : '<div class="menu-empty">该 Harness 不支持</div>'}</div>`;
    menu.innerHTML = `<div class="menu-cols">${col('模型', menuModelItems, 'model', activeModel)}${col('思考强度', menuThinkItems, 'think', activeThink)}</div>`;
    menu.hidden = false;
  } catch (error) { if (generation === menuGeneration) menu.innerHTML = `<div class="menu-empty">${esc(describeError(error))} · 关闭后点击重试</div>`; }
}
$('#modelTop').onclick = () => void openModelMenu('top');
$('#modelBar').onclick = () => void openModelMenu('bar');
for (const menuId of ['#modelTopMenu', '#modelBarMenu']) {
  $(menuId).addEventListener('click', async e => {
    const b = e.target.closest('[data-kind]'); if (!b) return;
    const t = current(), hid = t?.harnessId || draftHarness;
    closeMenus();
    if (b.dataset.kind === 'model') {
      const item = menuModelItems[Number(b.dataset.idx)]; if (!item) return;
      if (t) {
        try { await window.harnessMix.setModel(t.id, item.raw); notice(`已切换模型：${item.label}`); } catch (err) { notice(err.message); }
        await refresh();
      } else { (draftOptions[hid] ??= {}).model = item.raw; notice(`已选择模型：${item.label}（创建任务时生效）`); render(); }
    } else {
      const item = menuThinkItems[Number(b.dataset.idx)]; if (!item) return;
      if (t) {
        try { await window.harnessMix.setThinking(t.id, item.id); notice(`思考强度：${item.label}`); } catch (err) { notice(err.message); }
        await refresh();
      } else { (draftOptions[hid] ??= {}).thinking = item.id; notice(`已选择思考强度：${item.label}（创建任务时生效）`); render(); }
    }
  });
}

/* ---------- 项目删除的持久化（示例项目组删除后重启不再出现） ---------- */
const removedProjects = new Set(JSON.parse(localStorage.getItem('hm:removedProjects') ?? '[]'));

/* ---------- 项目：选择 / 添加 / 任务删除与移动 ---------- */
$('#folder').onclick = async () => {
  try {
    const path = await window.harnessMix.pickFolder();
    if (!path) return;
    if (!current()) $('#cwd').value = path;
    ensureProjectGroup(path);
    selectedProject = path;
    localStorage.setItem('hm:project', path);
    const customs = JSON.parse(localStorage.getItem('hm:projects') ?? '[]');
    if (!customs.some(p => p.path === path)) { customs.push({ path }); localStorage.setItem('hm:projects', JSON.stringify(customs)); }
    notice(`已选择项目目录：${path}`);
    render();
  } catch (e) { notice(e.message); }
};
for (const det of [...document.querySelectorAll('#projects details[data-path]')]) {
  if (removedProjects.has(det.dataset.path)) det.remove(); // 已删除的示例项目组不再出现
  else decorateProjectSummary(det);
}
for (const p of JSON.parse(localStorage.getItem('hm:projects') ?? '[]')) ensureProjectGroup(p.path);

async function deleteThread(id) {
  if (busy) return;
  const t = state.threads.find(x => x.id === id);
  if (!t) return;
  if (t.status === 'working') { notice('任务执行中，请先停止再删除。'); return; }
  const ok = await confirmDialog({ danger: true, icon: SVG.trash, title: `删除任务「${t.title}」？`, message: '仅从列表中移除该任务；原生会话文件仍保留在 Harness 侧。', okText: '删除' });
  if (!ok) return;
  try {
    await window.harnessMix.removeThread(id);
    if (selectedId === id) selectedId = null;
    notice('已删除任务。');
    await refresh();
  } catch (err) { notice(err.message); }
}

/** 删除项目：组内任务一并从列表删除（原生会话文件保留），项目组从侧栏移除并持久化 */
async function deleteProject(path, det) {
  if (busy) return;
  const name = det.querySelector('.project-name')?.textContent.trim() || path;
  const list = state.threads.filter(t => t.cwd === path);
  if (list.some(t => t.status === 'working' || t.status === 'opening')) { notice('项目内有任务正在执行，请先停止再删除。'); return; }
  const ok = await confirmDialog({
    danger: true, icon: SVG.trash, title: `删除项目「${name}」？`, okText: '删除项目',
    message: list.length ? `项目内 ${list.length} 个任务将一并从列表删除；磁盘目录与原生会话文件均不受影响。` : '仅从侧栏移除该项目；磁盘目录不受影响。',
  });
  if (!ok) return;
  busy = true; render();
  try {
    for (const t of list) await window.harnessMix.removeThread(t.id);
    const customs = JSON.parse(localStorage.getItem('hm:projects') ?? '[]');
    if (customs.some(p => p.path === path)) {
      localStorage.setItem('hm:projects', JSON.stringify(customs.filter(p => p.path !== path)));
    } else {
      removedProjects.add(path);
      localStorage.setItem('hm:removedProjects', JSON.stringify([...removedProjects]));
    }
    if (list.some(t => t.id === selectedId)) selectedId = null;
    if (selectedProject === path) {
      const rest = [...document.querySelectorAll('#projects details[data-path]')].filter(d => d !== det);
      selectedProject = rest[0]?.dataset.path ?? '';
      localStorage.setItem('hm:project', selectedProject);
      if (!current() && selectedProject) $('#cwd').value = selectedProject;
    }
    det.remove();
    notice(`已删除项目「${name}」。`);
  } catch (err) { notice(err.message); }
  finally { busy = false; await refresh(); }
}

function projectNewChat(path) {
  if (busy) return;
  selectedProject = path; localStorage.setItem('hm:project', path);
  selectedId = null; $('#cwd').value = path; $('#message').value = '';
  closeMenus(); drawer(false); notice(''); render(); $('#message').focus();
}
function saveProjectMeta(det) {
  localStorage.setItem('hm:projectMeta', JSON.stringify(projectMeta));
  decorateProjectSummary(det); render();
}
function editProject(det) {
  const path = det.dataset.path;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay open';
  overlay.innerHTML = `<form class="modal project-editor" role="dialog" aria-modal="true" aria-label="编辑项目"><h3>编辑项目</h3><label>项目名称<input name="name" maxlength="80" required value="${esc(det.querySelector('.project-name').textContent)}"></label><label>项目目录<input readonly value="${esc(path)}"></label><div class="modal-actions"><button type="button">取消</button><button class="primary" type="submit">保存</button></div></form>`;
  const dismiss = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('button[type=button]').onclick = dismiss;
  overlay.querySelector('form').onsubmit = event => {
    event.preventDefault(); const name = overlay.querySelector('[name=name]').value.trim();
    if (!name) return;
    (projectMeta[path] ??= {}).name = name; saveProjectMeta(det); dismiss();
  };
  document.body.appendChild(overlay); overlay.querySelector('[name=name]').select();
}
function showProjectMenu(det, anchor) {
  closeProjectMenu();
  const path = det.dataset.path, menu = document.createElement('div');
  menu.className = 'project-menu'; menu.setAttribute('role', 'menu');
  menu.innerHTML = `<button role="menuitem" data-action="new">新建对话</button><button role="menuitem" data-action="pin">${projectMeta[path]?.pinned ? '取消置顶' : '置顶'}</button><button role="menuitem" data-action="edit">编辑项目</button><hr><button role="menuitem" data-action="open">在资源管理器中打开</button><hr><button role="menuitem" data-del-project="${esc(path)}" data-action="remove" class="danger">移除项目</button>`;
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.min(box.left, innerWidth - 220) + 'px';
  document.body.appendChild(menu);
  menu.style.top = Math.min(box.bottom + 5, innerHeight - menu.offsetHeight - 10) + 'px';
  const dismiss = () => { menu.remove(); document.removeEventListener('click', outside); document.removeEventListener('keydown', key); };
  closeProjectMenu = dismiss;
  const outside = event => { if (!menu.contains(event.target) && !anchor.contains(event.target)) dismiss(); };
  const key = event => {
    if (event.key === 'Escape') { dismiss(); anchor.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const buttons = [...menu.querySelectorAll('button')], n = buttons.indexOf(document.activeElement);
      buttons[(n + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
    }
  };
  document.addEventListener('click', outside); document.addEventListener('keydown', key);
  menu.onclick = async event => {
    const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return;
    dismiss();
    if (action === 'new') projectNewChat(path);
    if (action === 'pin') { const meta = projectMeta[path] ??= {}; meta.pinned = !meta.pinned; saveProjectMeta(det); }
    if (action === 'edit') editProject(det);
    if (action === 'remove') await deleteProject(path, det);
    if (action === 'open') { try { await window.harnessMix.openFolder(path); } catch (error) { notice(error.message); } }
  };
  menu.querySelector('button').focus();
}
$('#projects').addEventListener('click', e => {
  const action = e.target.closest('[data-project-new],[data-project-menu]');
  if (action) {
    e.preventDefault(); e.stopPropagation(); const det = action.closest('details');
    if (action.hasAttribute('data-project-new')) projectNewChat(det.dataset.path);
    else showProjectMenu(det, action);
    return;
  }
  const delProjectBtn = e.target.closest('[data-del-project]');
  if (delProjectBtn) {
    e.preventDefault(); e.stopPropagation(); // 阻止 summary 折叠
    const det = delProjectBtn.closest('details[data-path]');
    if (det) void deleteProject(det.dataset.path, det);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); void deleteThread(del.dataset.del); return; }
  const tb = e.target.closest('[data-thread]');
  if (tb) { if (!busy) { selectedId = tb.dataset.thread; openTab(selectedId); notice(''); drawer(false); closeMenus(); render(); } return; }
  const summary = e.target.closest('summary');
  if (!summary) return;
  const det = summary.parentElement;
  if (!det?.dataset.path) return;
  selectedProject = det.dataset.path;
  localStorage.setItem('hm:project', selectedProject);
  if (!current() && !busy) $('#cwd').value = selectedProject;
  notice(`已选择项目：${summary.textContent.trim()}（${selectedProject}）`);
  render();
});
$('#projects').addEventListener('dragstart', e => {
  const b = e.target.closest('[data-thread]'); if (!b) return;
  e.dataTransfer.setData('text/plain', b.dataset.thread);
  e.dataTransfer.effectAllowed = 'move';
});
$('#projects').addEventListener('dragover', e => {
  const det = e.target.closest('#projects details[data-path]');
  if (!det) return;
  e.preventDefault();
  det.classList.add('drag-over');
});
$('#projects').addEventListener('dragleave', e => { e.target.closest('details')?.classList.remove('drag-over'); });
$('#projects').addEventListener('drop', async e => {
  const det = e.target.closest('#projects details[data-path]'); if (!det) return;
  e.preventDefault(); det.classList.remove('drag-over');
  const id = e.dataTransfer.getData('text/plain'); if (!id) return;
  const t = state.threads.find(x => x.id === id); if (!t || t.cwd === det.dataset.path) return;
  if (!await confirmDialog({ icon: SVG.folder, title: '移动任务到其他项目？', message: `任务「${t.title}」将移动到 ${det.dataset.path}。注意：Pi/DSH 的原生会话按项目目录存档，移动后历史可能不跟随。`, okText: '移动' })) return;
  try { await window.harnessMix.moveThread(id, det.dataset.path); notice('已移动任务。'); await refresh(); }
  catch (err) { notice(err.message); }
});

/* ---------- Harness 抽屉 ---------- */
$('#trigger').onclick = () => drawer($('#drawer').hidden);
$('#drawer').onclick = e => {
  const b = e.target.closest('[data-harness]'); if (!b || b.disabled) return;
  const next = b.dataset.harness;
  if (current() && current().harnessId !== next) { selectedId = null; notice('已切换到新对话，原任务保持不变。'); }
  draftHarness = next; closeMenus(); render(); drawer(false); $('#trigger').focus();
};
$('#drawer').onkeydown = e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const buttons = [...$('#drawer').querySelectorAll('button:not(:disabled)')], i = buttons.indexOf(document.activeElement);
  buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
};
document.addEventListener('click', e => {
  if (!e.target.closest('.picker')) drawer(false);
  if (!e.target.closest('.model-wrap')) closeMenus();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { drawer(false); closeMenus(); $('#trigger').focus(); } });

/* ---------- 任务与会话 ---------- */
$('#new').onclick = () => { if (busy) return; selectedId = null; $('#message').value = ''; notice(''); render(); $('#message').focus(); };
$('#composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('#message').value.trim();
  if (!text || busy || current()?.reviewPending || current()?.status === 'working') return;
  busy = true; notice(''); render();
  try {
    if (!current()) {
      const t = await window.harnessMix.createThread({ harnessId: draftHarness, cwd: $('#cwd').value.trim(), title: text.slice(0, 36), options: draftOptions[draftHarness] });
      selectedId = t.id;
      openTab(t.id);
      if (t.status === 'error') throw new Error(t.error);
    }
    $('#message').value = '';
    await window.harnessMix.send(selectedId, text);
  } catch (error) { notice(error.message); }
  finally { busy = false; await refresh(); }
};
$('#message').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } };
$('#stop').onclick = async () => { try { await window.harnessMix.cancel(selectedId); } catch (e) { notice(e.message); } await refresh(); };

/* ---------- 审批 / 提问应答 ---------- */
$('#conversation').onclick = async e => {
  const homeAction = e.target.closest('[data-home-action]');
  if (homeAction) { $('#message').focus(); return; }
  const copy = e.target.closest('[data-copy-message]');
  if (copy) {
    const message = current()?.messages.find(item => item.id === copy.dataset.copyMessage);
    const value = message?.coreItems?.filter(item => item.type === 'agent_message' && item.phase === 'final').map(item => item.content).join('\n') || message?.text || '';
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const field = Object.assign(document.createElement('textarea'), { value });
        field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select();
        document.execCommand('copy'); field.remove();
      }
      notice('回复已复制');
    } catch (error) { notice(`复制失败：${error.message}`); }
    return;
  }
  const fork = e.target.closest('[data-fork-message]');
  if (fork && !fork.disabled) { await branchToChat(fork.dataset.forkMessage); return; }
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) { const img = zoom.querySelector('img'); if (img) showLightbox(img.src, img.alt); return; }
  const card = e.target.closest('.approval'); if (!card) return;
  const t = current(); if (!t) return;
  const requestId = card.dataset.request;
  let response = null;
  const option = e.target.closest('[data-approval-option]');
  const confirmBtn = e.target.closest('[data-approval-confirm]');
  const submit = e.target.closest('[data-approval-submit]');
  if (option) response = { optionId: option.dataset.approvalOption };
  else if (confirmBtn) response = { confirmed: confirmBtn.dataset.approvalConfirm === 'true' };
  else if (submit) {
    const input = card.querySelector('.approval-input input');
    if (!input.value.trim()) { input.focus(); return; }
    response = { value: input.value.trim() };
  } else return;
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { await window.harnessMix.respondApproval(t.id, requestId, response); }
  catch (error) { notice(error.message); }
  await refresh();
};

/* ---------- Fork ---------- */
async function branchToChat(messageId) {
  const t = current();
  if (!t) { notice('先选择或创建一个任务，再 Fork。'); return; }
  if (busy) return;
  if (!capabilities(t.harnessId).fork) { notice(`${ui(t.harnessId)[1]} 的原生接口暂不支持 Fork。`); return; }
  busy = true; render();
  try {
    const forked = await window.harnessMix.fork(t.id, messageId);
    selectedId = forked.id; openTab(forked.id);
    notice(`已分支到新聊天「${forked.title}」。`);
  } catch (error) { notice(error.message); }
  finally { busy = false; await refresh(); }
}
$('#forkBtn').onclick = () => branchToChat();

/* ---------- 其余导航 ---------- */
window.harnessMix.onEvent(event => {
  if (event?.type === 'terminal') { window.Workbench?.onTerminal(event.session); return; }
  if (event?.type === 'turn/diff/updated') { window.Workbench?.onReview(event); return; }
  if (event?.type === 'toast') {
    if (event.level === 'status' && event.threadId && event.threadId !== selectedId) return;
    notice(event.text);
    return;
  }
  void refresh();
});
void refresh();
$('#topHarness').onclick = e => { const b = e.target.closest('[data-top]'); if (!b || b.disabled) return; $('#drawer [data-harness="' + b.dataset.top + '"]').click(); };
$('#topMore').onclick = () => { if (busy) return; drawer(true); $('#trigger').focus(); };
$('#addTab').onclick = () => $('#new').click();
$('#tabs').addEventListener('click', e => {
  const close = e.target.closest('[data-tab-close]');
  if (close) {
    e.stopPropagation();
    const id = close.dataset.tabClose;
    openTabs = openTabs.filter(x => x !== id);
    if (selectedId === id) selectedId = openTabs.at(-1) ?? null; // 关闭当前标签后回退到上一个，无则回到新对话
    render();
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (!tab || busy) return;
  selectedId = tab.dataset.tab === '__draft' ? null : tab.dataset.tab;
  notice(''); drawer(false); closeMenus(); render();
});
$('#toggleSide').onclick = () => window.Workbench.toggle();
$('#toggleSide').title = '打开右侧工作区';
window.Workbench.init({ confirm: confirmDialog, notice });
setInterval(() => window.Transcript.updateClocks(), 1000);
$('#search').onclick = () => { const term = prompt('搜索任务'); if (term === null) return; document.querySelectorAll('.task').forEach(t => { t.hidden = !t.textContent.toLowerCase().includes(term.toLowerCase()); }); };
document.addEventListener('click', e => {
  const panel = e.target.closest('[data-panel]'); if (panel) notice(panel.dataset.panel + ' 功能尚未接入，当前先完成界面。');
});
