import { collaborationIcon } from './collaboration-icon.js';

export interface TeamMemberPayload { id: string; name: string; role: string; agent: string; childId?: string; child_thread_id?: string; display_status?: string }
export interface TeamTaskPayload { id: string; title: string; assignee: string; dependsOn?: string[]; status: string }
export interface TeamMessagePayload { id: string; fromName?: string; from: string; to: string; body: string; at: number }
export interface TeamCardPayload {
  action?: string; team_id: string; name: string; goal: string; status: string; lead_thread_id?: string;
  lead?: TeamMemberPayload; members: TeamMemberPayload[]; tasks: TeamTaskPayload[]; messages: TeamMessagePayload[]; updated_at?: number;
}
interface TeamSnapshot { id: string; action: string; at: number; team: TeamCardPayload }
interface TeamInspection { team: TeamCardPayload; snapshots: TeamSnapshot[] }
interface ActiveTeamContext { threadId: string; anchor: Element }
interface TeamCardOptions {
  inspectTeam?: (threadId: string, teamId?: string) => Promise<unknown>;
  openThread?: (threadId: string) => Promise<unknown> | unknown;
  activeThread?: () => ActiveTeamContext | null;
}

function jsonObjectAt(value: string, start: number): string | null {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < value.length; index++) {
    const char = value[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true; else if (char === '{') depth++; else if (char === '}' && --depth === 0) return value.slice(start, index + 1);
  }
  return null;
}
function isTeam(value: unknown): value is TeamCardPayload {
  if (!value || typeof value !== 'object') return false;
  const team = value as Partial<TeamCardPayload>;
  return typeof team.team_id === 'string' && typeof team.name === 'string' && Array.isArray(team.members) && Array.isArray(team.tasks) && Array.isArray(team.messages);
}
export function parseTeamPayload(value: string): TeamCardPayload | null {
  if (!value.includes('"team_id"') || !value.includes('"members"') || !value.includes('"tasks"')) return null;
  for (let start = value.indexOf('{'); start >= 0; start = value.indexOf('{', start + 1)) {
    const candidate = jsonObjectAt(value, start); if (!candidate?.includes('"team_id"')) continue;
    try { const parsed: unknown = JSON.parse(candidate); if (isTeam(parsed)) return parsed; } catch {}
  }
  return null;
}
function parseInspection(value: unknown): TeamInspection | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<TeamInspection>;
  if (!isTeam(result.team) || !Array.isArray(result.snapshots)) return null;
  return { team: result.team, snapshots: result.snapshots.filter(entry => entry && typeof entry === 'object' && isTeam((entry as TeamSnapshot).team)) as TeamSnapshot[] };
}
const stateColor = (status?: string) => ({ ready: '#8b8b8b', pending: '#8b8b8b', working: '#2878e3', in_progress: '#2878e3', active: '#2878e3', completed: '#1f9d68', blocked: '#c17022', failed: '#d14343', interrupted: '#c17022' }[status ?? ''] ?? '#8b8b8b');
const stateLabel = (status?: string) => ({ ready: '就绪', pending: '待开始', working: '工作中', in_progress: '进行中', completed: '已完成', blocked: '等待依赖', failed: '失败', interrupted: '已中断', active: '协作中' }[status ?? ''] ?? status ?? '未知');
const actionLabel = (action?: string) => ({ team_created: '团队建立', task_assigned: '任务分配', task_updated: '任务更新', message_sent: '团队通信', task_started: '开始执行', member_session_ready: '会话就绪', task_settled: '任务结算', task_failed: '任务失败', task_cancelled: '任务取消', task_interrupted: '任务中断', task_resumed: '恢复执行', task_followup: '继续执行' }[action ?? ''] ?? action ?? '实时状态');
const memberPalette = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#f97316', '#ec4899', '#14b8a6', '#6366f1'];
const memberColor = (index: number) => memberPalette[index % memberPalette.length];
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, css?: string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); if (className) node.className = className; if (css) node.style.cssText = css; return node; }
function text(tag: keyof HTMLElementTagNameMap, value: string, css?: string) { const node = el(tag, undefined, css); node.textContent = value; return node; }

const TEAM_STYLE = `
.harness-mix-team-scroll{scrollbar-width:none}
.harness-mix-team-scroll::-webkit-scrollbar{display:none}
.harness-mix-team-workbench{container-type:inline-size}
.harness-mix-team-body{display:grid;grid-template-columns:minmax(0,1fr) clamp(228px,24vw,300px);min-height:0;overflow:hidden}
.harness-mix-team-lanes{display:flex;gap:16px;min-height:0;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;padding:18px 16px 10px;justify-content:safe center;scroll-snap-type:x proximity}
.harness-mix-team-lane{position:relative;flex:1 1 0;min-width:216px;max-width:300px;display:flex;flex-direction:column;min-height:0;padding-top:16px;scroll-snap-align:start}
.harness-mix-team-lane::before{content:'';position:absolute;top:0;left:50%;height:16px;border-left:2px dashed color-mix(in srgb,currentColor 20%,transparent)}
.harness-mix-team-lane::after{content:'';position:absolute;top:0;left:-9px;right:-9px;border-top:2px dashed color-mix(in srgb,currentColor 20%,transparent)}
.harness-mix-team-lane:first-child::after{left:calc(50% - 1px)}
.harness-mix-team-lane:last-child::after{right:calc(50% - 1px)}
.harness-mix-team-lane:only-child::after{display:none}
.harness-mix-team-task-list{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;overflow-y:auto;padding:2px 8px 8px;scrollbar-width:none}
.harness-mix-team-task-list::-webkit-scrollbar{display:none}
.harness-mix-team-feed{display:flex;flex-direction:column;min-height:0;min-width:0;border-left:1px solid color-mix(in srgb,currentColor 9%,transparent)}
.harness-mix-team-feed-list{flex:1;min-height:0;overflow-y:auto;padding:0 12px 10px;scrollbar-width:thin}
.harness-mix-team-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.harness-mix-team-clickable{transition:border-color .15s ease,box-shadow .15s ease}
.harness-mix-team-clickable:hover{border-color:color-mix(in srgb,currentColor 28%,transparent)!important;box-shadow:0 4px 14px color-mix(in srgb,#000 10%,transparent)!important}
@container (max-width:720px){
  .harness-mix-team-body{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}
  .harness-mix-team-feed{border-left:0;border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);max-height:136px}
}`;

function metrics(payload: TeamCardPayload) {
  const node = el('div', 'harness-mix-team-metrics', 'display:flex;gap:18px;align-items:center');
  const values: Array<[string, string, string]> = [[`${payload.tasks.filter(task => task.status === 'completed').length}/${payload.tasks.length}`, '完成', '#1f9d68'], [`${payload.tasks.filter(task => task.status === 'in_progress').length}`, '进行中', '#2878e3'], [`${payload.tasks.filter(task => task.status === 'blocked').length}`, '等待', '#c17022']];
  for (const [value, label, color] of values) { const item = el('span', undefined, 'display:grid;justify-items:center;line-height:1.1'); item.append(text('strong', value, `font-size:14px;color:${color}`), text('small', label, 'font-size:10px;margin-top:3px;opacity:.55')); node.append(item); }
  return node;
}
const completionOf = (payload: TeamCardPayload) => { const total = payload.tasks.length; const done = payload.tasks.filter(task => task.status === 'completed').length; return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }; };
function statItem(value: string, label: string, color: string) {
  const item = el('span', undefined, 'display:grid;justify-items:center;line-height:1.1;min-width:30px');
  item.append(text('strong', value, `font-size:15px;font-weight:750;color:${color}`), text('small', label, 'font-size:8.5px;margin-top:2px;opacity:.55;white-space:nowrap'));
  return item;
}
function headerStats(payload: TeamCardPayload) {
  const items = [
    statItem(String(payload.tasks.length), '任务总数', 'inherit'),
    statItem(String(payload.tasks.filter(task => task.status === 'in_progress').length), '进行中', '#2878e3'),
    statItem(String(completionOf(payload).done), '已完成', '#1f9d68'),
    statItem(String(payload.tasks.filter(task => task.status === 'blocked' || task.status === 'pending').length), '等待', '#c17022'),
  ];
  const failed = payload.tasks.filter(task => task.status === 'failed').length;
  if (failed) items.push(statItem(String(failed), '失败', '#d14343'));
  return items;
}
const pillCss = (status?: string) => { const color = stateColor(status); return `font-size:8px;font-weight:750;padding:2px 7px;border-radius:99px;white-space:nowrap;color:${color};background:color-mix(in srgb,${color} 15%,transparent)`; };
function statusPill(status?: string) { return text('span', stateLabel(status), pillCss(status)); }
function statusDot(status: string | undefined, size = 7) { return el('span', undefined, `width:${size}px;height:${size}px;border-radius:50%;flex:none;background:${stateColor(status)}`); }

function renderBoard(payload: TeamCardPayload, openThread?: TeamCardOptions['openThread']) {
  const board = el('main', 'harness-mix-team-board harness-mix-team-body', 'height:100%;min-height:0;color:inherit');
  const lead = payload.lead ?? { id: 'lead', name: 'Team Lead', role: '协调与验收', agent: 'codex', display_status: 'working' };
  const tasksOf = (memberId: string) => payload.tasks.filter(task => task.assignee === memberId);

  const leadCard = () => {
    const button = el('button', 'harness-mix-team-lead', 'appearance:none;border:1px solid color-mix(in srgb,#c35b24 34%,transparent);background:color-mix(in srgb,#c35b24 7%,transparent);box-shadow:0 2px 10px color-mix(in srgb,#c35b24 10%,transparent);color:inherit;font:inherit;display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:13px;cursor:default'); button.type = 'button'; button.dataset.agent = lead.agent;
    const childId = lead.childId ?? lead.child_thread_id;
    if (childId && openThread) { button.style.cursor = 'pointer'; button.classList.add('harness-mix-team-clickable'); button.title = `打开 ${lead.name} 的原生 Harness 会话`; button.addEventListener('click', () => void openThread(childId)); }
    const avatar = el('span', undefined, 'position:relative;display:grid;place-items:center;width:42px;height:42px;flex:none;border-radius:12px;border:2px solid color-mix(in srgb,#c35b24 45%,transparent);background:Canvas');
    avatar.append(collaborationIcon(lead.agent, lead.name, 32), text('span', '👑', 'position:absolute;top:-12px;right:-10px;font-size:13px;filter:drop-shadow(0 1px 1px rgb(0 0 0/.25))'));
    const copy = el('span', undefined, 'display:grid;min-width:0;text-align:left;line-height:1.3');
    copy.append(text('span', '主导者', 'font-size:8.5px;font-weight:800;letter-spacing:.14em;color:#c35b24'), text('strong', lead.name, 'font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'));
    const status = el('span', undefined, 'display:flex;align-items:center;gap:5px;margin-top:1px');
    status.append(statusDot(lead.display_status), text('span', stateLabel(lead.display_status), `font-size:9px;color:${stateColor(lead.display_status)}`));
    copy.append(status); button.append(avatar, copy); return button;
  };
  const memberCard = (member: TeamMemberPayload, index: number) => {
    const color = memberColor(index), assigned = tasksOf(member.id), done = assigned.filter(task => task.status === 'completed').length;
    const button = el('button', 'harness-mix-team-member', 'appearance:none;width:100%;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,Canvas 92%,transparent);box-shadow:0 2px 8px color-mix(in srgb,#000 6%,transparent);color:inherit;font:inherit;display:grid;grid-template-columns:40px minmax(0,1fr);align-items:center;gap:9px;padding:9px 10px;border-radius:12px;text-align:left;cursor:default'); button.type = 'button'; button.dataset.agent = member.agent;
    const childId = member.childId ?? member.child_thread_id;
    if (childId && openThread) { button.style.cursor = 'pointer'; button.classList.add('harness-mix-team-clickable'); button.title = `打开 ${member.name} 的原生 Harness 会话`; button.addEventListener('click', () => void openThread(childId)); }
    const avatar = el('span', undefined, `position:relative;display:grid;place-items:center;width:40px;height:40px;flex:none;border-radius:11px;border:2px solid ${color};background:Canvas`);
    avatar.append(collaborationIcon(member.agent, member.name, 30), el('span', undefined, `position:absolute;right:-4px;bottom:-4px;width:11px;height:11px;box-sizing:border-box;border-radius:50%;background:${stateColor(member.display_status)};border:2.5px solid Canvas`));
    const copy = el('span', undefined, 'display:grid;min-width:0;line-height:1.25;gap:2px');
    copy.append(text('strong', member.name, 'font-size:12px;font-weight:680;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'));
    const status = el('span', undefined, 'display:flex;align-items:center;gap:5px;min-width:0');
    status.append(text('span', stateLabel(member.display_status), `font-size:9px;color:${stateColor(member.display_status)};white-space:nowrap`), text('span', `${done}/${assigned.length}`, 'font-size:9px;font-weight:650;opacity:.5;margin-left:auto'));
    copy.append(status);
    const progress = el('progress'); progress.max = Math.max(1, assigned.length); progress.value = done; progress.style.cssText = `width:100%;height:4px;margin:0;accent-color:${color}`; progress.title = `${done}/${assigned.length} 个任务完成`;
    copy.append(progress); button.append(avatar, copy); return button;
  };
  const laneOf = (member: TeamMemberPayload, index: number) => {
    const color = memberColor(index), assigned = tasksOf(member.id), done = assigned.filter(task => task.status === 'completed').length;
    const lane = el('div', 'harness-mix-team-lane'); lane.dataset.memberId = member.id;
    lane.append(memberCard(member, index));
    const column = el('div', undefined, `margin-top:9px;flex:1;min-height:0;display:flex;flex-direction:column;border-radius:12px;border:1px solid color-mix(in srgb,${color} 30%,transparent);background:color-mix(in srgb,${color} 7%,transparent)`);
    const columnHead = el('div', undefined, 'display:flex;align-items:flex-start;gap:6px;padding:8px 10px 5px');
    const role = text('span', member.role, 'font-size:9.5px;font-weight:650;line-height:1.35;min-width:0;opacity:.78'); role.className = 'harness-mix-team-clamp2'; role.title = member.role;
    columnHead.append(el('span', undefined, `width:7px;height:7px;border-radius:2.5px;background:${color};flex:none;margin-top:3px`), role, text('span', `${done}/${assigned.length}`, `margin-left:auto;font-size:8.5px;font-weight:750;color:${color};background:color-mix(in srgb,${color} 15%,transparent);padding:1px 6px;border-radius:99px;white-space:nowrap`));
    column.append(columnHead);
    const list = el('div', 'harness-mix-team-task-list');
    for (const task of assigned) {
      const card = el('article', 'harness-mix-team-task', 'display:grid;gap:5px;padding:7px 8px;border-radius:9px;border:1px solid color-mix(in srgb,currentColor 8%,transparent);background:color-mix(in srgb,Canvas 94%,transparent)'); card.dataset.taskId = task.id; card.dataset.taskStatus = task.status;
      const topRow = el('div', undefined, 'display:flex;align-items:center;gap:6px;min-width:0');
      const pill = statusPill(task.status); pill.style.marginLeft = 'auto';
      topRow.append(text('span', `#${task.id}`, 'font-family:ui-monospace,monospace;font-size:8px;opacity:.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:92px'), pill);
      const title = text('div', task.title, 'font-size:10.5px;font-weight:620;line-height:1.35'); title.className = 'harness-mix-team-clamp2'; title.title = task.title;
      card.append(topRow, title);
      if ((task.dependsOn?.length ?? 0) > 0) card.append(text('div', `依赖 ${task.dependsOn!.length} 项任务`, 'font-size:8px;opacity:.45'));
      list.append(card);
    }
    if (!assigned.length) list.append(text('div', '等待主导者分配任务', 'font-size:9px;opacity:.42;padding:10px 2px;text-align:center'));
    column.append(list); lane.append(column); return lane;
  };

  const left = el('section', undefined, 'display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0');
  const org = el('div', 'harness-mix-team-org', 'display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 14px 0');
  org.append(leadCard(), text('div', '任务拆解 · 进度协调 · 质量验收 · 最终交付', 'font-size:8.5px;opacity:.45;letter-spacing:.04em'));
  const lanes = el('div', 'harness-mix-team-lanes harness-mix-team-scroll');
  if (payload.members.length) payload.members.forEach((member, index) => lanes.append(laneOf(member, index)));
  else lanes.append(text('div', '尚未添加团队成员。', 'font-size:11px;opacity:.5'));
  left.append(org, lanes);

  const feed = el('aside', 'harness-mix-team-feed');
  const feedHead = el('div', undefined, 'display:flex;align-items:center;gap:6px;padding:11px 12px 8px;flex:none');
  feedHead.append(text('span', '团队动态', 'font-size:10px;font-weight:720;letter-spacing:.06em;opacity:.55'), text('span', String(payload.messages.length), 'font-size:8.5px;font-weight:700;opacity:.6;background:color-mix(in srgb,currentColor 8%,transparent);border-radius:99px;padding:1px 7px'));
  const feedList = el('div', 'harness-mix-team-feed-list');
  for (const message of payload.messages.slice().reverse()) {
    const item = el('article', undefined, 'padding:9px 0;border-top:1px solid color-mix(in srgb,currentColor 7%,transparent)');
    const sender = message.from === 'lead' ? lead : payload.members.find(member => member.id === message.from), receiver = message.to === 'lead' ? lead : payload.members.find(member => member.id === message.to);
    const route = el('div', undefined, 'display:flex;align-items:center;gap:5px;min-width:0;font-size:10.5px;font-weight:700');
    if (sender) route.append(collaborationIcon(sender.agent, sender.name, 16));
    route.append(text('span', message.fromName ?? sender?.name ?? message.from, 'opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'), text('span', '→', 'opacity:.4;font-weight:400'));
    if (receiver) route.append(collaborationIcon(receiver.agent, receiver.name, 16));
    route.append(text('span', message.to === '*' ? '全体' : receiver?.name ?? message.to, 'opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'));
    if (message.at > 0) route.append(text('span', new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'margin-left:auto;font-size:8.5px;font-weight:400;opacity:.4;flex:none'));
    item.append(route, text('div', message.body, 'font-size:11px;line-height:1.5;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;opacity:.88')); feedList.append(item);
  }
  if (!payload.messages.length) feedList.append(text('div', '成员交接、审查请求和结果会实时显示在这里。', 'font-size:10px;line-height:1.5;opacity:.45;padding:10px 0'));
  feed.append(feedHead, feedList);
  board.append(left, feed); return board;
}

function renderSummary(payload: TeamCardPayload, open: () => void) {
  const panel = el('section', 'harness-mix-team-panel', 'box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 90%,transparent);box-shadow:0 8px 28px color-mix(in srgb,#000 7%,transparent);backdrop-filter:blur(18px);color:inherit;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px 14px;display:grid;gap:10px;min-width:0'); panel.dataset.teamId = payload.team_id; panel.dataset.teamStatus = payload.status;
  const top = el('div', undefined, 'display:flex;align-items:center;gap:12px;min-width:0');
  const identity = el('div', undefined, 'display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:10px;min-width:0;flex:1');
  const lead = payload.lead ?? { id: 'lead', name: 'Team Lead', role: '协调与验收', agent: 'codex', display_status: 'working' };
  const leadIcon = el('span', undefined, 'position:relative;display:grid;place-items:center;width:38px;height:38px;flex:none;border:2px solid color-mix(in srgb,#c35b24 40%,transparent);border-radius:11px;background:Canvas');
  leadIcon.append(collaborationIcon(lead.agent, lead.name, 28), text('span', '👑', 'position:absolute;top:-11px;right:-9px;font-size:11px'));
  const copy = el('span', undefined, 'display:grid;min-width:0;gap:1px'), eyebrow = text('span', `AGENT TEAM · ${stateLabel(payload.status)}`, `font-size:9px;font-weight:760;letter-spacing:.11em;color:${stateColor(payload.status)}`), title = text('strong', payload.name, 'font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'); title.className = 'harness-mix-team-name';
  const goal = text('span', payload.goal, 'font-size:10px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'); goal.title = payload.goal;
  copy.append(eyebrow, title, goal); identity.append(leadIcon, copy);
  const button = el('button', 'harness-mix-team-open', 'border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:8px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:650 11px system-ui;padding:7px 10px;cursor:pointer;white-space:nowrap'); button.type = 'button'; button.textContent = '展开详情'; button.addEventListener('click', open); top.append(identity, metrics(payload), button);
  const members = el('div', 'harness-mix-team-summary-members harness-mix-team-scroll', 'display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding-bottom:1px');
  payload.members.forEach((member, index) => {
    const color = memberColor(index);
    const chip = el('span', undefined, 'display:grid;grid-template-columns:26px minmax(0,1fr);align-items:center;gap:7px;min-width:128px;max-width:190px;padding:5px 9px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 8%,transparent);background:color-mix(in srgb,currentColor 3%,transparent)'); chip.title = `${member.name} · ${member.role}`;
    const icon = el('span', undefined, `position:relative;display:grid;place-items:center;width:26px;height:26px;flex:none;border-radius:8px;border:1.5px solid ${color};background:Canvas`);
    icon.append(collaborationIcon(member.agent, member.name, 18), el('span', undefined, `position:absolute;right:-3px;bottom:-3px;width:8px;height:8px;box-sizing:border-box;border-radius:50%;background:${stateColor(member.display_status)};border:2px solid Canvas`));
    const label = el('span', undefined, 'display:grid;min-width:0;line-height:1.2');
    label.append(text('strong', member.name, 'font-size:10px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'), text('span', member.role, 'font-size:8.5px;opacity:.52;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'), text('span', stateLabel(member.display_status), `font-size:8.5px;color:${stateColor(member.display_status)}`));
    chip.append(icon, label); members.append(chip);
  });
  const completed = payload.tasks.filter(task => task.status === 'completed').length, progress = el('progress'); progress.max = Math.max(1, payload.tasks.length); progress.value = completed; progress.style.cssText = 'width:72px;height:5px;accent-color:#1f9d68;margin-left:auto;flex:none'; progress.title = `${completed}/${payload.tasks.length} 个任务完成`; members.append(progress, text('span', `${completed}/${payload.tasks.length}`, 'font-size:9px;font-weight:700;opacity:.52;white-space:nowrap'));
  panel.append(top, members); return panel;
}

export function installTeamCards(options: TeamCardOptions = {}) {
  if (typeof document === 'undefined') return { scan: () => {}, dispose: () => {} };
  const style = el('style'); style.dataset.harnessMixTeamStyle = 'true'; style.textContent = TEAM_STYLE; (document.head || document.documentElement).append(style);
  let disposed = false, workbench: HTMLElement | null = null, refreshTimer: ReturnType<typeof setInterval> | null = null, playTimer: ReturnType<typeof setInterval> | null = null, activeTimer: ReturnType<typeof setInterval> | null = null;
  let activePanel: HTMLElement | null = null, activeSignature = '', activeThreadId = '', activeRefreshPending = false;
  const signatures = new WeakMap<Element, string>();
  const close = () => { workbench?.remove(); workbench = null; if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; if (playTimer) clearInterval(playTimer); playTimer = null; };
  const open = (seed: TeamCardPayload) => {
    if (workbench?.dataset.teamId === seed.team_id) { close(); return; }
    close();
    const source = [...document.querySelectorAll<HTMLElement>('.harness-mix-team-panel')].find(node => node.dataset.teamId === seed.team_id);
    if (!source?.parentElement) return;
    workbench = el('section', 'harness-mix-team-workbench', 'box-sizing:border-box;margin:8px 0 12px;border:1px solid color-mix(in srgb,currentColor 11%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 94%,transparent);box-shadow:0 12px 34px color-mix(in srgb,#000 8%,transparent);backdrop-filter:blur(20px);color:inherit;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-rows:auto minmax(0,1fr);height:clamp(340px,64vh,660px);min-height:300px;overflow:hidden');
    workbench.dataset.teamId = seed.team_id; workbench.dataset.teamSource = source.dataset.teamSource ?? 'tool';
    let current = seed, snapshots: TeamSnapshot[] = [], index = -1;
    const header = el('header', undefined, 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;row-gap:8px;min-height:56px;padding:8px 14px;border-bottom:1px solid color-mix(in srgb,currentColor 9%,transparent);background:color-mix(in srgb,currentColor 2%,transparent)');
    const title = el('div', undefined, 'display:grid;gap:1px;min-width:150px;max-width:min(320px,30vw)');
    const nameRow = el('div', undefined, 'display:flex;align-items:center;gap:7px;min-width:0');
    const teamName = text('strong', current.name, 'font-size:13px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'); teamName.className = 'harness-mix-team-name';
    const teamPill = statusPill(current.status);
    nameRow.append(teamName, teamPill);
    const subtitle = text('div', current.goal, 'font-size:9px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'); subtitle.title = current.goal;
    title.append(nameRow, subtitle);
    const statsWrap = el('div', undefined, 'display:flex;align-items:center;gap:15px;flex-wrap:wrap');
    const progressWrap = el('div', undefined, 'display:flex;align-items:center;gap:7px;flex:none');
    progressWrap.append(text('span', '整体进度', 'font-size:9px;opacity:.55;white-space:nowrap'));
    const progressBar = el('progress'); progressBar.style.cssText = 'width:92px;height:5px;accent-color:#1f9d68';
    const progressPct = text('strong', '0%', 'font-size:11px;font-weight:750;color:#1f9d68;min-width:30px');
    progressWrap.append(progressBar, progressPct);
    const timeline = el('div', 'harness-mix-team-timeline', 'display:flex;align-items:center;gap:6px;margin-left:auto;min-width:0'), event = text('span', '实时状态', 'font-size:9px;opacity:.55;min-width:60px;text-align:right'), range = el('input'); range.type = 'range'; range.min = '0'; range.max = '0'; range.value = '0'; range.style.cssText = 'width:min(120px,16vw);accent-color:#2878e3';
    const live = el('button', undefined, 'border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:transparent;color:inherit;font:600 10px system-ui;padding:5px 7px;cursor:pointer'); live.type = 'button'; live.textContent = '实时';
    const play = el('button', undefined, 'border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:color-mix(in srgb,currentColor 6%,transparent);color:inherit;font:600 10px system-ui;padding:5px 8px;cursor:pointer'); play.type = 'button'; play.textContent = '回放';
    const collapse = el('button', 'harness-mix-team-back', 'border:0;background:transparent;color:inherit;font:650 10px system-ui;cursor:pointer;padding:6px 7px;opacity:.68'); collapse.type = 'button'; collapse.textContent = '收起详情'; collapse.addEventListener('click', close); timeline.append(event, range, live, play, collapse); header.append(title, statsWrap, progressWrap, timeline);
    const content = el('div', undefined, 'min-height:0'); workbench.append(header, content); source.after(workbench);
    const render = () => {
      const snapshot = index >= 0 ? snapshots[index] : undefined;
      const visible = snapshot?.team ?? current;
      content.replaceChildren(renderBoard(visible, async threadId => { close(); await options.openThread?.(threadId); }));
      teamName.textContent = visible.name; subtitle.textContent = visible.goal; subtitle.title = visible.goal;
      teamPill.textContent = stateLabel(visible.status); teamPill.style.cssText = pillCss(visible.status);
      statsWrap.replaceChildren(...headerStats(visible));
      const completion = completionOf(visible); progressBar.max = Math.max(1, completion.total); progressBar.value = completion.done; progressPct.textContent = `${completion.pct}%`;
      range.max = String(Math.max(0, snapshots.length - 1));
      range.value = String(index >= 0 ? index : Math.max(0, snapshots.length - 1));
      event.textContent = snapshot ? `${actionLabel(snapshot.action)} · ${new Date(snapshot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '● 实时状态';
    };
    range.addEventListener('input', () => { index = Number(range.value); render(); }); live.addEventListener('click', () => { index = -1; render(); });
    play.addEventListener('click', () => { if (playTimer) { clearInterval(playTimer); playTimer = null; play.textContent = '回放'; return; } index = index < 0 ? 0 : index; play.textContent = '暂停'; render(); playTimer = setInterval(() => { if (index >= snapshots.length - 1) { if (playTimer) clearInterval(playTimer); playTimer = null; index = -1; play.textContent = '回放'; } else index++; render(); }, 800); });
    const refresh = async () => { if (!options.inspectTeam || !seed.lead_thread_id || !workbench) return; try { const result = parseInspection(await options.inspectTeam(seed.lead_thread_id, seed.team_id)); if (!result || !workbench) return; current = result.team; snapshots = result.snapshots; render(); } catch {} };
    render(); void refresh(); refreshTimer = setInterval(() => void refresh(), 1500);
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && workbench) close(); }; document.addEventListener('keydown', onKey);
  const scan = () => {
    if (disposed) return;
    const selector = '[data-testid*="tool"], [data-turn-key], [data-local-conversation-item-target-ids], pre[data-testid*="tool"]';
    for (const candidate of document.querySelectorAll<HTMLElement>(selector)) { if (candidate.closest('.harness-mix-team-panel,.harness-mix-team-workbench')) continue; const payload = parseTeamPayload(candidate.textContent ?? ''); if (!payload) continue; if ([...candidate.querySelectorAll<HTMLElement>(selector)].some(child => parseTeamPayload(child.textContent ?? ''))) continue; const signature = `${payload.updated_at ?? 0}:${payload.tasks.length}:${payload.messages.length}`; if (signatures.get(candidate) === signature) continue; const panel = renderSummary(payload, () => open(payload)); if (candidate.tagName === 'PRE') { if (!candidate.dataset.harnessMixTeamDisplay) candidate.dataset.harnessMixTeamDisplay = candidate.style.display || '__empty__'; candidate.style.display = 'none'; if (candidate.nextElementSibling?.classList.contains('harness-mix-team-panel')) candidate.nextElementSibling.remove(); candidate.after(panel); } else { candidate.querySelector(':scope > .harness-mix-team-panel')?.remove(); candidate.append(panel); } signatures.set(candidate, signature); }
  };
  const removeActivePanel = () => { if (workbench?.dataset.teamSource === 'active-thread') close(); activePanel?.remove(); activePanel = null; activeSignature = ''; activeThreadId = ''; };
  const refreshActiveTeam = async () => {
    if (disposed || activeRefreshPending || !options.inspectTeam || !options.activeThread) return;
    const context = options.activeThread();
    if (!context?.anchor.isConnected) { removeActivePanel(); return; }
    activeRefreshPending = true;
    try {
      const result = parseInspection(await options.inspectTeam(context.threadId));
      if (disposed) return;
      const latest = options.activeThread();
      if (!latest || latest.threadId !== context.threadId || !latest.anchor.isConnected) { removeActivePanel(); return; }
      if (!result) { removeActivePanel(); return; }
      const payload = result.team;
      const signature = `${context.threadId}:${payload.team_id}:${payload.updated_at ?? 0}:${payload.tasks.length}:${payload.messages.length}`;
      const inlinePanel = [...document.querySelectorAll<HTMLElement>('.harness-mix-team-panel')]
        .find(node => node !== activePanel && node.dataset.teamId === payload.team_id);
      if (inlinePanel) { removeActivePanel(); return; }
      if (activePanel?.isConnected && activeSignature === signature && activeThreadId === context.threadId) return;
      const reopen = workbench?.dataset.teamId === payload.team_id && workbench.dataset.teamSource === 'active-thread';
      removeActivePanel();
      activePanel = renderSummary(payload, () => open(payload));
      activePanel.classList.add('harness-mix-team-launcher');
      activePanel.dataset.teamSource = 'active-thread';
      activePanel.style.cssText += ';margin:8px 16px 0;flex:none;position:relative;z-index:11';
      const parent = latest.anchor.parentElement;
      if (!parent) { removeActivePanel(); return; }
      parent.insertBefore(activePanel, latest.anchor);
      activeSignature = signature;
      activeThreadId = context.threadId;
      if (reopen) open(payload);
    } catch {
      removeActivePanel();
    } finally {
      activeRefreshPending = false;
    }
  };
  const observer = new MutationObserver(scan); observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true }); scan();
  void refreshActiveTeam();
  activeTimer = setInterval(() => void refreshActiveTeam(), 1500);
  return { scan, close, dispose() { disposed = true; observer.disconnect(); if (activeTimer) clearInterval(activeTimer); activeTimer = null; removeActivePanel(); close(); style.remove(); document.removeEventListener('keydown', onKey); document.querySelectorAll('.harness-mix-team-panel').forEach(node => node.remove()); document.querySelectorAll<HTMLElement>('[data-harness-mix-team-display]').forEach(node => { node.style.display = node.dataset.harnessMixTeamDisplay === '__empty__' ? '' : node.dataset.harnessMixTeamDisplay ?? ''; delete node.dataset.harnessMixTeamDisplay; }); } };
}
