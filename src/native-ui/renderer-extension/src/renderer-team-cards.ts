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

function formatElapsed(fromMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

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

/** Animated progress bar (div-based so width transitions between renders). */
interface ProgressBarRefs { root: HTMLElement; fill: HTMLElement; set(done: number, total: number): void }
function progressBar(color: string, height = 5): ProgressBarRefs {
  const root = dom("div", "harness-mix-team-bar", `width:100%;height:${height}px`);
  root.style.setProperty("--bar-color", color);
  const fill = dom("i", undefined, "width:0%");
  root.append(fill);
  return {
    root, fill,
    set(done, total) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      root.title = `${done}/${total} 个任务完成`;
    },
  };
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
 * Per-member activity (derived from the task graph + event snapshots)
 * ------------------------------------------------------------------------- */

interface MemberActivity {
  /** Tasks currently in progress with the timestamp they started at. */
  active: Array<{ task: TeamTaskPayload; startedAt: number | undefined }>;
  /** Latest snapshot/action timestamp that touched this member. */
  lastEventAt: number | undefined;
  lastEventLabel: string | undefined;
}

const ACTIVE_TASK_STATUSES = new Set(["in_progress", "working", "running", "active"]);

function memberActivity(payload: TeamCardPayload, snapshots: TeamHistoryEntry[], memberId: string): MemberActivity {
  const startedAt = new Map<string, number>();
  const settledAt = new Map<string, number>();
  let prev = new Map(payload.tasks.map((task) => [task.id, task.status]));
  // Snapshots arrive ascending by time; replay transitions to locate when each
  // task entered/left the in-progress state so the card can show a live timer.
  for (const snapshot of [...snapshots].sort((a, b) => a.at - b.at)) {
    const next = new Map(snapshot.team.tasks.map((task) => [task.id, task.status]));
    for (const [taskId, status] of next) {
      const before = prev.get(taskId);
      if (before !== status) {
        if (ACTIVE_TASK_STATUSES.has(status)) startedAt.set(taskId, snapshot.at);
        else if (before !== undefined && ACTIVE_TASK_STATUSES.has(before)) settledAt.set(taskId, snapshot.at);
      }
    }
    prev = next;
  }
  const active = payload.tasks
    .filter((task) => task.assignee === memberId && ACTIVE_TASK_STATUSES.has(task.status))
    .map((task) => ({ task, startedAt: startedAt.get(task.id) }));
  let lastEventAt: number | undefined;
  let lastEventLabel: string | undefined;
  for (const snapshot of snapshots) {
    const touched = snapshot.team.tasks.some((task) => task.assignee === memberId) ||
      snapshot.team.messages.some((message) => message.from === memberId || message.to === memberId);
    if (touched) {
      lastEventAt = snapshot.at;
      lastEventLabel = actionLabel(snapshot.action);
    }
  }
  return { active, lastEventAt, lastEventLabel };
}

/* ---------------------------------------------------------------------------
 * Styles
 * ------------------------------------------------------------------------- */

const TEAM_STYLE = `
.harness-mix-team-scroll{scrollbar-width:none}
.harness-mix-team-scroll::-webkit-scrollbar{display:none}
.harness-mix-team-workbench{container-type:inline-size;animation:harness-mix-team-workbench-in .3s ease}
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
.harness-mix-team-feed{display:flex;flex-direction:column;min-height:0;min-width:0;position:relative;border-left:1px solid color-mix(in srgb,currentColor 9%,transparent)}
.harness-mix-team-feed-list{flex:1;min-height:0;overflow-y:auto;padding:0 12px 10px;scrollbar-width:thin}
.harness-mix-team-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.harness-mix-team-hidden{display:none}
.harness-mix-team-clickable{transition:border-color .15s ease,box-shadow .15s ease}
.harness-mix-team-clickable:hover{border-color:color-mix(in srgb,currentColor 28%,transparent)!important;box-shadow:0 4px 14px color-mix(in srgb,#000 10%,transparent)!important}
.harness-mix-team-open-failed{border-color:#d14343!important;box-shadow:0 0 0 3px color-mix(in srgb,#d14343 25%,transparent)!important}
.harness-mix-team-member[data-status="working"],.harness-mix-team-lead[data-status="working"]{border-color:color-mix(in srgb,var(--lane-color,#2878e3) 38%,transparent)!important;box-shadow:0 0 12px color-mix(in srgb,var(--lane-color,#2878e3) 18%,transparent)}
.harness-mix-team-avatar[data-status="working"]{animation:harness-mix-team-breathe 2s ease-in-out infinite}
.harness-mix-team-status-dot[data-status="working"]{animation:harness-mix-team-pulse 1.6s ease-in-out infinite}
/* --- keyed-render transitions ------------------------------------------------ */
.harness-mix-team-task,.harness-mix-team-member{transition:border-color .25s ease,background-color .25s ease,box-shadow .25s ease}
.harness-mix-team-task[data-task-status]{transition:border-color .25s ease,background-color .25s ease,box-shadow .25s ease}
.harness-mix-team-task[data-flash="ok"]{animation:harness-mix-team-flash-ok .9s ease}
.harness-mix-team-task[data-flash="fail"]{animation:harness-mix-team-flash-fail .9s ease}
.harness-mix-team-task[data-task-status="in_progress"]{border-color:color-mix(in srgb,var(--lane-color,#2878e3) 36%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--lane-color,#2878e3) 14%,transparent)}
.harness-mix-team-bar{border-radius:99px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden;box-sizing:border-box}
.harness-mix-team-bar>i{display:block;height:100%;border-radius:99px;background:var(--bar-color,#1f9d68);transition:width .45s cubic-bezier(.22,.61,.36,1)}
.harness-mix-team-feed-enter{animation:harness-mix-team-feed-enter .35s ease}
.harness-mix-team-feed-chips{display:flex;align-items:center;gap:5px;padding:0 12px 7px;flex-wrap:wrap}
.harness-mix-team-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:99px;background:transparent;color:inherit;font:600 9px system-ui;padding:2px 8px;cursor:pointer;white-space:nowrap;transition:border-color .15s ease,background-color .15s ease}
.harness-mix-team-chip>i{width:6px;height:6px;border-radius:50%;flex:none}
.harness-mix-team-chip[aria-pressed="true"]{border-color:color-mix(in srgb,currentColor 34%,transparent);background:color-mix(in srgb,currentColor 8%,transparent);font-weight:750}
/* --- member drawer ----------------------------------------------------------- */
.harness-mix-team-drawer{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:color-mix(in srgb,Canvas 96%,transparent);backdrop-filter:blur(14px);animation:harness-mix-team-drawer-in .28s cubic-bezier(.22,.61,.36,1)}
.harness-mix-team-drawer-head{display:flex;align-items:center;gap:8px;padding:11px 12px 8px;flex:none}
.harness-mix-team-drawer-body{flex:1;min-height:0;overflow-y:auto;padding:0 12px 12px;scrollbar-width:thin}
.harness-mix-team-drawer-section{font-size:9px;font-weight:720;letter-spacing:.06em;opacity:.55;margin:12px 0 4px}
.harness-mix-team-drawer .harness-mix-team-task{margin-bottom:6px}
@keyframes harness-mix-team-flow-y{to{background-position:0 7px}}
@keyframes harness-mix-team-flow-x{to{background-position:7px 0}}
@keyframes harness-mix-team-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--lane-color,#2878e3) 40%,transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--lane-color,#2878e3) 0%,transparent)}}
@keyframes harness-mix-team-breathe{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--lane-color,#2878e3) 28%,transparent)}50%{box-shadow:0 0 10px 2px color-mix(in srgb,var(--lane-color,#2878e3) 38%,transparent)}}
@keyframes harness-mix-team-flash-ok{0%{box-shadow:0 0 0 3px color-mix(in srgb,#1f9d68 40%,transparent);border-color:#1f9d68}100%{box-shadow:0 0 0 3px transparent}}
@keyframes harness-mix-team-flash-fail{0%{box-shadow:0 0 0 3px color-mix(in srgb,#d14343 40%,transparent);border-color:#d14343}100%{box-shadow:0 0 0 3px transparent}}
@keyframes harness-mix-team-feed-enter{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes harness-mix-team-workbench-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes harness-mix-team-drawer-in{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  .harness-mix-team-workbench,.harness-mix-team-drawer,.harness-mix-team-feed-enter,.harness-mix-team-avatar,.harness-mix-team-status-dot,.harness-mix-team-lane::before,.harness-mix-team-lane::after,.harness-mix-team-task[data-flash]{animation:none!important}
  .harness-mix-team-bar>i,.harness-mix-team-task,.harness-mix-team-member,.harness-mix-team-chip,.harness-mix-team-clickable{transition:none!important}
}
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

/* ---------------------------------------------------------------------------
 * Detail board (expanded workbench body) — created once, updated in place
 * ------------------------------------------------------------------------- */

interface TaskCardRefs {
  root: HTMLElement;
  title: HTMLElement;
  pill: HTMLElement;
  controls: HTMLElement;
  status: string;
}

interface MemberLaneRefs {
  lane: HTMLElement;
  card: HTMLElement;
  cardStatus: HTMLElement;
  cardDot: HTMLElement;
  cardCornerDot: HTMLElement;
  doneLabel: HTMLElement;
  progress: ProgressBarRefs;
  currentTask: HTMLElement;
  elapsed: HTMLElement;
  unread: HTMLElement;
  taskList: HTMLElement;
  taskRefs: Map<string, TaskCardRefs>;
  taskOrder: string;
  status: string;
}

interface FeedEntryRefs { node: HTMLElement; related: Set<string>; kind: "message" | "event" }

interface BoardRefs {
  root: HTMLElement;
  orgEl: HTMLElement;
  orgSignature: string;
  lanesEl: HTMLElement;
  lanes: Map<string, MemberLaneRefs>;
  memberOrder: string;
  feedChips: HTMLElement;
  feedList: HTMLElement;
  feedCount: HTMLElement;
  feedEntries: Map<string, FeedEntryRefs>;
  feedOrderKey: string;
  feedPlaceholder: HTMLElement | null;
  drawerHost: HTMLElement;
  drawerSignature: string;
}

function createBoard(): BoardRefs {
  const board = dom("main", "harness-mix-team-board harness-mix-team-body", "height:100%;min-height:0;color:inherit");
  const left = dom("section", undefined, "display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0");
  const orgEl = dom("div", "harness-mix-team-org", "display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 14px 0");
  const lanesEl = dom("div", "harness-mix-team-lanes harness-mix-team-scroll");
  left.append(orgEl, lanesEl);
  const feed = dom("aside", "harness-mix-team-feed");
  const feedChips = dom("div", "harness-mix-team-feed-chips");
  const feedHead = dom("div", undefined, "display:flex;align-items:center;gap:6px;padding:11px 12px 7px;flex:none");
  feedHead.append(
    labeledDom("span", "团队动态", "font-size:10px;font-weight:720;letter-spacing:.06em;opacity:.55"),
    labeledDom("span", "0", "font-size:8.5px;font-weight:700;opacity:.6;background:color-mix(in srgb,currentColor 8%,transparent);border-radius:99px;padding:1px 7px"),
  );
  const feedCount = feedHead.lastElementChild as HTMLElement;
  const feedList = dom("div", "harness-mix-team-feed-list");
  const drawerHost = dom("div", undefined, "position:absolute;inset:0;display:none");
  feed.append(feedChips, feedHead, feedList, drawerHost);
  board.append(left, feed);
  return { root: board, orgEl, orgSignature: "", lanesEl, lanes: new Map(), memberOrder: "", feedChips, feedList, feedCount, feedEntries: new Map(), feedOrderKey: "", feedPlaceholder: null, drawerHost, drawerSignature: "" };
}

// 用 div 而不是 button：卡片内嵌「追问」按钮，按钮不能嵌套按钮。
function buildMemberCard(
  member: TeamMemberPayload,
  index: number,
  assigned: TeamTaskPayload[],
  payload: TeamCardPayload,
  openThread?: TeamCardOptions["openThread"],
  userAction?: TeamUserAction,
  onOpenDrawer?: () => void,
): { card: HTMLElement; statusLabel: HTMLElement; cornerDot: HTMLElement; doneLabel: HTMLElement; progress: ProgressBarRefs; currentTask: HTMLElement; elapsed: HTMLElement; unread: HTMLElement } {
  const color = memberColor(index);
  const done = assigned.filter((task) => task.status === "completed").length;
  const card = dom("div", "harness-mix-team-member", "position:relative;width:100%;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,Canvas 92%,transparent);box-shadow:0 2px 8px color-mix(in srgb,#000 6%,transparent);color:inherit;font:inherit;display:grid;grid-template-columns:40px minmax(0,1fr);align-items:center;gap:9px;padding:9px 10px;border-radius:12px;text-align:left;cursor:pointer");
  card.dataset.agent = member.agent;
  card.dataset.status = member.display_status ?? "";
  card.style.setProperty("--lane-color", color);
  card.title = "点击查看该成员的任务、事件与消息";
  card.addEventListener("click", (event) => {
    if (card.classList.contains("harness-mix-team-open-failed")) return;
    event.stopPropagation();
    onOpenDrawer?.();
  });
  const avatar = dom("span", "harness-mix-team-avatar", `position:relative;display:grid;place-items:center;width:40px;height:40px;flex:none;border-radius:11px;border:2px solid ${color};background:Canvas`);
  avatar.dataset.status = member.display_status ?? "";
  const cornerDot = dom("span", "harness-mix-team-status-dot", `position:absolute;right:-4px;bottom:-4px;width:11px;height:11px;box-sizing:border-box;border-radius:50%;background:${stateColor(member.display_status)};border:2.5px solid Canvas`);
  cornerDot.dataset.status = member.display_status ?? "";
  avatar.append(collaborationIcon(member.agent, member.name, 30), cornerDot);
  const copy = dom("span", undefined, "display:grid;min-width:0;line-height:1.25;gap:2px");
  copy.append(labeledDom("strong", member.name, "font-size:12px;font-weight:680;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"));
  const status = dom("span", undefined, "display:flex;align-items:center;gap:5px;min-width:0");
  const statusLabel = labeledDom("span", stateLabel(member.display_status), `font-size:9px;color:${stateColor(member.display_status)};white-space:nowrap`);
  const doneLabel = labeledDom("span", `${done}/${assigned.length}`, "font-size:9px;font-weight:650;opacity:.5;margin-left:auto");
  const unread = dom("span", undefined, "display:inline-flex;gap:4px;margin-left:auto");
  status.append(statusLabel, doneLabel, unread);
  copy.append(status);
  // 当前执行中的任务 + 已耗时（无任务时整行隐藏）
  const currentTask = dom("span", undefined, "display:none;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px;min-width:0");
  const currentTitle = labeledDom("span", "", "font-size:9px;opacity:.66;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
  const elapsed = dom("span", "harness-mix-team-elapsed", `font-size:8.5px;font-weight:700;color:${color};white-space:nowrap`);
  currentTask.append(currentTitle, elapsed);
  copy.append(currentTask);
  const progress = progressBar(color, 4);
  copy.append(progress.root);
  card.append(avatar, copy);
  // 右上角操作区：打开原生会话（↗）始终保留；「追问」需要 userAction。
  const askRow = dom("span", undefined, "position:absolute;top:5px;right:6px;display:flex;align-items:center;gap:4px;max-width:72%");
  askRow.addEventListener("click", (event) => event.stopPropagation());
  const childId = member.childId ?? member.child_thread_id;
  if (childId && openThread) {
    askRow.append(boardActionButton("↗", `打开 ${member.name} 的原生 Harness 会话`, () => {
      void openThread(childId);
    }));
  }
  if (userAction && payload.lead_thread_id) {
    askRow.append(boardActionButton("追问", `以主导者身份向 ${member.name} 发送团队消息`, () => {
      const input = dom("input", undefined, "font:600 10px system-ui;padding:3px 6px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);color:inherit;background:Canvas;min-width:96px;flex:1");
      input.placeholder = `向 ${member.name} 说…`;
      const send = boardActionButton("发送", "发送团队消息", () => {
        const message = input.value.trim();
        if (message) void runBoardAction(userAction, send, { action: "message/send", threadId: payload.lead_thread_id!, teamId: payload.team_id, to: member.id, message });
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") send.click();
      });
      askRow.replaceChildren(input, send, boardActionButton("×", "取消", () => askRow.replaceChildren(...askButtons)));
      input.focus();
    }));
  }
  const askButtons = [...askRow.children] as HTMLElement[];
  card.append(askRow);
  return { card, statusLabel, cornerDot, doneLabel, progress, currentTask, elapsed, unread };
}

function buildTaskCard(task: TeamTaskPayload, payload: TeamCardPayload, userAction?: TeamUserAction): TaskCardRefs {
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
  const controls = dom("div", undefined, "display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0");
  renderTaskControls(controls, task, payload, userAction);
  if (controls.childElementCount) card.append(controls);
  return { root: card, title, pill, controls, status: task.status };
}

function renderTaskControls(controls: HTMLElement, task: TeamTaskPayload, payload: TeamCardPayload, userAction?: TeamUserAction) {
  controls.replaceChildren();
  if (!userAction || !payload.lead_thread_id) return;
  const assignee = payload.members.find((member) => member.id === task.assignee);
  if (task.status === "in_progress") {
    controls.append(boardActionButton("取消", "取消该任务并停止成员会话", () => {
      if (window.confirm(`取消任务「${task.title}」？运行中的成员会话将被停止。`)) void runBoardAction(userAction, controls, { action: "task/cancel", threadId: payload.lead_thread_id!, teamId: payload.team_id, taskId: task.id });
    }, "#d14343"));
  } else if (task.status === "failed" || task.status === "interrupted") {
    controls.append(
      boardActionButton(task.status === "failed" ? "重试" : "恢复", `把任务重新派给 ${assignee?.name ?? "原成员"}`, () => {
        void runBoardAction(userAction, controls, { action: "task/reassign", threadId: payload.lead_thread_id!, teamId: payload.team_id, taskId: task.id, memberId: task.assignee });
      }, "#c17022"),
      boardActionButton("改派", "改派给其他成员", () => {
        const select = dom("select", undefined, "font:600 9px system-ui;padding:3px 4px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);color:inherit;background:Canvas;max-width:120px;min-width:0");
        select.append(new Option("改派给…", ""));
        for (const candidate of payload.members) if (candidate.id !== task.assignee) select.append(new Option(candidate.name, candidate.id));
        const go = boardActionButton("确定", "执行改派", () => {
          if (select.value) void runBoardAction(userAction, controls, { action: "task/reassign", threadId: payload.lead_thread_id!, teamId: payload.team_id, taskId: task.id, memberId: select.value });
        });
        controls.replaceChildren(select, go, boardActionButton("×", "取消改派", () => renderTaskControls(controls, task, payload, userAction)));
      }),
    );
  }
}

function buildMemberLane(
  member: TeamMemberPayload,
  index: number,
  payload: TeamCardPayload,
  refs: { openThread?: TeamCardOptions["openThread"] | undefined; userAction?: TeamUserAction | undefined; onOpenDrawer: () => void },
): MemberLaneRefs {
  const color = memberColor(index);
  const assigned = payload.tasks.filter((task) => task.assignee === member.id);
  const done = assigned.filter((task) => task.status === "completed").length;
  const lane = dom("div", "harness-mix-team-lane");
  lane.dataset.memberId = member.id;
  lane.dataset.status = member.display_status ?? "";
  lane.style.setProperty("--lane-color", color);
  const cardRefs = buildMemberCard(member, index, assigned, payload, refs.openThread, refs.userAction, refs.onOpenDrawer);
  lane.append(cardRefs.card);
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
  const taskList = dom("div", "harness-mix-team-task-list");
  column.append(taskList);
  lane.append(column);
  return {
    lane,
    card: cardRefs.card,
    cardStatus: cardRefs.statusLabel,
    cardDot: cardRefs.cornerDot,
    cardCornerDot: cardRefs.cornerDot,
    doneLabel: cardRefs.doneLabel,
    progress: cardRefs.progress,
    currentTask: cardRefs.currentTask,
    elapsed: cardRefs.elapsed,
    unread: cardRefs.unread,
    taskList,
    taskRefs: new Map(),
    taskOrder: "",
    status: member.display_status ?? "",
  };
}

interface FeedEntry {
  key: string;
  at: number;
  kind: "message" | "event";
  related: Set<string>;
  message?: TeamMessagePayload;
  snapshot?: TeamHistoryEntry;
}

/** Merge member messages with snapshot events (newest first) and tag each
 * entry with the members it involves so the filter chips can hide the rest. */
function collectFeedEntries(payload: TeamCardPayload, lead: TeamMemberPayload, snapshots: TeamHistoryEntry[]): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const memberIds = new Set(payload.members.map((member) => member.id));
  for (const message of payload.messages) {
    const related = new Set<string>();
    if (memberIds.has(message.from)) related.add(message.from);
    if (message.to === "*") for (const id of memberIds) related.add(id);
    else if (memberIds.has(message.to)) related.add(message.to);
    const key = message.id ? `m:${message.id}` : `m:${message.from}>${message.to}:${message.at}:${message.body.length}`;
    entries.push({ key, at: message.at || 0, kind: "message", related, message });
  }
  const events = snapshots.filter((snapshot) => snapshot.action !== "message_sent");
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let prev = new Map<string, { status: string; assignee: string }>();
  for (let i = 0; i < sorted.length; i++) {
    const snapshot = sorted[i]!;
    const next = new Map(snapshot.team.tasks.map((task) => [task.id, { status: task.status, assignee: task.assignee }]));
    const related = new Set<string>();
    for (const [taskId, after] of next) {
      const before = prev.get(taskId);
      if (before && before.status !== after.status && memberIds.has(after.assignee)) related.add(after.assignee);
      if (before && before.assignee !== after.assignee) {
        if (memberIds.has(after.assignee)) related.add(after.assignee);
        if (memberIds.has(before.assignee)) related.add(before.assignee);
      }
    }
    prev = next;
    entries.push({ key: `e:${snapshot.id ?? `${snapshot.action}:${snapshot.at}:${i}`}`, at: snapshot.at || 0, kind: "event", related, snapshot });
  }
  void lead;
  return entries.sort((a, b) => b.at - a.at);
}

function buildFeedEntryNode(entry: FeedEntry, payload: TeamCardPayload, lead: TeamMemberPayload): HTMLElement {
  if (entry.kind === "event") {
    const snapshot = entry.snapshot!;
    const item = dom("article", undefined, "display:flex;align-items:center;gap:6px;padding:7px 0;border-top:1px solid color-mix(in srgb,currentColor 7%,transparent)");
    item.append(
      labeledDom("span", actionIcon(snapshot.action), "font-size:11px;flex:none"),
      labeledDom("span", actionLabel(snapshot.action), "font-size:10px;font-weight:650;opacity:.7;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
    );
    const taskHint = entry.related.size === 1
      ? payload.tasks.find((task) => task.assignee === [...entry.related][0] && (ACTIVE_TASK_STATUSES.has(task.status) || task.status === "completed"))
      : undefined;
    if (taskHint) item.append(labeledDom("span", taskHint.title.slice(0, 18), "font-size:8.5px;opacity:.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px"));
    if (snapshot.at > 0) item.append(labeledDom("span", new Date(snapshot.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "font-size:8.5px;opacity:.4;flex:none"));
    return item;
  }
  const message = entry.message!;
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
  return item;
}

/* --- member drawer --------------------------------------------------------- */

function buildDrawer(
  payload: TeamCardPayload,
  lead: TeamMemberPayload,
  snapshots: TeamHistoryEntry[],
  member: TeamMemberPayload,
  index: number,
  refs: { openThread?: TeamCardOptions["openThread"] | undefined; onClose: () => void },
): HTMLElement {
  const color = memberColor(index);
  const drawer = dom("div", "harness-mix-team-drawer");
  const head = dom("div", "harness-mix-team-drawer-head");
  const avatar = dom("span", "harness-mix-team-avatar", `position:relative;display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:10px;border:2px solid ${color};background:Canvas`);
  avatar.dataset.status = member.display_status ?? "";
  const corner = dom("span", "harness-mix-team-status-dot", `position:absolute;right:-3px;bottom:-3px;width:9px;height:9px;box-sizing:border-box;border-radius:50%;background:${stateColor(member.display_status)};border:2px solid Canvas`);
  corner.dataset.status = member.display_status ?? "";
  avatar.append(collaborationIcon(member.agent, member.name, 26), corner);
  const copy = dom("span", undefined, "display:grid;min-width:0;flex:1;line-height:1.3");
  copy.append(
    labeledDom("strong", member.name, "font-size:12px;font-weight:720;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
    labeledDom("span", `${member.role} · ${stateLabel(member.display_status)}`, `font-size:9px;color:${stateColor(member.display_status)};opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`),
  );
  const childId = member.childId ?? member.child_thread_id;
  if (childId && refs.openThread) {
    head.append(boardActionButton("↗ 会话", `打开 ${member.name} 的原生 Harness 会话`, () => {
      void refs.openThread!(childId);
    }, color));
  }
  const close = boardActionButton("×", "关闭成员详情", refs.onClose);
  close.style.fontSize = "12px";
  head.append(avatar, copy, close);
  const body = dom("div", "harness-mix-team-drawer-body");
  const assigned = payload.tasks.filter((task) => task.assignee === member.id);
  const activity = memberActivity(payload, snapshots, member.id);

  body.append(labeledDom("div", "进行中", "harness-mix-team-drawer-section"));
  if (activity.active.length) {
    for (const item of activity.active) {
      const row = dom("div", undefined, "display:flex;align-items:baseline;gap:6px;padding:5px 0;font-size:10.5px;line-height:1.4");
      const started = item.startedAt ? formatElapsed(item.startedAt) : "";
      row.append(
        labeledDom("span", item.task.title, "flex:1;min-width:0;opacity:.85;overflow-wrap:anywhere"),
        started ? labeledDom("span", `已进行 ${started}`, `font-size:9px;color:${color};white-space:nowrap`) : "",
      );
      body.append(row);
    }
  } else {
    body.append(labeledDom("div", "当前没有进行中的任务。", "font-size:10px;opacity:.45;padding:4px 0"));
  }

  body.append(labeledDom("div", `任务（${assigned.length}）`, "harness-mix-team-drawer-section"));
  if (assigned.length) {
    for (const task of assigned) body.append(buildTaskCard(task, payload).root);
  } else {
    body.append(labeledDom("div", "等待主导者分配任务", "font-size:10px;opacity:.45;padding:4px 0"));
  }

  const memberEvents = snapshots
    .filter((snapshot) => snapshot.team.tasks.some((task) => task.assignee === member.id) || snapshot.team.messages.some((message) => message.from === member.id || message.to === member.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  body.append(labeledDom("div", `最近事件（${memberEvents.length}）`, "harness-mix-team-drawer-section"));
  if (memberEvents.length) {
    for (const snapshot of memberEvents) {
      const row = dom("div", undefined, "display:flex;align-items:center;gap:6px;padding:4px 0;font-size:10px");
      row.append(
        labeledDom("span", actionIcon(snapshot.action), "flex:none"),
        labeledDom("span", actionLabel(snapshot.action), "opacity:.7;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
        labeledDom("span", new Date(snapshot.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "font-size:8.5px;opacity:.4;flex:none"),
      );
      body.append(row);
    }
  } else {
    body.append(labeledDom("div", "暂无事件记录。", "font-size:10px;opacity:.45;padding:4px 0"));
  }

  const memberMessages = payload.messages
    .filter((message) => message.from === member.id || message.to === member.id || message.to === "*")
    .sort((a, b) => b.at - a.at);
  body.append(labeledDom("div", `相关消息（${memberMessages.length}）`, "harness-mix-team-drawer-section"));
  if (memberMessages.length) {
    for (const message of memberMessages.slice(0, 30)) {
      const direction = message.from === member.id ? "发出" : "收到";
      const counterpart = message.from === member.id ? message.to : message.fromName ?? message.from;
      const row = dom("div", undefined, "padding:6px 0;border-top:1px solid color-mix(in srgb,currentColor 7%,transparent)");
      const meta = dom("div", undefined, "display:flex;align-items:center;gap:6px;font-size:9px;opacity:.6");
      meta.append(
        labeledDom("span", `${direction} · ${counterpart === "*" ? "全体" : counterpart === "lead" ? lead.name : counterpart}`, "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
        labeledDom("span", new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "flex:none"),
      );
      row.append(meta, labeledDom("div", message.body, "font-size:10.5px;line-height:1.5;margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere;opacity:.85"));
      body.append(row);
    }
  } else {
    body.append(labeledDom("div", "暂无相关消息。", "font-size:10px;opacity:.45;padding:4px 0"));
  }

  drawer.append(head, body);
  return drawer;
}

/* --- board create + in-place update ---------------------------------------- */

interface BoardUpdateOptions {
  payload: TeamCardPayload;
  snapshots: TeamHistoryEntry[];
  openThread?: TeamCardOptions["openThread"] | undefined;
  userAction?: TeamUserAction | undefined;
  feedFilter: string;
  selectedMemberId: string | null;
  onSelectMember: (memberId: string | null) => void;
}

function updateBoard(refs: BoardRefs, options: BoardUpdateOptions) {
  const { payload, snapshots } = options;
  const lead = payload.lead ?? FALLBACK_LEAD;

  // --- org header (lead card) ---
  const orgSignature = `${lead.name}:${lead.agent}:${lead.display_status ?? ""}`;
  if (refs.orgSignature !== orgSignature) {
    refs.orgSignature = orgSignature;
    refs.orgEl.replaceChildren(
      buildLeadCard(lead, options.openThread),
      labeledDom("div", "任务拆解 · 进度协调 · 质量验收 · 最终交付", "font-size:8.5px;opacity:.45;letter-spacing:.04em"),
    );
  }

  // --- lanes (rebuild only when the roster itself changes) ---
  const memberOrder = payload.members.map((member) => member.id).join(",");
  if (memberOrder !== refs.memberOrder) {
    refs.memberOrder = memberOrder;
    refs.lanes.clear();
    refs.lanesEl.replaceChildren();
    payload.members.forEach((member, index) => {
      const laneRefs = buildMemberLane(member, index, payload, {
        openThread: options.openThread,
        userAction: options.userAction,
        onOpenDrawer: () => options.onSelectMember(member.id),
      });
      refs.lanes.set(member.id, laneRefs);
      refs.lanesEl.append(laneRefs.lane);
    });
    if (!payload.members.length) refs.lanesEl.append(labeledDom("div", "尚未添加团队成员。", "font-size:11px;opacity:.5"));
  }

  payload.members.forEach((member, index) => {
    const laneRefs = refs.lanes.get(member.id);
    if (!laneRefs) return;
    const color = memberColor(index);
    const assigned = payload.tasks.filter((task) => task.assignee === member.id);
    const done = assigned.filter((task) => task.status === "completed").length;

    laneRefs.lane.dataset.status = member.display_status ?? "";
    laneRefs.card.dataset.status = member.display_status ?? "";
    laneRefs.cardStatus.textContent = stateLabel(member.display_status);
    laneRefs.cardStatus.style.color = stateColor(member.display_status);
    laneRefs.cardCornerDot.style.background = stateColor(member.display_status);
    laneRefs.cardCornerDot.dataset.status = member.display_status ?? "";
    laneRefs.doneLabel.textContent = `${done}/${assigned.length}`;
    laneRefs.progress.set(done, assigned.length);

    // 未读徽标：可操作时给「已读」按钮，否则纯文本胶囊。
    laneRefs.unread.replaceChildren();
    if (member.unread) {
      if (options.userAction && payload.lead_thread_id) {
        const ack = boardActionButton(`💬${member.unread} 已读`, `把 ${member.name} 名下 ${member.unread} 条未送达消息标记为已读`, () => {
          void runBoardAction(options.userAction!, ack, { action: "message/ack", threadId: payload.lead_thread_id!, teamId: payload.team_id, memberId: member.id });
        }, "#2878e3");
        laneRefs.unread.append(ack);
      } else {
        laneRefs.unread.append(labeledDom("span", `💬${member.unread}`, "font-size:8.5px;font-weight:700;color:#2878e3;background:color-mix(in srgb,#2878e3 12%,transparent);border-radius:99px;padding:1px 6px;flex:none"));
      }
    }

    // 当前执行中的任务 + 已耗时
    const activity = memberActivity(payload, snapshots, member.id);
    if (activity.active.length) {
      const titles = activity.active.map((item) => item.task.title).join(" / ");
      laneRefs.currentTask.style.display = "grid";
      laneRefs.currentTask.firstElementChild!.textContent = titles;
      const startedAt = activity.active.reduce<number | undefined>((earliest, item) => {
        if (item.startedAt === undefined) return earliest;
        return earliest === undefined ? item.startedAt : Math.min(earliest, item.startedAt);
      }, undefined);
      if (startedAt !== undefined) {
        laneRefs.elapsed.dataset.from = String(startedAt);
        laneRefs.elapsed.textContent = formatElapsed(startedAt);
      } else {
        delete laneRefs.elapsed.dataset.from;
        laneRefs.elapsed.textContent = "进行中";
      }
    } else {
      laneRefs.currentTask.style.display = "none";
      delete laneRefs.elapsed.dataset.from;
    }

    // 任务卡 keyed 更新：状态变了改字段并闪一下；集合变了按 id 复用节点。
    const taskOrder = assigned.map((task) => task.id).join(",");
    if (taskOrder !== laneRefs.taskOrder) {
      laneRefs.taskOrder = taskOrder;
      laneRefs.taskList.replaceChildren();
      for (const task of assigned) {
        let taskRefs = laneRefs.taskRefs.get(task.id);
        if (!taskRefs) {
          taskRefs = buildTaskCard(task, payload, options.userAction);
          laneRefs.taskRefs.set(task.id, taskRefs);
        } else {
          taskRefs.root.style.setProperty("--lane-color", color);
        }
        laneRefs.taskList.append(taskRefs.root);
      }
      for (const [id, taskRefs] of laneRefs.taskRefs) {
        if (!assigned.some((task) => task.id === id)) {
          taskRefs.root.remove();
          laneRefs.taskRefs.delete(id);
        }
      }
    }
    for (const task of assigned) {
      const taskRefs = laneRefs.taskRefs.get(task.id);
      if (!taskRefs) continue;
      if (taskRefs.status !== task.status) {
        const previous = taskRefs.status;
        taskRefs.status = task.status;
        taskRefs.root.dataset.taskStatus = task.status;
        taskRefs.pill.textContent = stateLabel(task.status);
        taskRefs.pill.style.cssText = pillCss(task.status) + ";margin-left:auto";
        renderTaskControls(taskRefs.controls, task, payload, options.userAction);
        taskRefs.root.removeAttribute("data-flash");
        if (task.status === "completed" && !ACTIVE_TASK_STATUSES.has(previous)) {
          taskRefs.root.dataset.flash = "ok";
        } else if (task.status === "failed" && previous !== "failed") {
          taskRefs.root.dataset.flash = "fail";
        }
        setTimeout(() => taskRefs.root.removeAttribute("data-flash"), 950);
      } else {
        taskRefs.title.textContent = task.title;
        taskRefs.title.title = task.title;
      }
    }
    if (!assigned.length) {
      if (!laneRefs.taskList.childElementCount) {
        laneRefs.taskList.append(labeledDom("div", "等待主导者分配任务", "font-size:9px;opacity:.42;padding:10px 2px;text-align:center"));
      }
    } else if (laneRefs.taskList.childElementCount === 1 && !laneRefs.taskRefs.has((laneRefs.taskList.firstElementChild as HTMLElement).dataset.taskId ?? "")) {
      laneRefs.taskList.replaceChildren();
      for (const task of assigned) laneRefs.taskList.append(laneRefs.taskRefs.get(task.id)!.root);
    }
  });

  // --- filter chips ---
  const chipsSignature = `${payload.members.map((member) => member.id).join(",")}|${options.feedFilter}`;
  if (refs.feedChips.dataset.signature !== chipsSignature) {
    refs.feedChips.dataset.signature = chipsSignature;
    refs.feedChips.replaceChildren();
    const allChip = dom("button", "harness-mix-team-chip");
    allChip.type = "button";
    allChip.textContent = "全部";
    allChip.setAttribute("aria-pressed", options.feedFilter === "all" ? "true" : "false");
    // chips drive the feed filter, the drawer is driven by card clicks.
    allChip.addEventListener("click", () => setFeedFilter(refs, options, "all"));
    refs.feedChips.append(allChip);
    payload.members.forEach((member, index) => {
      const chip = dom("button", "harness-mix-team-chip");
      chip.type = "button";
      const dot = dom("i", undefined, `background:${memberColor(index)}`);
      chip.append(dot, labeledDom("span", member.name, "max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"));
      chip.setAttribute("aria-pressed", options.feedFilter === member.id ? "true" : "false");
      chip.addEventListener("click", () => setFeedFilter(refs, options, member.id));
      refs.feedChips.append(chip);
    });
  } else {
    [...refs.feedChips.children].forEach((chip, index) => {
      const id = index === 0 ? "all" : payload.members[index - 1]?.id;
      (chip as HTMLElement).setAttribute("aria-pressed", options.feedFilter === id ? "true" : "false");
    });
  }

  // --- feed (keyed prepend, newest first) ---
  const entries = collectFeedEntries(payload, lead, snapshots);
  refs.feedCount.textContent = String(entries.length);
  const orderKey = entries.map((entry) => entry.key).join(",");
  if (orderKey !== refs.feedOrderKey) {
    refs.feedOrderKey = orderKey;
    const fresh: HTMLElement[] = [];
    for (const entry of entries) {
      if (refs.feedEntries.has(entry.key)) {
        refs.feedEntries.get(entry.key)!.related = entry.related;
        continue;
      }
      const node = buildFeedEntryNode(entry, payload, lead);
      node.classList.add("harness-mix-team-feed-enter");
      setTimeout(() => node.classList.remove("harness-mix-team-feed-enter"), 400);
      refs.feedEntries.set(entry.key, { node, related: entry.related, kind: entry.kind });
      fresh.push(node);
    }
    for (const [key, entryRefs] of refs.feedEntries) {
      if (!entries.some((entry) => entry.key === key)) {
        entryRefs.node.remove();
        refs.feedEntries.delete(key);
      }
    }
    // Keep the user's scroll position when new items land on top.
    const wasScrolled = refs.feedList.scrollTop > 4;
    const desired = entries.map((entry) => refs.feedEntries.get(entry.key)!.node);
    for (let i = 0; i < desired.length; i++) {
      if (refs.feedList.children[i] !== desired[i]) refs.feedList.insertBefore(desired[i]!, refs.feedList.children[i] ?? null);
    }
    if (wasScrolled && fresh.length) {
      const grown = fresh.reduce((sum, node) => sum + node.offsetHeight, 0);
      refs.feedList.scrollTop += grown;
    }
  }
  for (const [key, entryRefs] of refs.feedEntries) {
    const hidden = options.feedFilter !== "all" && !entryRefs.related.has(options.feedFilter);
    entryRefs.node.classList.toggle("harness-mix-team-hidden", hidden);
  }
  if (!entries.length) {
    if (!refs.feedPlaceholder) {
      refs.feedPlaceholder = labeledDom("div", "成员交接、审查请求和结果会实时显示在这里。", "font-size:10px;line-height:1.5;opacity:.45;padding:10px 0");
      refs.feedList.append(refs.feedPlaceholder);
    }
  } else if (refs.feedPlaceholder) {
    refs.feedPlaceholder.remove();
    refs.feedPlaceholder = null;
  }

  // --- member drawer ---
  const memberIndex = options.selectedMemberId ? payload.members.findIndex((member) => member.id === options.selectedMemberId) : -1;
  const member = memberIndex >= 0 ? payload.members[memberIndex] : null;
  if (!member) {
    refs.drawerHost.style.display = "none";
    refs.drawerHost.replaceChildren();
    refs.drawerSignature = "";
    return;
  }
  const signature = JSON.stringify([
    member.id, member.name, member.role, member.display_status, member.unread,
    payload.tasks.map((task) => task.assignee === member.id ? `${task.id}:${task.status}:${task.title}` : null).filter(Boolean),
    payload.messages.filter((message) => message.from === member.id || message.to === member.id).map((message) => `${message.id ?? message.at}:${message.body.length}`),
    snapshots.filter((snapshot) => snapshot.team.tasks.some((task) => task.assignee === member.id)).map((snapshot) => `${snapshot.id}:${snapshot.action}`),
  ]);
  if (refs.drawerHost.style.display === "none" || signature !== refs.drawerSignature) {
    refs.drawerSignature = signature;
    refs.drawerHost.replaceChildren(buildDrawer(payload, lead, snapshots, member, memberIndex, {
      openThread: options.openThread,
      onClose: () => options.onSelectMember(null),
    }));
    refs.drawerHost.style.display = "block";
  }
}

function setFeedFilter(refs: BoardRefs, options: BoardUpdateOptions, filter: string) {
  options.feedFilter = filter;
  updateBoard(refs, options);
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
  const progress = progressBar("#1f9d68", 5);
  progress.set(completed, payload.tasks.length);
  progress.root.style.cssText += ";width:72px;flex:none;margin-left:auto";
  members.append(progress.root, labeledDom("span", `${completed}/${payload.tasks.length}`, "font-size:9px;font-weight:700;opacity:.52;white-space:nowrap"));
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
const ELAPSED_TICK_MS = 10000;

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
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let activePanel: HTMLElement | null = null;
  let activeSignature = "";
  let activeThreadId = "";
  let activeRefreshPending = false;
  const panelSignatures = new WeakMap<Element, string>();

  // 耗时标签独立走表：轮询签名不变时渲染层会跳过更新，
    // 「已进行 N 分钟」仍要继续走。
  const tickElapsed = () => {
    for (const node of document.querySelectorAll<HTMLElement>(".harness-mix-team-elapsed[data-from]")) {
      node.textContent = formatElapsed(Number(node.dataset.from));
    }
  };

  const closeWorkbench = () => {
    workbench?.remove();
    workbench = null;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
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
    let snapshots: TeamHistoryEntry[] = [];
    let index = -1;
    let feedFilter = "all";
    let selectedMemberId: string | null = null;

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
    const headerBar = dom("div", "harness-mix-team-bar", "width:92px;height:5px;flex:none");
    headerBar.style.setProperty("--bar-color", "#1f9d68");
    const headerFill = dom("i", undefined, "width:0%");
    headerBar.append(headerFill);
    const progressPct = labeledDom("strong", "0%", "font-size:11px;font-weight:750;color:#1f9d68;min-width:30px");
    progressWrap.append(headerBar, progressPct);

    const timeline = dom("div", "harness-mix-team-timeline", "display:flex;align-items:center;gap:6px;margin-left:auto;min-width:0");
    const event = labeledDom("span", "实时状态", "font-size:9px;opacity:.55;min-width:60px;text-align:right");
    event.title = "拖动滑杆回看团队历史；「实时」回到最新状态";
    const range = dom("input");
    range.type = "range";
    range.min = "0";
    range.max = "0";
    range.value = "0";
    range.style.cssText = "width:min(120px,16vw);accent-color:#2878e3";
    range.title = "回放团队历史快照";
    const live = dom("button", undefined, "border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:transparent;color:inherit;font:600 10px system-ui;padding:5px 7px;cursor:pointer");
    live.type = "button";
    live.textContent = "实时";
    const play = dom("button", undefined, "border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:color-mix(in srgb,currentColor 6%,transparent);color:inherit;font:600 10px system-ui;padding:5px 8px;cursor:pointer");
    play.type = "button";
    play.textContent = "回放";
    play.title = "自动回放团队历史快照";
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

    // 看板结构只建一次，之后全部原地更新（keyed by member/task/feed id）。
    const boardRefs = createBoard();
    const boardOptions = (): BoardUpdateOptions => ({
      payload: index >= 0 ? snapshots[index]!.team : current,
      snapshots: index >= 0 ? snapshots.slice(0, index + 1) : snapshots,
      openThread: async (threadId: string) => {
        closeWorkbench();
        await options.openThread?.(threadId);
      },
      userAction: options.userAction,
      feedFilter,
      selectedMemberId,
      onSelectMember: (memberId: string | null) => {
        selectedMemberId = memberId;
        render();
      },
    });

    let renderedSignature = "";
    const render = () => {
      const visible = index >= 0 ? snapshots[index]!.team : current;
      // 1.5s 轮询下内容没变就跳过重渲染：面板不闪、feed/列表滚动位置不丢。
      const signature = JSON.stringify([visible.updated_at, visible.status, visible.lead?.display_status, visible.members.map((member) => member.display_status), visible.tasks.map((task) => `${task.id}:${task.status}`), visible.messages.length, snapshots.length, index, selectedMemberId, feedFilter, visible.driver ? [visible.driver.status, visible.driver.phase ?? null, visible.driver.error ?? null, (visible.driver.tasks ?? []).map((task) => task.status).join(",")] : null]);
      updateBoard(boardRefs, boardOptions());
      if (signature === renderedSignature) return;
      renderedSignature = signature;
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
      headerFill.style.width = `${completion.pct}%`;
      headerBar.title = `${completion.done}/${completion.total} 个任务完成`;
      progressPct.textContent = `${completion.pct}%`;
      range.max = String(Math.max(0, snapshots.length - 1));
      range.value = String(index >= 0 ? index : Math.max(0, snapshots.length - 1));
      event.textContent = index >= 0 && snapshots[index] ? `${actionLabel(snapshots[index]!.action)} · ${new Date(snapshots[index]!.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "● 实时状态";
    };

    if (!content.childElementCount) content.append(boardRefs.root);

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
    elapsedTimer = setInterval(tickElapsed, ELAPSED_TICK_MS);
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
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
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
