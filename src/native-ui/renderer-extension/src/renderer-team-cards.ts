import { collaborationIcon } from "./collaboration-icon.js";
import type { CollaborationUserActionInput } from "./renderer-model-client.js";

export interface TeamMemberPayload { id: string; name: string; role: string; agent: string; childId?: string; child_thread_id?: string; display_status?: string; unread?: number }
export interface TeamTaskPayload { id: string; title: string; assignee: string; dependsOn?: string[]; status: string }
export interface TeamMessagePayload { id: string; fromName?: string; from: string; to: string; body: string; at: number }
export interface TeamDriverPayload {
  script_id: string; status: string; phase?: string | null; error?: string | null; result?: unknown;
  tasks?: Array<{ task_id: string; title: string; status: string }>;
}
export interface TeamCardPayload {
  action?: string; team_id: string; name: string; goal: string; status: string; lead_thread_id?: string;
  lead?: TeamMemberPayload; members: TeamMemberPayload[]; tasks: TeamTaskPayload[]; messages: TeamMessagePayload[]; updated_at?: number;
  driver?: TeamDriverPayload;
}
interface TeamHistoryEntry { id: string; action: string; at: number; team: TeamCardPayload }
interface TeamInspectionResult { team: TeamCardPayload; snapshots: TeamHistoryEntry[] }
interface ActiveTeamSlot { threadId: string; anchor: Element }
export type TeamUserAction = (input: CollaborationUserActionInput) => Promise<unknown>;
interface TeamCardOptions {
  inspectTeam?: (threadId: string, teamId?: string) => Promise<unknown>;
  openThread?: (threadId: string) => Promise<unknown> | unknown;
  activeThread?: () => ActiveTeamSlot | null;
  userAction?: TeamUserAction;
}

/* ---------------------------------------------------------------------------
 * Payload extraction
 * ------------------------------------------------------------------------- */

/** Slice the balanced, quote-aware JSON object that starts at `start`. */
function sliceJsonObject(source: string, start: number): string | null {
  let depth = 0, inString = false, escaped = false;
  for (let cursor = start; cursor < source.length; cursor++) {
    const ch = source[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return source.slice(start, cursor + 1);
  }
  return null;
}

function isTeamPayload(value: unknown): value is TeamCardPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TeamCardPayload>;
  return typeof candidate.team_id === "string" && typeof candidate.name === "string" && Array.isArray(candidate.members) && Array.isArray(candidate.tasks) && Array.isArray(candidate.messages);
}

export function parseTeamPayload(value: string): TeamCardPayload | null {
  if (!value.includes("\"team_id\"") || !value.includes("\"members\"") || !value.includes("\"tasks\"")) return null;
  for (let brace = value.indexOf("{"); brace >= 0; brace = value.indexOf("{", brace + 1)) {
    const candidate = sliceJsonObject(value, brace);
    if (!candidate?.includes("\"team_id\"")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isTeamPayload(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function parseInspectionResult(value: unknown): TeamInspectionResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<TeamInspectionResult>;
  if (!isTeamPayload(result.team) || !Array.isArray(result.snapshots)) return null;
  const snapshots = result.snapshots.filter(
    (entry) => entry && typeof entry === "object" && isTeamPayload((entry as TeamHistoryEntry).team),
  ) as TeamHistoryEntry[];
  return { team: result.team, snapshots };
}

/* ---------------------------------------------------------------------------
 * Presentation tables
 * ------------------------------------------------------------------------- */

const STATUS_COLOR_BY_KEY: Record<string, string> = {
  ready: "#8b8b8b", pending: "#8b8b8b", working: "#2878e3", in_progress: "#2878e3",
  active: "#2878e3", running: "#2878e3", completed: "#1f9d68", blocked: "#c17022",
  failed: "#d14343", interrupted: "#c17022",
};
const stateColor = (status?: string) => STATUS_COLOR_BY_KEY[status ?? ""] ?? "#8b8b8b";
const stateLabel = (status?: string) => ({ ready: "就绪", pending: "待开始", working: "工作中", in_progress: "进行中", running: "运行中", completed: "已完成", blocked: "等待依赖", failed: "失败", interrupted: "已中断", active: "协作中" }[status ?? ""] ?? status ?? "未知");
const actionLabel = (action?: string) => ({ team_created: "团队建立", task_assigned: "任务分配", task_updated: "任务更新", message_sent: "团队通信", message_acknowledged: "未读已清", task_started: "开始执行", member_session_ready: "会话就绪", task_settled: "任务结算", task_failed: "任务失败", task_cancelled: "任务取消", task_interrupted: "任务中断", task_resumed: "恢复执行", task_followup: "继续执行", task_reassigned: "任务改派", task_retry: "自动重试", script_started: "脚本启动", script_phase: "进入阶段", script_completed: "脚本完成", script_failed: "脚本失败", script_interrupted: "脚本中断", script_resumed: "脚本恢复" }[action ?? ""] ?? action ?? "实时状态");
const actionIcon = (action?: string) => ({ team_created: "🎬", task_assigned: "📋", task_updated: "🔄", message_sent: "📨", message_acknowledged: "📭", task_started: "🚀", member_session_ready: "🔌", task_settled: "✅", task_failed: "❌", task_cancelled: "⛔", task_interrupted: "⏸", task_resumed: "▶️", task_followup: "💬", task_reassigned: "🔁", task_retry: "♻️" }[action ?? ""] ?? "•");

const MEMBER_PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#f97316", "#ec4899", "#14b8a6", "#6366f1"];
const memberColor = (index: number) => MEMBER_PALETTE[index % MEMBER_PALETTE.length] ?? "";

/* ---------------------------------------------------------------------------
 * DOM primitives
 * ------------------------------------------------------------------------- */

function dom<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, css?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (css) node.style.cssText = css;
  return node;
}
function labeledDom(tag: keyof HTMLElementTagNameMap, value: string, css?: string) {
  const node = dom(tag, undefined, css);
  node.textContent = value;
  return node;
}

const pillCss = (status?: string) => {
  const color = stateColor(status);
  return `font-size:8px;font-weight:750;padding:2px 7px;border-radius:99px;white-space:nowrap;color:${color};background:color-mix(in srgb,${color} 15%,transparent)`;
};
function statusPill(status?: string) { return labeledDom("span", stateLabel(status), pillCss(status)); }
function statusDot(status: string | undefined, size = 7) {
  const dot = dom("span", "harness-mix-team-status-dot", `width:${size}px;height:${size}px;border-radius:50%;flex:none;background:${stateColor(status)}`);
  dot.dataset.status = status ?? "";
  return dot;
}

/* ---------------------------------------------------------------------------
 * Card actions
 * ------------------------------------------------------------------------- */

// 「打开原生会话」接线：可点态 + hover 反馈 + 失败红框闪烁（绝不静默吞错）。
function wireOpenThread(node: HTMLElement, childId: string | undefined, name: string, openThread?: TeamCardOptions["openThread"]) {
  if (!childId || !openThread) return;
  node.style.cursor = "pointer";
  node.classList.add("harness-mix-team-clickable");
  node.title = `打开 ${name} 的原生 Harness 会话`;
  node.addEventListener("click", async () => {
    try {
      await openThread(childId);
    } catch (error) {
      console.warn("[TeamCards] 打开成员会话失败:", error);
      node.classList.add("harness-mix-team-open-failed");
      setTimeout(() => node.classList.remove("harness-mix-team-open-failed"), 1200);
    }
  });
}

// 看板操作按钮：统一 stopPropagation/preventDefault；失败红框 + 错误 title。
function boardActionButton(label: string, title: string, onClick: () => void, tone?: string) {
  const css = `border:1px solid color-mix(in srgb,${tone ?? "currentColor"} 26%,transparent);border-radius:6px;background:color-mix(in srgb,${tone ?? "currentColor"} 7%,transparent);color:${tone ?? "currentColor"};font:650 9px system-ui;padding:3px 8px;cursor:pointer;white-space:nowrap${tone ? "" : ";opacity:.85"}`;
  const node = dom("button", "harness-mix-team-action", css);
  node.type = "button";
  node.textContent = label;
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick();
  });
  return node;
}

async function runBoardAction(userAction: TeamUserAction, node: HTMLElement, input: CollaborationUserActionInput) {
  node.classList.remove("harness-mix-team-open-failed");
  try {
    await userAction(input);
  } catch (error) {
    console.warn("[TeamCards] 看板操作失败:", error);
    node.classList.add("harness-mix-team-open-failed");
    node.title = `操作失败：${(error as Error)?.message ?? String(error)}`;
    setTimeout(() => node.classList.remove("harness-mix-team-open-failed"), 1800);
  }
}

function continueButton(payload: TeamCardPayload, userAction?: TeamUserAction) {
  const leadBusy = payload.lead?.display_status === "working";
  const node = boardActionButton("继续协作", leadBusy ? "主导者回合进行中，结束后再继续" : "把中断的委派恢复为新的主导者回合", () => {
    if (payload.lead_thread_id) void runBoardAction(userAction!, node, { action: "continue", threadId: payload.lead_thread_id!, teamId: payload.team_id });
  });
  if (leadBusy) {
    node.disabled = true;
    node.style.opacity = ".45";
    node.style.cursor = "not-allowed";
  }
  return node;
}

/* ---------------------------------------------------------------------------
 * Stats
 * ------------------------------------------------------------------------- */

function completionOf(payload: TeamCardPayload) {
  const total = payload.tasks.length;
  const done = payload.tasks.filter((task) => task.status === "completed").length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function statItem(value: string, label: string, color: string) {
  const item = dom("span", undefined, "display:grid;justify-items:center;line-height:1.1;min-width:30px");
  item.append(labeledDom("strong", value, `font-size:15px;font-weight:750;color:${color}`), labeledDom("small", label, "font-size:8.5px;margin-top:2px;opacity:.55;white-space:nowrap"));
  return item;
}

function headerStats(payload: TeamCardPayload) {
  const items = [
    statItem(String(payload.tasks.length), "任务总数", "inherit"),
    statItem(String(payload.tasks.filter((task) => task.status === "in_progress").length), "进行中", "#2878e3"),
    statItem(String(completionOf(payload).done), "已完成", "#1f9d68"),
    statItem(String(payload.tasks.filter((task) => task.status === "blocked" || task.status === "pending").length), "等待", "#c17022"),
  ];
  const failed = payload.tasks.filter((task) => task.status === "failed").length;
  if (failed) items.push(statItem(String(failed), "失败", "#d14343"));
  return items;
}

function summaryMetrics(payload: TeamCardPayload) {
  const node = dom("div", "harness-mix-team-metrics", "display:flex;gap:18px;align-items:center");
  const values: Array<[string, string, string]> = [
    [`${payload.tasks.filter((task) => task.status === "completed").length}/${payload.tasks.length}`, "完成", "#1f9d68"],
    [`${payload.tasks.filter((task) => task.status === "in_progress").length}`, "进行中", "#2878e3"],
    [`${payload.tasks.filter((task) => task.status === "blocked").length}`, "等待", "#c17022"],
  ];
  for (const [value, label, color] of values) {
    const item = dom("span", undefined, "display:grid;justify-items:center;line-height:1.1");
    item.append(labeledDom("strong", value, `font-size:14px;color:${color}`), labeledDom("small", label, "font-size:10px;margin-top:3px;opacity:.55"));
    node.append(item);
  }
  return node;
}

/* ---------------------------------------------------------------------------
 * Detail board (expanded workbench body)
 * ------------------------------------------------------------------------- */

const TEAM_STYLE = `
.harness-mix-team-scroll{scrollbar-width:none}
.harness-mix-team-scroll::-webkit-scrollbar{display:none}
.harness-mix-team-workbench{container-type:inline-size}
.harness-mix-team-body{display:grid;grid-template-columns:minmax(0,1fr) clamp(228px,24vw,300px);min-height:0;overflow:hidden}
.harness-mix-team-lanes{display:flex;gap:16px;min-height:0;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;padding:18px 16px 10px;justify-content:safe center;scroll-snap-type:x proximity}
.harness-mix-team-lane{position:relative;flex:1 1 0;min-width:216px;max-width:300px;display:flex;flex-direction:column;min-height:0;padding-top:16px;scroll-snap-align:start}
.harness-mix-team-lane::before{content:'';position:absolute;top:0;left:50%;width:2px;height:16px;margin-left:-1px;background:repeating-linear-gradient(to bottom,color-mix(in srgb,currentColor 22%,transparent) 0 3px,transparent 3px 7px);animation:harness-mix-team-flow-y 1.4s linear infinite}
.harness-mix-team-lane::after{content:'';position:absolute;top:0;left:-9px;right:-9px;height:2px;background:repeating-linear-gradient(to right,color-mix(in srgb,currentColor 22%,transparent) 0 3px,transparent 3px 7px);animation:harness-mix-team-flow-x 1.4s linear infinite}
.harness-mix-team-lane:first-child::after{left:calc(50% - 1px)}
.harness-mix-team-lane:last-child::after{right:calc(50% - 1px)}
.harness-mix-team-lane:only-child::after{display:none}
.harness-mix-team-lane[data-status="working"]::before{background-image:repeating-linear-gradient(to bottom,color-mix(in srgb,var(--lane-color,currentColor) 85%,transparent) 0 3px,transparent 3px 7px);animation-duration:.55s}
.harness-mix-team-lane[data-status="working"]::after{background-image:repeating-linear-gradient(to right,color-mix(in srgb,var(--lane-color,currentColor) 60%,transparent) 0 3px,transparent 3px 7px);animation-duration:.55s}
.harness-mix-team-task-list{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;overflow-y:auto;padding:2px 8px 8px;scrollbar-width:none}
.harness-mix-team-task-list::-webkit-scrollbar{display:none}
.harness-mix-team-feed{display:flex;flex-direction:column;min-height:0;min-width:0;border-left:1px solid color-mix(in srgb,currentColor 9%,transparent)}
.harness-mix-team-feed-list{flex:1;min-height:0;overflow-y:auto;padding:0 12px 10px;scrollbar-width:thin}
.harness-mix-team-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.harness-mix-team-clickable{transition:border-color .15s ease,box-shadow .15s ease}
.harness-mix-team-clickable:hover{border-color:color-mix(in srgb,currentColor 28%,transparent)!important;box-shadow:0 4px 14px color-mix(in srgb,#000 10%,transparent)!important}
.harness-mix-team-open-failed{border-color:#d14343!important;box-shadow:0 0 0 3px color-mix(in srgb,#d14343 25%,transparent)!important}
.harness-mix-team-member[data-status="working"],.harness-mix-team-lead[data-status="working"]{border-color:color-mix(in srgb,var(--lane-color,#2878e3) 38%,transparent)!important;box-shadow:0 0 12px color-mix(in srgb,var(--lane-color,#2878e3) 18%,transparent)}
.harness-mix-team-avatar[data-status="working"]{animation:harness-mix-team-breathe 2s ease-in-out infinite}
.harness-mix-team-status-dot[data-status="working"]{animation:harness-mix-team-pulse 1.6s ease-in-out infinite}
@keyframes harness-mix-team-flow-y{to{background-position:0 7px}}
@keyframes harness-mix-team-flow-x{to{background-position:7px 0}}
@keyframes harness-mix-team-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--lane-color,#2878e3) 40%,transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--lane-color,#2878e3) 0%,transparent)}}
@keyframes harness-mix-team-breathe{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--lane-color,#2878e3) 28%,transparent)}50%{box-shadow:0 0 10px 2px color-mix(in srgb,var(--lane-color,#2878e3) 38%,transparent)}}
@container (max-width:720px){
  .harness-mix-team-body{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}
  .harness-mix-team-feed{border-left:0;border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);max-height:136px}
}`;

const FALLBACK_LEAD: TeamMemberPayload = { id: "lead", name: "Team Lead", role: "协调与验收", agent: "codex", display_status: "working" };

function leadBadgeCrown(emoji: string, css: string) { return labeledDom("span", emoji, css); }

function buildLeadCard(lead: TeamMemberPayload, openThread?: TeamCardOptions["openThread"]) {
  const button = dom("button", "harness-mix-team-lead", "appearance:none;border:1px solid color-mix(in srgb,#c35b24 34%,transparent);background:color-mix(in srgb,#c35b24 7%,transparent);box-shadow:0 2px 10px color-mix(in srgb,#c35b24 10%,transparent);color:inherit;font:inherit;display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:13px;cursor:default");
  button.type = "button";
  button.dataset.agent = lead.agent;
  button.dataset.status = lead.display_status ?? "";
  wireOpenThread(button, lead.childId ?? lead.child_thread_id, lead.name, openThread);
  const avatar = dom("span", "harness-mix-team-avatar", "position:relative;display:grid;place-items:center;width:42px;height:42px;flex:none;border-radius:12px;border:2px solid color-mix(in srgb,#c35b24 45%,transparent);background:Canvas");
  avatar.dataset.status = lead.display_status ?? "";
  avatar.append(collaborationIcon(lead.agent, lead.name, 32), leadBadgeCrown("👑", "position:absolute;top:-12px;right:-10px;font-size:13px;filter:drop-shadow(0 1px 1px rgb(0 0 0/.25))"));
  const copy = dom("span", undefined, "display:grid;min-width:0;text-align:left;line-height:1.3");
  copy.append(labeledDom("span", "主导者", "font-size:8.5px;font-weight:800;letter-spacing:.14em;color:#c35b24"), labeledDom("strong", lead.name, "font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"));
  const status = dom("span", undefined, "display:flex;align-items:center;gap:5px;margin-top:1px");
  status.append(statusDot(lead.display_status), labeledDom("span", stateLabel(lead.display_status), `font-size:9px;color:${stateColor(lead.display_status)}`));
  copy.append(status);
  button.append(avatar, copy);
  return button;
}

// 用 div 而不是 button：卡片内嵌「追问」按钮，按钮不能嵌套按钮。
function buildMemberCard(member: TeamMemberPayload, index: number, assigned: TeamTaskPayload[], payload: TeamCardPayload, openThread?: TeamCardOptions["openThread"], userAction?: TeamUserAction) {
  const color = memberColor(index);
  const done = assigned.filter((task) => task.status === "completed").length;
  const card = dom("div", "harness-mix-team-member", "position:relative;width:100%;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,Canvas 92%,transparent);box-shadow:0 2px 8px color-mix(in srgb,#000 6%,transparent);color:inherit;font:inherit;display:grid;grid-template-columns:40px minmax(0,1fr);align-items:center;gap:9px;padding:9px 10px;border-radius:12px;text-align:left;cursor:default");
  card.dataset.agent = member.agent;
  card.dataset.status = member.display_status ?? "";
  card.style.setProperty("--lane-color", color);
  wireOpenThread(card, member.childId ?? member.child_thread_id, member.name, openThread);
  const avatar = dom("span", "harness-mix-team-avatar", `position:relative;display:grid;place-items:center;width:40px;height:40px;flex:none;border-radius:11px;border:2px solid ${color};background:Canvas`);
  avatar.dataset.status = member.display_status ?? "";
  const cornerDot = dom("span", "harness-mix-team-status-dot", `position:absolute;right:-4px;bottom:-4px;width:11px;height:11px;box-sizing:border-box;border-radius:50%;background:${stateColor(member.display_status)};border:2.5px solid Canvas`);
  cornerDot.dataset.status = member.display_status ?? "";
  avatar.append(collaborationIcon(member.agent, member.name, 30), cornerDot);
  const copy = dom("span", undefined, "display:grid;min-width:0;line-height:1.25;gap:2px");
  copy.append(labeledDom("strong", member.name, "font-size:12px;font-weight:680;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"));
  const status = dom("span", undefined, "display:flex;align-items:center;gap:5px;min-width:0");
  status.append(
    labeledDom("span", stateLabel(member.display_status), `font-size:9px;color:${stateColor(member.display_status)};white-space:nowrap`),
    labeledDom("span", `${done}/${assigned.length}`, "font-size:9px;font-weight:650;opacity:.5;margin-left:auto"),
  );
  if (member.unread) {
    // 未读 = 还没送达成员会话的消息；「已读」只是把滞留消息清零确认，投递历史仍保留。
    if (userAction && payload.lead_thread_id) {
      const ack = boardActionButton(`💬${member.unread} 已读`, `把 ${member.name} 名下 ${member.unread} 条未送达消息标记为已读`, () => {
        void runBoardAction(userAction, ack, { action: "message/ack", threadId: payload.lead_thread_id!, teamId: payload.team_id, memberId: member.id });
      }, "#2878e3");
      status.append(ack);
    } else {
      status.append(labeledDom("span", `💬${member.unread}`, "font-size:8.5px;font-weight:700;color:#2878e3;background:color-mix(in srgb,#2878e3 12%,transparent);border-radius:99px;padding:1px 6px;flex:none"));
    }
  }
  copy.append(status);
  const progress = dom("progress");
  progress.max = Math.max(1, assigned.length);
  progress.value = done;
  progress.style.cssText = `width:100%;height:4px;margin:0;accent-color:${color}`;
  progress.title = `${done}/${assigned.length} 个任务完成`;
  copy.append(progress);
  card.append(avatar, copy);
  if (userAction && payload.lead_thread_id) {
    const askRow = dom("span", undefined, "position:absolute;top:5px;right:6px;display:flex;align-items:center;gap:4px;max-width:72%");
    const askButton = boardActionButton("追问", `以主导者身份向 ${member.name} 发送团队消息`, () => {
      const input = dom("input", undefined, "font:600 10px system-ui;padding:3px 6px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);color:inherit;background:Canvas;min-width:96px;flex:1");
      input.placeholder = `向 ${member.name} 说…`;
      const send = boardActionButton("发送", "发送团队消息", () => {
        const message = input.value.trim();
        if (message) void runBoardAction(userAction, send, { action: "message/send", threadId: payload.lead_thread_id!, teamId: payload.team_id, to: member.id, message });
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") send.click();
      });
      askRow.replaceChildren(input, send, boardActionButton("×", "取消", () => askRow.replaceChildren(askButton)));
      input.focus();
    });
    askRow.append(askButton);
    card.append(askRow);
  }
  return card;
}

function buildTaskCard(task: TeamTaskPayload, payload: TeamCardPayload, userAction?: TeamUserAction) {
  const card = dom("article", "harness-mix-team-task", "display:grid;gap:5px;padding:7px 8px;border-radius:9px;border:1px solid color-mix(in srgb,currentColor 8%,transparent);background:color-mix(in srgb,Canvas 94%,transparent)");
  card.dataset.taskId = task.id;
  card.dataset.taskStatus = task.status;
  const topRow = dom("div", undefined, "display:flex;align-items:center;gap:6px;min-width:0");
  const pill = statusPill(task.status);
  pill.style.marginLeft = "auto";
  topRow.append(labeledDom("span", `#${task.id}`, "font-family:ui-monospace,monospace;font-size:8px;opacity:.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:92px"), pill);
  const title = labeledDom("div", task.title, "font-size:10.5px;font-weight:620;line-height:1.35");
  title.className = "harness-mix-team-clamp2";
  title.title = task.title;
  card.append(topRow, title);
  if ((task.dependsOn?.length ?? 0) > 0) card.append(labeledDom("div", `依赖 ${task.dependsOn!.length} 项任务`, "font-size:8px;opacity:.45"));
  if (userAction && payload.lead_thread_id) {
    const assignee = payload.members.find((member) => member.id === task.assignee);
    const row = dom("div", undefined, "display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0");
    const renderDefaultControls = () => {
      row.replaceChildren();
      if (task.status === "in_progress") {
        row.append(boardActionButton("取消", "取消该任务并停止成员会话", () => {
          if (window.confirm(`取消任务「${task.title}」？运行中的成员会话将被停止。`)) void runBoardAction(userAction, row, { action: "task/cancel", threadId: payload.lead_thread_id!, teamId: payload.team_id, taskId: task.id });
        }, "#d14343"));
      } else if (task.status === "failed" || task.status === "interrupted") {
        row.append(
          boardActionButton(task.status === "failed" ? "重试" : "恢复", `把任务重新派给 ${assignee?.name ?? "原成员"}`, () => {
            void runBoardAction(userAction, row, { action: "task/reassign", threadId: payload.lead_thread_id!, teamId: payload.team_id, taskId: task.id, memberId: task.assignee });
          }, "#c17022"),
          boardActionButton("改派", "改派给其他成员", () => {
            const select = dom("select", undefined, "font:600 9px system-ui;padding:3px 4px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);color:inherit;background:Canvas;max-width:120px;min-width:0");
            select.append(new Option("改派给…", ""));
            for (const candidate of payload.members) if (candidate.id !== task.assignee) select.append(new Option(candidate.name, candidate.id));
            const go = boardActionButton("确定", "执行改派", () => {
              if (select.value) void runBoardAction(userAction, row, { action: "task/reassign", threadId: payload.lead_thread_id!, teamId: payload.team_id, taskId: task.id, memberId: select.value });
            });
            row.replaceChildren(select, go, boardActionButton("×", "取消改派", renderDefaultControls));
          }),
        );
      }
    };
    renderDefaultControls();
    if (row.childElementCount) card.append(row);
  }
  return card;
}

function buildMemberLane(member: TeamMemberPayload, index: number, payload: TeamCardPayload, openThread?: TeamCardOptions["openThread"], userAction?: TeamUserAction) {
  const color = memberColor(index);
  const assigned = payload.tasks.filter((task) => task.assignee === member.id);
  const done = assigned.filter((task) => task.status === "completed").length;
  const lane = dom("div", "harness-mix-team-lane");
  lane.dataset.memberId = member.id;
  lane.dataset.status = member.display_status ?? "";
  lane.style.setProperty("--lane-color", color);
  lane.append(buildMemberCard(member, index, assigned, payload, openThread, userAction));
  const column = dom("div", undefined, `margin-top:9px;flex:1;min-height:0;display:flex;flex-direction:column;border-radius:12px;border:1px solid color-mix(in srgb,${color} 30%,transparent);background:color-mix(in srgb,${color} 7%,transparent)`);
  const columnHead = dom("div", undefined, "display:flex;align-items:flex-start;gap:6px;padding:8px 10px 5px");
  const role = labeledDom("span", member.role, "font-size:9.5px;font-weight:650;line-height:1.35;min-width:0;opacity:.78");
  role.className = "harness-mix-team-clamp2";
  role.title = member.role;
  columnHead.append(
    dom("span", undefined, `width:7px;height:7px;border-radius:2.5px;background:${color};flex:none;margin-top:3px`),
    role,
    labeledDom("span", `${done}/${assigned.length}`, `margin-left:auto;font-size:8.5px;font-weight:750;color:${color};background:color-mix(in srgb,${color} 15%,transparent);padding:1px 6px;border-radius:99px;white-space:nowrap`),
  );
  column.append(columnHead);
  const list = dom("div", "harness-mix-team-task-list");
  for (const task of assigned) list.append(buildTaskCard(task, payload, userAction));
  if (!assigned.length) list.append(labeledDom("div", "等待主导者分配任务", "font-size:9px;opacity:.42;padding:10px 2px;text-align:center"));
  column.append(list);
  lane.append(column);
  return lane;
}

function buildFeedPanel(payload: TeamCardPayload, lead: TeamMemberPayload, snapshots: TeamSnapshotList) {
  const feed = dom("aside", "harness-mix-team-feed");
  // 团队动态 = 成员消息 + 历史事件快照（分配/开始/就绪/结算…）按时间倒序合并；
  // message_sent 事件由消息条目本身呈现，不再重复计一次。
  const events = snapshots.filter((snapshot) => snapshot.action !== "message_sent");
  const entries = [
    ...payload.messages.map((message) => ({ at: message.at || 0, kind: "message" as const, message })),
    ...events.map((snapshot) => ({ at: snapshot.at || 0, kind: "event" as const, snapshot })),
  ].sort((a, b) => b.at - a.at);
  const feedHead = dom("div", undefined, "display:flex;align-items:center;gap:6px;padding:11px 12px 8px;flex:none");
  feedHead.append(
    labeledDom("span", "团队动态", "font-size:10px;font-weight:720;letter-spacing:.06em;opacity:.55"),
    labeledDom("span", String(entries.length), "font-size:8.5px;font-weight:700;opacity:.6;background:color-mix(in srgb,currentColor 8%,transparent);border-radius:99px;padding:1px 7px"),
  );
  const feedList = dom("div", "harness-mix-team-feed-list");
  for (const entry of entries) {
    if (entry.kind === "event") {
      const item = dom("article", undefined, "display:flex;align-items:center;gap:6px;padding:7px 0;border-top:1px solid color-mix(in srgb,currentColor 7%,transparent)");
      item.append(
        labeledDom("span", actionIcon(entry.snapshot.action), "font-size:11px;flex:none"),
        labeledDom("span", actionLabel(entry.snapshot.action), "font-size:10px;font-weight:650;opacity:.7;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
      );
      if (entry.snapshot.at > 0) item.append(labeledDom("span", new Date(entry.snapshot.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "font-size:8.5px;opacity:.4;flex:none"));
      feedList.append(item);
      continue;
    }
    const message = entry.message;
    const item = dom("article", undefined, "padding:9px 0;border-top:1px solid color-mix(in srgb,currentColor 7%,transparent)");
    const sender = message.from === "lead" ? lead : payload.members.find((member) => member.id === message.from);
    const receiver = message.to === "lead" ? lead : payload.members.find((member) => member.id === message.to);
    const route = dom("div", undefined, "display:flex;align-items:center;gap:5px;min-width:0;font-size:10.5px;font-weight:700");
    if (sender) route.append(collaborationIcon(sender.agent, sender.name, 16));
    route.append(
      labeledDom("span", message.fromName ?? sender?.name ?? message.from, "opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
      labeledDom("span", "→", "opacity:.4;font-weight:400"),
    );
    if (receiver) route.append(collaborationIcon(receiver.agent, receiver.name, 16));
    route.append(labeledDom("span", message.to === "*" ? "全体" : receiver?.name ?? message.to, "opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"));
    if (message.at > 0) route.append(labeledDom("span", new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "margin-left:auto;font-size:8.5px;font-weight:400;opacity:.4;flex:none"));
    item.append(route, labeledDom("div", message.body, "font-size:11px;line-height:1.5;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;opacity:.88"));
    feedList.append(item);
  }
  if (!entries.length) feedList.append(labeledDom("div", "成员交接、审查请求和结果会实时显示在这里。", "font-size:10px;line-height:1.5;opacity:.45;padding:10px 0"));
  feed.append(feedHead, feedList);
  return feed;
}

type TeamSnapshotList = TeamHistoryEntry[];

function renderBoard(payload: TeamCardPayload, openThread?: TeamCardOptions["openThread"], snapshots: TeamSnapshotList = [], userAction?: TeamUserAction) {
  const board = dom("main", "harness-mix-team-board harness-mix-team-body", "height:100%;min-height:0;color:inherit");
  const lead = payload.lead ?? FALLBACK_LEAD;

  const left = dom("section", undefined, "display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0");
  const org = dom("div", "harness-mix-team-org", "display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 14px 0");
  org.append(buildLeadCard(lead, openThread), labeledDom("div", "任务拆解 · 进度协调 · 质量验收 · 最终交付", "font-size:8.5px;opacity:.45;letter-spacing:.04em"));
  const lanes = dom("div", "harness-mix-team-lanes harness-mix-team-scroll");
  if (payload.members.length) payload.members.forEach((member, index) => lanes.append(buildMemberLane(member, index, payload, openThread, userAction)));
  else lanes.append(labeledDom("div", "尚未添加团队成员。", "font-size:11px;opacity:.5"));
  left.append(org, lanes);

  board.append(left, buildFeedPanel(payload, lead, snapshots));
  return board;
}

/* ---------------------------------------------------------------------------
 * Collapsed summary panel
 * ------------------------------------------------------------------------- */

function renderSummary(payload: TeamCardPayload, open: () => void, openThread?: TeamCardOptions["openThread"], userAction?: TeamUserAction) {
  const panel = dom("section", "harness-mix-team-panel", "box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 90%,transparent);box-shadow:0 8px 28px color-mix(in srgb,#000 7%,transparent);backdrop-filter:blur(18px);color:inherit;font:13px/1.4 system-ui,-apple-system,\"Segoe UI\",sans-serif;padding:12px 14px;display:grid;gap:10px;min-width:0");
  panel.dataset.teamId = payload.team_id;
  panel.dataset.teamStatus = payload.status;
  const top = dom("div", undefined, "display:flex;align-items:center;gap:12px;min-width:0");
  const identity = dom("div", undefined, "display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:10px;min-width:0;flex:1");
  const lead = payload.lead ?? FALLBACK_LEAD;
  const leadIcon = dom("span", undefined, "position:relative;display:grid;place-items:center;width:38px;height:38px;flex:none;border:2px solid color-mix(in srgb,#c35b24 40%,transparent);border-radius:11px;background:Canvas");
  leadIcon.append(collaborationIcon(lead.agent, lead.name, 28), labeledDom("span", "👑", "position:absolute;top:-11px;right:-9px;font-size:11px"));
  const copy = dom("span", undefined, "display:grid;min-width:0;gap:1px");
  const eyebrowText = `AGENT TEAM · ${stateLabel(payload.status)}${payload.driver?.status === "running" ? ` · 编排${payload.driver.phase ? `：${payload.driver.phase}` : ""}` : payload.driver?.status === "interrupted" ? " · 编排已中断" : ""}`;
  const eyebrow = labeledDom("span", eyebrowText, `font-size:9px;font-weight:760;letter-spacing:.11em;color:${stateColor(payload.status)}`);
  const title = labeledDom("strong", payload.name, "font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
  title.className = "harness-mix-team-name";
  const goal = labeledDom("span", payload.goal, "font-size:10px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
  goal.title = payload.goal;
  copy.append(eyebrow, title, goal);
  identity.append(leadIcon, copy);
  const button = dom("button", "harness-mix-team-open", "border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:8px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:650 11px system-ui;padding:7px 10px;cursor:pointer;white-space:nowrap");
  button.type = "button";
  button.textContent = "展开详情";
  button.addEventListener("click", open);
  top.append(identity, summaryMetrics(payload), button);
  if (userAction && payload.lead_thread_id && payload.tasks.some((task) => ["interrupted", "pending"].includes(task.status))) top.append(continueButton(payload, userAction));

  const members = dom("div", "harness-mix-team-summary-members harness-mix-team-scroll", "display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding-bottom:1px");
  payload.members.forEach((member, index) => {
    const color = memberColor(index);
    const chip = dom("span", undefined, "display:grid;grid-template-columns:26px minmax(0,1fr);align-items:center;gap:7px;min-width:128px;max-width:190px;padding:5px 9px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 8%,transparent);background:color-mix(in srgb,currentColor 3%,transparent)");
    chip.title = `${member.name} · ${member.role}`;
    chip.dataset.status = member.display_status ?? "";
    chip.style.setProperty("--lane-color", color);
    wireOpenThread(chip, member.childId ?? member.child_thread_id, member.name, openThread);
    if (chip.classList.contains("harness-mix-team-clickable")) chip.title = `${member.name} · ${member.role} · 点击打开原生会话`;
    const icon = dom("span", "harness-mix-team-avatar", `position:relative;display:grid;place-items:center;width:26px;height:26px;flex:none;border-radius:8px;border:1.5px solid ${color};background:Canvas`);
    icon.dataset.status = member.display_status ?? "";
    const dot = dom("span", "harness-mix-team-status-dot", `position:absolute;right:-3px;bottom:-3px;width:8px;height:8px;box-sizing:border-box;border-radius:50%;background:${stateColor(member.display_status)};border:2px solid Canvas`);
    dot.dataset.status = member.display_status ?? "";
    icon.append(collaborationIcon(member.agent, member.name, 18), dot);
    const label = dom("span", undefined, "display:grid;min-width:0;line-height:1.2");
    label.append(
      labeledDom("strong", member.name, "font-size:10px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
      labeledDom("span", member.role, "font-size:8.5px;opacity:.52;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
      labeledDom("span", stateLabel(member.display_status), `font-size:8.5px;color:${stateColor(member.display_status)}`),
    );
    if (member.unread) label.append(labeledDom("span", `💬 ${member.unread} 条未读`, "font-size:8.5px;font-weight:700;color:#2878e3"));
    chip.append(icon, label);
    members.append(chip);
  });
  const completed = payload.tasks.filter((task) => task.status === "completed").length;
  const progress = dom("progress");
  progress.max = Math.max(1, payload.tasks.length);
  progress.value = completed;
  progress.style.cssText = "width:72px;height:5px;accent-color:#1f9d68;margin-left:auto;flex:none";
  progress.title = `${completed}/${payload.tasks.length} 个任务完成`;
  members.append(progress, labeledDom("span", `${completed}/${payload.tasks.length}`, "font-size:9px;font-weight:700;opacity:.52;white-space:nowrap"));
  panel.append(top, members);
  return panel;
}

/* ---------------------------------------------------------------------------
 * Installer
 * ------------------------------------------------------------------------- */

const SCAN_SELECTOR = '[data-testid*="tool"], [data-turn-key], [data-local-conversation-item-target-ids], pre[data-testid*="tool"]';
const DISPLAY_SENTINEL = "__empty__";
const REFRESH_INTERVAL_MS = 1500;
const PLAYBACK_STEP_MS = 800;

export function installTeamCards(options: TeamCardOptions = {}) {
  if (typeof document === "undefined") return { scan: () => {}, dispose: () => {} };
  const style = dom("style");
  style.dataset.harnessMixTeamStyle = "true";
  style.textContent = TEAM_STYLE;
  (document.head || document.documentElement).append(style);

  let disposed = false;
  let workbench: HTMLElement | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let playTimer: ReturnType<typeof setInterval> | null = null;
  let activeTimer: ReturnType<typeof setInterval> | null = null;
  let activePanel: HTMLElement | null = null;
  let activeSignature = "";
  let activeThreadId = "";
  let activeRefreshPending = false;
  const panelSignatures = new WeakMap<Element, string>();

  const closeWorkbench = () => {
    workbench?.remove();
    workbench = null;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
  };

  const openWorkbench = (seed: TeamCardPayload) => {
    if (workbench?.dataset.teamId === seed.team_id) {
      closeWorkbench();
      return;
    }
    closeWorkbench();
    const source = [...document.querySelectorAll<HTMLElement>(".harness-mix-team-panel")].find((node) => node.dataset.teamId === seed.team_id);
    if (!source?.parentElement) return;
    workbench = dom("section", "harness-mix-team-workbench", "box-sizing:border-box;margin:8px 0 12px;border:1px solid color-mix(in srgb,currentColor 11%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 94%,transparent);box-shadow:0 12px 34px color-mix(in srgb,#000 8%,transparent);backdrop-filter:blur(20px);color:inherit;font:13px/1.4 system-ui,-apple-system,\"Segoe UI\",sans-serif;display:grid;grid-template-rows:auto minmax(0,1fr);height:clamp(340px,64vh,660px);min-height:300px;overflow:hidden");
    workbench.dataset.teamId = seed.team_id;
    workbench.dataset.teamSource = source.dataset.teamSource ?? "tool";

    let current = seed;
    let snapshots: TeamSnapshotList = [];
    let index = -1;

    const header = dom("header", undefined, "display:flex;align-items:center;gap:14px;flex-wrap:wrap;row-gap:8px;min-height:56px;padding:8px 14px;border-bottom:1px solid color-mix(in srgb,currentColor 9%,transparent);background:color-mix(in srgb,currentColor 2%,transparent)");
    const title = dom("div", undefined, "display:grid;gap:1px;min-width:150px;max-width:min(320px,30vw)");
    const nameRow = dom("div", undefined, "display:flex;align-items:center;gap:7px;min-width:0");
    const teamName = labeledDom("strong", current.name, "font-size:13px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
    teamName.className = "harness-mix-team-name";
    const teamPill = statusPill(current.status);
    nameRow.append(teamName, teamPill);
    const subtitle = labeledDom("div", current.goal, "font-size:9px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
    subtitle.title = current.goal;
    title.append(nameRow, subtitle);

    const statsWrap = dom("div", undefined, "display:flex;align-items:center;gap:15px;flex-wrap:wrap");
    // 编排脚本状态条：有 driver 时展示「编排状态 · 当前阶段 · 脚本任务进度」，
    // 失败染红并经 title 透出结构化错误；纯 Host 投影，无需模型汇报。
    const driverStrip = dom("div", "harness-mix-team-driver", "display:none;align-items:center;gap:8px;flex:none;padding:5px 10px;border-radius:9px;border:1px solid color-mix(in srgb,#2878e3 34%,transparent);background:color-mix(in srgb,#2878e3 7%,transparent);font-size:10px;font-weight:650;max-width:280px");
    const driverState = labeledDom("span", "", "font-weight:760;white-space:nowrap");
    const driverPhase = labeledDom("span", "", "opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
    const driverSteps = labeledDom("span", "", "opacity:.6;white-space:nowrap");
    driverStrip.append(driverState, driverPhase, driverSteps);

    const progressWrap = dom("div", undefined, "display:flex;align-items:center;gap:7px;flex:none");
    progressWrap.append(labeledDom("span", "整体进度", "font-size:9px;opacity:.55;white-space:nowrap"));
    const progressBar = dom("progress");
    progressBar.style.cssText = "width:92px;height:5px;accent-color:#1f9d68";
    const progressPct = labeledDom("strong", "0%", "font-size:11px;font-weight:750;color:#1f9d68;min-width:30px");
    progressWrap.append(progressBar, progressPct);

    const timeline = dom("div", "harness-mix-team-timeline", "display:flex;align-items:center;gap:6px;margin-left:auto;min-width:0");
    const event = labeledDom("span", "实时状态", "font-size:9px;opacity:.55;min-width:60px;text-align:right");
    const range = dom("input");
    range.type = "range";
    range.min = "0";
    range.max = "0";
    range.value = "0";
    range.style.cssText = "width:min(120px,16vw);accent-color:#2878e3";
    const live = dom("button", undefined, "border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:transparent;color:inherit;font:600 10px system-ui;padding:5px 7px;cursor:pointer");
    live.type = "button";
    live.textContent = "实时";
    const play = dom("button", undefined, "border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:color-mix(in srgb,currentColor 6%,transparent);color:inherit;font:600 10px system-ui;padding:5px 8px;cursor:pointer");
    play.type = "button";
    play.textContent = "回放";
    const collapse = dom("button", "harness-mix-team-back", "border:0;background:transparent;color:inherit;font:650 10px system-ui;cursor:pointer;padding:6px 7px;opacity:.68");
    collapse.type = "button";
    collapse.textContent = "收起详情";
    collapse.addEventListener("click", closeWorkbench);
    timeline.append(event, range, live, play, collapse);

    // 操作按钮位随状态刷新；新增任务表单独立存在，轮询刷新不能清掉用户输入。
    const headerActions = dom("div", undefined, "display:flex;align-items:center;gap:6px;flex:none");
    const insertForm = dom("form", "harness-mix-team-insert-form", "display:none;width:100%;gap:7px;align-items:center;flex-wrap:wrap");
    const taskTitle = dom("input");
    taskTitle.placeholder = "任务标题";
    taskTitle.required = true;
    taskTitle.maxLength = 160;
    taskTitle.style.cssText = "flex:1;min-width:130px;padding:6px";
    const taskDescription = dom("input");
    taskDescription.placeholder = "任务描述";
    taskDescription.required = true;
    taskDescription.style.cssText = "flex:2;min-width:180px;padding:6px";
    const assignee = dom("select");
    assignee.title = "执行成员";
    assignee.style.cssText = "padding:6px;max-width:150px";
    const dependency = dom("select");
    dependency.multiple = true;
    dependency.title = "依赖任务（可多选）";
    dependency.size = 2;
    dependency.style.cssText = "max-width:180px";
    const saveTask = dom("button");
    saveTask.type = "submit";
    saveTask.textContent = "添加到任务图";
    const insertStatus = labeledDom("span", "", "font-size:10px;color:#d14343");
    const fillInsertOptions = () => {
      assignee.replaceChildren(...current.members.map((member) => {
        const option = dom("option");
        option.value = member.id;
        option.textContent = `${member.name} · ${member.agent}`;
        return option;
      }));
      dependency.replaceChildren(...current.tasks.map((task) => {
        const option = dom("option");
        option.value = task.id;
        option.textContent = task.title;
        return option;
      }));
    };
    insertForm.append(taskTitle, taskDescription, assignee, dependency, saveTask, insertStatus);
    insertForm.addEventListener("submit", async (formEvent) => {
      formEvent.preventDefault();
      if (!options.userAction || !current.lead_thread_id) return;
      saveTask.disabled = true;
      insertStatus.textContent = "";
      try {
        await options.userAction({ action: "task/insert", threadId: current.lead_thread_id, teamId: current.team_id, title: taskTitle.value.trim(), description: taskDescription.value.trim(), memberId: assignee.value, dependsOn: [...dependency.selectedOptions].map((option) => option.value) });
        insertForm.style.display = "none";
        insertForm.reset();
      } catch (error) {
        insertStatus.textContent = (error as Error)?.message ?? String(error);
      } finally {
        saveTask.disabled = false;
      }
    });

    header.append(title, driverStrip, statsWrap, progressWrap, timeline, headerActions, insertForm);
    const content = dom("div", undefined, "min-height:0");
    workbench.append(header, content);
    source.after(workbench);

    let renderedSignature = "";
    const render = () => {
      const snapshot = index >= 0 ? snapshots[index] : undefined;
      const visible = snapshot?.team ?? current;
      const feedSnapshots = index >= 0 ? snapshots.slice(0, index + 1) : snapshots;
      // 1.5s 轮询下内容没变就跳过重渲染：面板不闪、feed/列表滚动位置不丢。
      const signature = JSON.stringify([visible.updated_at, visible.status, visible.lead?.display_status, visible.members.map((member) => member.display_status), visible.tasks.map((task) => `${task.id}:${task.status}`), visible.messages.length, snapshots.length, index, visible.driver ? [visible.driver.status, visible.driver.phase ?? null, visible.driver.error ?? null, (visible.driver.tasks ?? []).map((task) => task.status).join(",")] : null]);
      if (signature === renderedSignature) return;
      renderedSignature = signature;
      content.replaceChildren(renderBoard(visible, async (threadId) => {
        closeWorkbench();
        await options.openThread?.(threadId);
      }, feedSnapshots, options.userAction));
      teamName.textContent = visible.name;
      subtitle.textContent = visible.goal;
      subtitle.title = visible.goal;
      teamPill.textContent = stateLabel(visible.status);
      teamPill.style.cssText = pillCss(visible.status);
      const driver = visible.driver;
      driverStrip.style.display = driver ? "flex" : "none";
      if (driver) {
        const color = stateColor(driver.status);
        driverState.textContent = `编排 ${stateLabel(driver.status)}`;
        driverPhase.textContent = driver.phase ? `阶段：${driver.phase}` : "阶段：未标记";
        const scriptTasks = driver.tasks ?? [];
        driverSteps.textContent = scriptTasks.length ? `脚本任务 ${scriptTasks.filter((task) => task.status === "completed").length}/${scriptTasks.length}` : "";
        driverStrip.style.borderColor = `color-mix(in srgb,${color} 40%,transparent)`;
        driverStrip.style.background = `color-mix(in srgb,${color} 8%,transparent)`;
        driverStrip.title = driver.status === "failed" && driver.error ? `脚本错误：${driver.error}` : `编排脚本 ${driver.script_id} · ${stateLabel(driver.status)}`;
      }
      statsWrap.replaceChildren(...headerStats(visible));
      const actions: HTMLElement[] = [];
      if (options.userAction && visible.lead_thread_id && index < 0) {
        if (visible.tasks.some((task) => ["interrupted", "pending"].includes(task.status))) actions.push(continueButton(visible, options.userAction));
        if (visible.lead?.display_status === "working" || visible.tasks.some((task) => task.status === "in_progress")) {
          const stop = boardActionButton("中断团队", "停止主导者与运行中的成员；之后可继续协作", () => {
            void runBoardAction(options.userAction!, stop, { action: "interrupt", threadId: visible.lead_thread_id!, teamId: visible.team_id });
          }, "#c17022");
          actions.push(stop);
        }
        const insert = boardActionButton("新增任务", "给现有团队任务图新增一项任务", () => {
          if (insertForm.style.display === "none") {
            fillInsertOptions();
            insertForm.style.display = "flex";
            taskTitle.focus();
          } else insertForm.style.display = "none";
        });
        actions.push(insert);
      }
      headerActions.replaceChildren(...actions);
      const completion = completionOf(visible);
      progressBar.max = Math.max(1, completion.total);
      progressBar.value = completion.done;
      progressPct.textContent = `${completion.pct}%`;
      range.max = String(Math.max(0, snapshots.length - 1));
      range.value = String(index >= 0 ? index : Math.max(0, snapshots.length - 1));
      event.textContent = snapshot ? `${actionLabel(snapshot.action)} · ${new Date(snapshot.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "● 实时状态";
    };

    range.addEventListener("input", () => {
      index = Number(range.value);
      render();
    });
    live.addEventListener("click", () => {
      index = -1;
      render();
    });
    play.addEventListener("click", () => {
      if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
        play.textContent = "回放";
        return;
      }
      index = index < 0 ? 0 : index;
      play.textContent = "暂停";
      render();
      playTimer = setInterval(() => {
        if (index >= snapshots.length - 1) {
          if (playTimer) clearInterval(playTimer);
          playTimer = null;
          index = -1;
          play.textContent = "回放";
        } else index++;
        render();
      }, PLAYBACK_STEP_MS);
    });
    const refresh = async () => {
      if (!options.inspectTeam || !seed.lead_thread_id || !workbench) return;
      try {
        const result = parseInspectionResult(await options.inspectTeam(seed.lead_thread_id, seed.team_id));
        if (!result || !workbench) return;
        current = result.team;
        snapshots = result.snapshots;
        render();
      } catch {}
    };
    render();
    void refresh();
    refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && workbench) closeWorkbench();
  };
  document.addEventListener("keydown", onKey);

  const scan = () => {
    if (disposed) return;
    for (const candidate of document.querySelectorAll<HTMLElement>(SCAN_SELECTOR)) {
      if (candidate.closest(".harness-mix-team-panel,.harness-mix-team-workbench")) continue;
      const payload = parseTeamPayload(candidate.textContent ?? "");
      if (!payload) continue;
      if ([...candidate.querySelectorAll<HTMLElement>(SCAN_SELECTOR)].some((child) => parseTeamPayload(child.textContent ?? ""))) continue;
      const signature = `${payload.updated_at ?? 0}:${payload.tasks.length}:${payload.messages.length}:${payload.members.map((member) => member.display_status).join(",")}`;
      if (panelSignatures.get(candidate) === signature) continue;
      const panel = renderSummary(payload, () => openWorkbench(payload), options.openThread, options.userAction);
      if (candidate.tagName === "PRE") {
        if (!candidate.dataset.harnessMixTeamDisplay) candidate.dataset.harnessMixTeamDisplay = candidate.style.display || DISPLAY_SENTINEL;
        candidate.style.display = "none";
        if (candidate.nextElementSibling?.classList.contains("harness-mix-team-panel")) candidate.nextElementSibling.remove();
        candidate.after(panel);
      } else {
        candidate.querySelector(":scope > .harness-mix-team-panel")?.remove();
        candidate.append(panel);
      }
      panelSignatures.set(candidate, signature);
    }
  };

  const removeActivePanel = () => {
    if (workbench?.dataset.teamSource === "active-thread") closeWorkbench();
    activePanel?.remove();
    activePanel = null;
    activeSignature = "";
    activeThreadId = "";
  };

  const refreshActiveTeam = async () => {
    if (disposed || activeRefreshPending || !options.inspectTeam || !options.activeThread) return;
    const context = options.activeThread();
    if (!context?.anchor.isConnected) {
      removeActivePanel();
      return;
    }
    activeRefreshPending = true;
    try {
      const result = parseInspectionResult(await options.inspectTeam(context.threadId));
      if (disposed) return;
      const latest = options.activeThread();
      if (!latest || latest.threadId !== context.threadId || !latest.anchor.isConnected) {
        removeActivePanel();
        return;
      }
      if (!result) {
        removeActivePanel();
        return;
      }
      const payload = result.team;
      const signature = `${context.threadId}:${payload.team_id}:${payload.updated_at ?? 0}:${payload.tasks.length}:${payload.messages.length}:${payload.lead?.display_status}:${payload.members.map((member) => member.display_status).join(",")}:${payload.tasks.map((task) => task.status).join(",")}`;
      const inlinePanel = [...document.querySelectorAll<HTMLElement>(".harness-mix-team-panel")]
        .find((node) => node !== activePanel && node.dataset.teamId === payload.team_id);
      if (inlinePanel) {
        removeActivePanel();
        return;
      }
      if (activePanel?.isConnected && activeSignature === signature && activeThreadId === context.threadId) return;
      const reopen = workbench?.dataset.teamId === payload.team_id && workbench.dataset.teamSource === "active-thread";
      removeActivePanel();
      activePanel = renderSummary(payload, () => openWorkbench(payload), options.openThread, options.userAction);
      activePanel.classList.add("harness-mix-team-launcher");
      activePanel.dataset.teamSource = "active-thread";
      activePanel.style.cssText += ";margin:8px 16px 0;flex:none;position:relative;z-index:11";
      const parent = latest.anchor.parentElement;
      if (!parent) {
        removeActivePanel();
        return;
      }
      parent.insertBefore(activePanel, latest.anchor);
      activeSignature = signature;
      activeThreadId = context.threadId;
      if (reopen) openWorkbench(payload);
    } catch {
      removeActivePanel();
    } finally {
      activeRefreshPending = false;
    }
  };

  const observer = new MutationObserver(scan);
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  scan();
  void refreshActiveTeam();
  activeTimer = setInterval(() => void refreshActiveTeam(), REFRESH_INTERVAL_MS);

  return {
    scan,
    close: closeWorkbench,
    dispose() {
      disposed = true;
      observer.disconnect();
      if (activeTimer) clearInterval(activeTimer);
      activeTimer = null;
      removeActivePanel();
      closeWorkbench();
      style.remove();
      document.removeEventListener("keydown", onKey);
      document.querySelectorAll(".harness-mix-team-panel").forEach((node) => node.remove());
      document.querySelectorAll<HTMLElement>("[data-harness-mix-team-display]").forEach((node) => {
        node.style.display = node.dataset.harnessMixTeamDisplay === DISPLAY_SENTINEL ? "" : node.dataset.harnessMixTeamDisplay ?? "";
        delete node.dataset.harnessMixTeamDisplay;
      });
    },
  };
}
