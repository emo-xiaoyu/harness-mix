// GitTree right rail: a body-portaled fixed panel with a toolbar trigger, a
// 1.5s poll that feeds the emission clock, and light flights from the model
// row / event nodes to tree nodes. Launcher-style standalone surface — the
// official Codex request path is never touched (sidebar reads are passive).

import { findRendererSettingsHeaderInsertionPoint } from "../settings/trigger.js";
import { GittreeEmissionClock } from "./emission-clock.js";
import { createGittreeLightLayer, type GittreeLightLayerControl } from "./light-layer.js";
import {
  buildGittreeModel,
  mergeSidebarThreads,
  parseThreadListEntries,
  projectTeamSnapshots,
  type GittreeEvent,
  type GittreeSidebarThread,
  type GittreeThread,
} from "./model.js";
import { renderGittreeCanvas, type GittreeRenderResult } from "./render.js";

export const GITTREE_TRIGGER_ATTRIBUTE = "data-harnessmix-gittree-trigger";
export const GITTREE_PANEL_ATTRIBUTE = "data-harnessmix-gittree-panel";
export const THREAD_LIST_METHOD = "harnessmix/thread/list";

const POLL_INTERVAL_MS = 1500;

export interface GittreeTeamInspection {
  readonly snapshots?: readonly unknown[];
}

export interface GittreePanelDeps {
  /** Raw `harnessmix/thread/list` response data (already unwrapped). */
  listManagedThreads(): Promise<readonly unknown[]>;
  /** Sidebar enumeration including official Codex threads with ownership. */
  listSidebarThreads(): Promise<readonly GittreeSidebarThread[]>;
  /** Active team inspection for events; null when no team is active. */
  inspectActiveTeam(threadId: string | null): Promise<GittreeTeamInspection | null>;
  activeThreadId(): string | null;
  openThread(threadId: string): void;
  ownerWindow?: Window & typeof globalThis;
}

export interface GittreePanelControl {
  toggle(): void;
  open(): void;
  close(): void;
  refresh(): void;
  dispose(): void;
  readonly isOpen: boolean;
}

const PANEL_STYLE = `
[data-harnessmix-gittree-panel]{position:fixed;right:0;bottom:0;width:clamp(280px,24vw,380px);z-index:14;display:flex;flex-direction:column;border-radius:14px 0 0 14px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-right:none;background:color-mix(in srgb,Canvas 96%,transparent);backdrop-filter:blur(8px);color:inherit;font:inherit;box-shadow:-8px 0 24px color-mix(in srgb,#000 12%,transparent);color-scheme:light dark}
[data-harnessmix-gittree-panel] .harness-mix-gittree-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}
[data-harnessmix-gittree-panel] .harness-mix-gittree-title{font-weight:600;font-size:13px}
[data-harnessmix-gittree-panel] .harness-mix-gittree-spacer{flex:1}
[data-harnessmix-gittree-panel] button{font:inherit;font-size:12px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,Canvas 92%,transparent);color:inherit;border-radius:8px;padding:3px 10px;cursor:pointer}
[data-harnessmix-gittree-panel] button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
[data-harnessmix-gittree-panel] .harness-mix-gittree-scroll{flex:1;overflow:auto;position:relative;padding:6px 0 16px}
[data-harnessmix-gittree-panel] .harness-mix-gittree-canvas{position:relative;width:var(--harness-mix-gittree-width,240px);height:var(--harness-mix-gittree-height,120px);min-width:100%}
[data-harnessmix-gittree-panel] .harness-mix-gittree-empty{padding:24px 16px;font-size:12px;opacity:.7}
[data-harnessmix-gittree-panel] .harness-mix-gittree-lane-head{position:absolute;font-size:10px;opacity:.75;max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-harnessmix-gittree-panel] .harness-mix-gittree-node{position:absolute;display:flex;align-items:center;gap:6px;padding:0 8px;border-radius:9px;border:1px solid color-mix(in srgb,var(--lane-color,currentColor) 45%,transparent);background:color-mix(in srgb,Canvas 94%,transparent);color:inherit;cursor:pointer;overflow:hidden;white-space:nowrap}
[data-harnessmix-gittree-panel] .harness-mix-gittree-node:hover{border-color:var(--lane-color,currentColor)}
[data-harnessmix-gittree-panel] .harness-mix-gittree-session{height:30px;justify-content:flex-start}
[data-harnessmix-gittree-panel] .harness-mix-gittree-session .harness-mix-gittree-node-status{color:var(--lane-color,currentColor);font-style:normal;font-size:9px}
[data-harnessmix-gittree-panel] .harness-mix-gittree-session.is-running{border-color:color-mix(in srgb,var(--lane-color,currentColor) 80%,transparent);box-shadow:0 0 10px color-mix(in srgb,var(--lane-color,currentColor) 22%,transparent)}
[data-harnessmix-gittree-panel] .harness-mix-gittree-node-label{font-size:11px;overflow:hidden;text-overflow:ellipsis}
[data-harnessmix-gittree-panel] .harness-mix-gittree-event{justify-content:center;border-radius:50%;font-size:11px;line-height:1;padding:0}
[data-harnessmix-gittree-panel] .harness-mix-gittree-event.kind-settle{color:#16a34a}
[data-harnessmix-gittree-panel] .harness-mix-gittree-event.kind-fail{color:#dc2626}
[data-harnessmix-gittree-panel] .harness-mix-gittree-event.kind-spawn,.harness-mix-gittree-panel] .harness-mix-gittree-event.kind-ready{color:var(--lane-color,currentColor)}
[data-harnessmix-gittree-trigger-root]{-webkit-app-region:no-drag}
`;

function ensurePanelStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector("style[data-harnessmix-gittree-style]")) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute("data-harnessmix-gittree-style", "");
  style.textContent = PANEL_STYLE;
  ownerDocument.head.append(style);
}

function measurePanelTop(ownerDocument: Document): string {
  const header = ownerDocument.querySelector<HTMLElement>("[data-app-shell-page-header], header[data-pip-obstacle='app-shell-header']");
  if (header) {
    const bottom = header.getBoundingClientRect().bottom;
    if (bottom > 0 && bottom < ownerDocument.defaultView!.innerHeight * 0.5) return `${Math.round(bottom) + 8}px`;
  }
  return "56px";
}

/** Inert control for document-less environments (node tests). */
const inertControl = (): GittreePanelControl => ({
  toggle: () => undefined,
  open: () => undefined,
  close: () => undefined,
  refresh: () => undefined,
  dispose: () => undefined,
  isOpen: false,
});

export function installGittreePanel(deps: GittreePanelDeps): GittreePanelControl {
  const ownerWindow = deps.ownerWindow ?? (typeof window === "undefined" ? null : window);
  const ownerDocument = ownerWindow?.document ?? null;
  if (!ownerWindow || !ownerDocument || !ownerDocument.body) return inertControl();

  ensurePanelStyle(ownerDocument);
  const clock = new GittreeEmissionClock();
  const layer: GittreeLightLayerControl = createGittreeLightLayer(ownerWindow);

  let panel: HTMLElement | null = null;
  let canvas: HTMLElement | null = null;
  let renderResult: GittreeRenderResult | null = null;
  let open = false;
  let focus = false;
  let disposed = false;
  let pollTimer: number | null = null;
  let lastEvents: readonly GittreeEvent[] = [];
  let lastThreads: readonly GittreeThread[] = [];
  let lastModel = buildGittreeModel({ threads: [], events: [], currentThreadId: null, focus: false });

  const trigger = ownerDocument.createElement("button");
  trigger.type = "button";
  trigger.setAttribute(GITTREE_TRIGGER_ATTRIBUTE, "");
  trigger.className = "harness-mix-gittree-trigger-root";
  trigger.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font-size:12px;cursor:pointer";
  trigger.textContent = "🌲 GitTree";
  trigger.title = "GitTree · 会话任务树";
  trigger.addEventListener("click", () => toggle());

  // Parent-anchored placement: append into the insertion parent once and only
  // re-append when something (React reconcile) removed us. Chasing an exact
  // sibling position oscillates forever against the settings trigger's
  // before-slot math and the app's own reorders — each insertBefore invalidates
  // layout and reheats the composer placement scans (isFlexRow) until the
  // renderer burns a full core.
  let placedParent: HTMLElement | null = null;
  let lastRefreshAt = 0;
  const refreshTrigger = (force = false): boolean => {
    if (disposed) return false;
    const now = ownerWindow.performance.now();
    if (!force && trigger.parentElement !== null && now - lastRefreshAt < 250) return true;
    lastRefreshAt = now;
    const insertion = findRendererSettingsHeaderInsertionPoint(ownerDocument);
    if (!insertion) {
      trigger.remove();
      placedParent = null;
      return false;
    }
    if (trigger.parentElement !== insertion.parent || placedParent !== insertion.parent) {
      insertion.parent.append(trigger);
      placedParent = insertion.parent;
    }
    trigger.style.position = insertion.pinnedRight ? "absolute" : "";
    trigger.style.top = insertion.pinnedRight ? "50%" : "";
    trigger.style.transform = insertion.pinnedRight ? "translateY(-50%)" : "";
    trigger.style.right = insertion.pinnedRight ?? "";
    return true;
  };
  const observer = ownerWindow.MutationObserver
    ? new ownerWindow.MutationObserver((records: MutationRecord[]) => {
        if (records.some(record => !(record.target as Element).closest?.(`[${GITTREE_TRIGGER_ATTRIBUTE}]`))) {
          refreshTrigger();
        }
      })
    : null;
  observer?.observe(ownerDocument.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "class", "style", "data-app-shell-page-header", "data-app-shell-header-toolbar"],
  });
  refreshTrigger(true);

  const modelControlAnchor = (): HTMLElement | null => {
    const controls = [...ownerDocument.querySelectorAll<HTMLElement>("[data-harnessmix-model-control]")];
    const visible = controls.filter(control => {
      if (!control.isConnected) return false;
      const bounds = control.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    return visible[visible.length - 1] ?? null;
  };

  const rootOfThread = (threadId: string): string => {
    let root = threadId;
    for (let hop = 0; hop < 32; hop += 1) {
      const parent = lastModel.forest.parentOf.get(root);
      if (!parent) break;
      root = parent;
    }
    return root;
  };

  const emitFlights = (): void => {
    if (!renderResult) return;
    const now = ownerWindow.performance.now();
    for (const flight of clock.flights(now)) {
      const event = lastEvents.find(candidate => candidate.id === flight.id);
      if (!event) continue;
      const color = (event.threadId && lastModel.laneColor.get(event.threadId)) || "currentColor";
      const eventAnchor = renderResult.anchor(`e:${event.id}`);
      if (!eventAnchor) continue;
      if (event.kind === "settle" || event.kind === "fail") {
        // Results flow back to the lead lane node.
        const leadAnchor = renderResult.anchor(`t:${rootOfThread(event.threadId ?? "")}`);
        if (leadAnchor) {
          layer.emit({ id: `flight:${event.id}`, from: eventAnchor, to: leadAnchor, color, seed: clock.seedFor(event.id) });
        }
      } else {
        // New work flies out from the composer model row (fallback: panel head).
        const source = modelControlAnchor() ?? panel?.querySelector<HTMLElement>(".harness-mix-gittree-title") ?? null;
        const sourceAnchor = (): HTMLElement | null => source;
        layer.emit({ id: `flight:${event.id}`, from: sourceAnchor, to: eventAnchor, color, seed: clock.seedFor(event.id) });
      }
    }
  };

  const refresh = async (): Promise<void> => {
    if (disposed || !open || !canvas) return;
    const [rawThreads, sidebarThreads, team] = await Promise.all([
      deps.listManagedThreads().catch(() => [] as readonly unknown[]),
      deps.listSidebarThreads().catch(() => [] as readonly GittreeSidebarThread[]),
      deps.inspectActiveTeam(deps.activeThreadId()).catch(() => null),
    ]);
    if (disposed || !open || !canvas) return;
    const managed = parseThreadListEntries(Array.isArray(rawThreads) ? rawThreads : []);
    lastThreads = mergeSidebarThreads(managed, sidebarThreads);
    lastEvents = projectTeamSnapshots(
      Array.isArray(team?.snapshots) ? (team?.snapshots as readonly unknown[]).map(snapshot => snapshot as Record<string, unknown>) : [],
    );
    clock.observe(
      lastEvents.map(event => ({ id: event.id, status: event.kind, milestone: event.threadId ?? "" })),
      ownerWindow.performance.now(),
    );
    const currentThreadId = deps.activeThreadId();
    lastModel = buildGittreeModel({ threads: lastThreads, events: lastEvents, currentThreadId, focus });
    const empty = canvas.querySelector<HTMLElement>(".harness-mix-gittree-empty");
    if (lastThreads.length === 0) {
      if (!empty) {
        const notice = ownerDocument.createElement("p");
        notice.className = "harness-mix-gittree-empty";
        notice.textContent = "暂无会话——开始或派生一个任务后，这里会显示任务树。";
        canvas.append(notice);
      }
      return;
    }
    empty?.remove();
    renderResult = renderGittreeCanvas(canvas, lastModel, {
      onThreadClick: threadId => deps.openThread(threadId),
    });
    for (const laneHeader of canvas.querySelectorAll<HTMLElement>(".harness-mix-gittree-lane-head")) laneHeader.remove();
    emitFlights();
  };

  const startPolling = (): void => {
    if (pollTimer !== null) return;
    void refresh();
    pollTimer = ownerWindow.setInterval(() => void refresh(), POLL_INTERVAL_MS);
  };
  const stopPolling = (): void => {
    if (pollTimer !== null) {
      ownerWindow.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && open) close();
  };
  ownerDocument.addEventListener("keydown", onKeyDown);

  const openPanel = (): void => {
    if (disposed || panel) return;
    panel = ownerDocument.createElement("aside");
    panel.setAttribute(GITTREE_PANEL_ATTRIBUTE, "");
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "GitTree 会话任务树");
    const head = ownerDocument.createElement("div");
    head.className = "harness-mix-gittree-head";
    const title = ownerDocument.createElement("span");
    title.className = "harness-mix-gittree-title";
    title.textContent = "GitTree · 会话";
    const spacer = ownerDocument.createElement("span");
    spacer.className = "harness-mix-gittree-spacer";
    const focusButton = ownerDocument.createElement("button");
    focusButton.type = "button";
    focusButton.textContent = focus ? "全部" : "聚焦";
    focusButton.title = "聚焦当前会话子树 / 显示全部会话线";
    focusButton.addEventListener("click", () => {
      focus = !focus;
      focusButton.textContent = focus ? "全部" : "聚焦";
      void refresh();
    });
    const closeButton = ownerDocument.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "✕";
    closeButton.title = "关闭";
    closeButton.addEventListener("click", () => close());
    head.append(title, spacer, focusButton, closeButton);
    const scroll = ownerDocument.createElement("div");
    scroll.className = "harness-mix-gittree-scroll";
    canvas = ownerDocument.createElement("div");
    canvas.className = "harness-mix-gittree-canvas";
    scroll.append(canvas);
    panel.append(head, scroll);
    panel.style.top = measurePanelTop(ownerDocument);
    ownerDocument.body.append(panel);
    open = true;
    startPolling();
  };

  const closePanel = (): void => {
    if (!panel) return;
    stopPolling();
    panel.remove();
    panel = null;
    canvas = null;
    renderResult = null;
    open = false;
  };

  const toggle = (): void => (open ? closePanel() : openPanel());

  return {
    toggle,
    open: () => {
      if (!open) openPanel();
    },
    close: () => closePanel(),
    refresh: () => {
      void refresh();
    },
    dispose() {
      disposed = true;
      stopPolling();
      closePanel();
      observer?.disconnect();
      trigger.remove();
      placedParent = null;
      ownerDocument.removeEventListener("keydown", onKeyDown);
      layer.dispose();
      clock.reset();
    },
    get isOpen() {
      return open;
    },
  };
}
