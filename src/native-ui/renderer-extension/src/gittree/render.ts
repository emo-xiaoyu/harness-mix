// GitTree canvas: SVG rails + branch edges + running borders in one overlay,
// session/event nodes as absolutely positioned buttons above it. Lancer's
// hybrid rendering (lines in SVG for cheap curves, nodes in HTML for
// accessibility and hover) adapted to this extension's dependency-free style.

import { branchPath } from "./flight-geometry.js";
import type { GittreeEvent, GittreeForest, GittreeModel, GittreeThread } from "./model.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LANE_WIDTH = 148;
const LANE_PADDING = 14;
const ROW_HEIGHT = 34;
const TOP_PADDING = 16;
const NODE_SIZE = { session: { width: 132, height: 30 }, event: { width: 22, height: 22 } };
const EVENT_OFFSET_X = 16;

const EVENT_GLYPH: Record<GittreeEvent["kind"], string> = {
  spawn: "▸",
  ready: "○",
  settle: "✓",
  fail: "✕",
};

export interface GittreeNodeGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GittreeLayoutResult {
  readonly geometry: ReadonlyMap<string, GittreeNodeGeometry>;
  readonly width: number;
  readonly height: number;
  /** Edge keys: `edge:child` (branch) and `stem:eventId` (event stub). */
  readonly edges: readonly { key: string; d: string }[];
  readonly laneRails: readonly { rootThreadId: string; d: string; color: string }[];
  readonly laneHeaders: readonly { rootThreadId: string; x: number; y: number; color: string; title: string }[];
}

/** Pure layout pass: geometry for every node/edge from the model's Kahn rows. */
export function layoutGittreeCanvas(model: GittreeModel): GittreeLayoutResult {
  const geometry = new Map<string, GittreeNodeGeometry>();
  const laneIndexOf = new Map<string, number>();
  const orderedRoots = [...model.forest.roots];
  // Lanes are ordered by the most recent activity in their subtree.
  const latestByRoot = new Map<string, number>();
  for (const thread of model.threads) {
    let root = thread.id;
    for (let hop = 0; hop < 32; hop += 1) {
      const parent = model.forest.parentOf.get(root);
      if (!parent) break;
      root = parent;
    }
    latestByRoot.set(root, Math.max(latestByRoot.get(root) ?? 0, thread.updatedAtMs));
  }
  orderedRoots.sort((left, right) => {
    const latest = (latestByRoot.get(right) ?? 0) - (latestByRoot.get(left) ?? 0);
    return latest || left.localeCompare(right);
  });
  orderedRoots.forEach((root, index) => laneIndexOf.set(root, index));
  const laneX = (threadId: string): number => {
    let root = threadId;
    for (let hop = 0; hop < 32; hop += 1) {
      const parent = model.forest.parentOf.get(root);
      if (!parent) break;
      root = parent;
    }
    return LANE_PADDING + (laneIndexOf.get(root) ?? 0) * LANE_WIDTH + (model.forest.depthOf.get(threadId) ?? 0) * 22;
  };
  const rowY = (nodeKey: string): number => TOP_PADDING + (model.rows.get(nodeKey) ?? 0) * ROW_HEIGHT;
  const threadsById = new Map(model.threads.map(thread => [thread.id, thread]));
  const edges: { key: string; d: string }[] = [];
  const laneTopY = new Map<string, number>();
  const laneBottomY = new Map<string, number>();
  const touchLane = (rootThreadId: string, y: number) => {
    laneTopY.set(rootThreadId, Math.min(laneTopY.get(rootThreadId) ?? y, y));
    laneBottomY.set(rootThreadId, Math.max(laneBottomY.get(rootThreadId) ?? y, y));
  };
  for (const thread of model.threads) {
    const nodeKey = `t:${thread.id}`;
    const x = laneX(thread.id);
    const y = rowY(nodeKey);
    geometry.set(nodeKey, { x, y, width: NODE_SIZE.session.width, height: NODE_SIZE.session.height });
    let root = thread.id;
    for (let hop = 0; hop < 32; hop += 1) {
      const parent = model.forest.parentOf.get(root);
      if (!parent) break;
      root = parent;
    }
    touchLane(root, y + NODE_SIZE.session.height / 2);
    const parent = model.forest.parentOf.get(thread.id);
    const parentThread = parent ? threadsById.get(parent) : undefined;
    if (parentThread && geometry.has(`t:${parentThread.id}`)) {
      const parentBox = geometry.get(`t:${parentThread.id}`) as GittreeNodeGeometry;
      edges.push({
        key: `edge:${thread.id}`,
        d: branchPath(
          { x: x + NODE_SIZE.session.width / 2, y: y - 2 },
          { x: parentBox.x + parentBox.width / 2, y: parentBox.y + parentBox.height + 2 },
        ),
      });
    }
  }
  const eventsByThread = new Map<string, GittreeEvent[]>();
  for (const event of model.events) {
    if (!event.threadId) continue;
    const chain = eventsByThread.get(event.threadId) ?? [];
    chain.push(event);
    eventsByThread.set(event.threadId, chain);
  }
  for (const [threadId, chain] of eventsByThread) {
    const threadBox = geometry.get(`t:${threadId}`);
    if (!threadBox) continue;
    chain.sort((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id));
    for (const event of chain) {
      const nodeKey = `e:${event.id}`;
      const x = threadBox.x + NODE_SIZE.session.width + EVENT_OFFSET_X;
      const y = rowY(nodeKey);
      geometry.set(nodeKey, { x, y, width: NODE_SIZE.event.width, height: NODE_SIZE.event.height });
      edges.push({
        key: `stem:${event.id}`,
        d: branchPath(
          { x, y: y + NODE_SIZE.event.height / 2 },
          { x: threadBox.x + NODE_SIZE.session.width, y: threadBox.y + NODE_SIZE.session.height / 2 },
        ),
      });
    }
  }
  const laneRails = orderedRoots
    .filter(root => laneTopY.has(root) && model.threads.some(thread => thread.id === root))
    .map(root => ({
      rootThreadId: root,
      d: `M ${laneX(root)} ${laneTopY.get(root) ?? 0} L ${laneX(root)} ${(laneBottomY.get(root) ?? 0) + 18}`,
      color: model.laneColor.get(root) ?? "currentColor",
    }));
  const laneHeaders = orderedRoots
    .filter(root => model.threads.some(thread => thread.id === root))
    .map(root => ({
      rootThreadId: root,
      x: laneX(root),
      y: Math.max(0, (laneTopY.get(root) ?? TOP_PADDING) - 12),
      color: model.laneColor.get(root) ?? "currentColor",
      title: threadsById.get(root)?.title ?? root,
    }));
  let width = 0;
  let height = 0;
  for (const box of geometry.values()) {
    width = Math.max(width, box.x + box.width);
    height = Math.max(height, box.y + box.height);
  }
  return { geometry, width: width + 40, height: height + 24, edges, laneRails, laneHeaders };
}

export interface GittreeRenderHandlers {
  onThreadClick(threadId: string): void;
}

export interface GittreeRenderResult {
  /** Anchor getters for the light layer; null when the node is gone. */
  anchor(nodeKey: string): (() => HTMLElement | null) | null;
}

function svgChild<K extends keyof SVGElementTagNameMap>(
  ownerDocument: Document,
  name: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = ownerDocument.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

const RUNNING_RECT_STYLE = `
.harness-mix-gittree-svg .harness-mix-gittree-running-rect{animation:harness-mix-gittree-flow 3.6s linear infinite}
@keyframes harness-mix-gittree-flow{to{stroke-dashoffset:-100}}
@media (prefers-reduced-motion: reduce){.harness-mix-gittree-svg .harness-mix-gittree-running-rect{animation:none;stroke-dasharray:none;opacity:.55}}
`;

/** Renders the model into the panel canvas. Session/event buttons are keyed by
 * data-node-id and updated in place; the SVG overlay is rebuilt only when the
 * structural signature changes so running-border animations never restart. */
export function renderGittreeCanvas(
  container: HTMLElement,
  model: GittreeModel,
  handlers: GittreeRenderHandlers,
): GittreeRenderResult {
  const ownerDocument = container.ownerDocument;
  const layout = layoutGittreeCanvas(model);
  container.style.setProperty("--harness-mix-gittree-width", `${Math.max(layout.width, 240)}px`);
  container.style.setProperty("--harness-mix-gittree-height", `${Math.max(layout.height, 120)}px`);

  let style = ownerDocument.querySelector("style[data-harnessmix-gittree-canvas]");
  if (!style) {
    style = ownerDocument.createElement("style");
    style.setAttribute("data-harnessmix-gittree-canvas", "");
    style.textContent = RUNNING_RECT_STYLE;
    ownerDocument.head.append(style);
  }

  const signature = [
    ...layout.edges.map(edge => edge.key),
    ...model.threads.filter(thread => thread.running).map(thread => `r:${thread.id}`),
  ]
    .sort()
    .join("|");
  let svg = container.querySelector<SVGSVGElement>("svg[data-harnessmix-gittree-svg]");
  if (!svg || svg.dataset.signature !== signature) {
    svg?.remove();
    svg = svgChild(ownerDocument, "svg", {
      class: "harness-mix-gittree-svg",
      "data-harnessmix-gittree-svg": "",
    });
    svg.dataset.signature = signature;
    Object.assign(svg.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: `${Math.max(layout.width, 240)}px`,
      height: `${Math.max(layout.height, 120)}px`,
      pointerEvents: "none",
      overflow: "visible",
    });
    svg.setAttribute("viewBox", `0 0 ${Math.max(layout.width, 240)} ${Math.max(layout.height, 120)}`);
    container.prepend(svg);
    for (const rail of layout.laneRails) {
      svg.append(
        svgChild(ownerDocument, "path", {
          d: rail.d,
          stroke: rail.color,
          "stroke-width": 2,
          "stroke-opacity": 0.4,
          fill: "none",
        }),
      );
    }
    for (const edge of layout.edges) {
      svg.append(
        svgChild(ownerDocument, "path", {
          d: edge.d,
          stroke: "currentColor",
          "stroke-opacity": 0.32,
          "stroke-width": 1.4,
          fill: "none",
          "data-harnessmix-gittree-edge": edge.key,
        }),
      );
    }
    for (const thread of model.threads) {
      if (!thread.running) continue;
      const box = layout.geometry.get(`t:${thread.id}`);
      if (!box) continue;
      const color = model.laneColor.get(thread.id) ?? "currentColor";
      svg.append(
        svgChild(ownerDocument, "rect", {
          class: "harness-mix-gittree-running-rect",
          x: box.x - 3,
          y: box.y - 3,
          width: box.width + 6,
          height: box.height + 6,
          rx: 9,
          fill: "none",
          stroke: color,
          "stroke-width": 1.2,
          "stroke-dasharray": "9 91",
          "vector-effect": "non-scaling-stroke",
          "data-harnessmix-gittree-running": thread.id,
        }),
      );
    }
  } else {
    for (const rail of svg.querySelectorAll<SVGPathElement>("path[data-harnessmix-gittree-rail]")) rail.remove();
  }

  const anchors = new Map<string, HTMLElement>();
  const seen = new Set<string>();
  const ensureNode = (nodeKey: string, className: string, title: string, onClick: (() => void) | null, color: string): HTMLElement => {
    seen.add(nodeKey);
    let node = container.querySelector<HTMLElement>(`[data-harnessmix-gittree-node="${nodeKey}"]`);
    if (!node) {
      node = ownerDocument.createElement("button");
      (node as HTMLButtonElement).type = "button";
      node.dataset.harnessmixGittreeNode = nodeKey;
      node.className = className;
      container.append(node);
    }
    const box = layout.geometry.get(nodeKey);
    if (box) {
      node.style.left = `${box.x}px`;
      node.style.top = `${box.y}px`;
      node.style.width = `${box.width}px`;
      node.style.height = `${box.height}px`;
    }
    node.style.setProperty("--lane-color", color);
    node.title = title;
    node.onclick = onClick;
    if (!node.isConnected) container.append(node);
    anchors.set(nodeKey, node);
    return node;
  };
  for (const thread of model.threads) {
    const node = ensureNode(
      `t:${thread.id}`,
      `harness-mix-gittree-node harness-mix-gittree-session${thread.running ? " is-running" : ""}`,
      thread.title,
      () => handlers.onThreadClick(thread.id),
      model.laneColor.get(thread.id) ?? "currentColor",
    );
    node.dataset.running = String(thread.running);
    node.dataset.kind = thread.kind;
    const label = node.querySelector(".harness-mix-gittree-node-label") ?? ownerDocument.createElement("span");
    label.className = "harness-mix-gittree-node-label";
    label.textContent = thread.title.length > 18 ? `${thread.title.slice(0, 17)}…` : thread.title;
    if (!label.parentElement) node.append(label);
    const status = node.querySelector(".harness-mix-gittree-node-status") ?? ownerDocument.createElement("i");
    status.className = "harness-mix-gittree-node-status";
    status.textContent = thread.running ? "●" : "○";
    if (!status.parentElement) node.prepend(status);
  }
  for (const event of model.events) {
    const nodeKey = `e:${event.id}`;
    const box = layout.geometry.get(nodeKey);
    if (!box) continue;
    const node = ensureNode(
      nodeKey,
      `harness-mix-gittree-node harness-mix-gittree-event kind-${event.kind}`,
      `${EVENT_GLYPH[event.kind] ?? "•"} ${event.title}`,
      null,
      (event.threadId && model.laneColor.get(event.threadId)) || "currentColor",
    );
    node.textContent = EVENT_GLYPH[event.kind] ?? "•";
  }
  for (const node of [...container.querySelectorAll<HTMLElement>("[data-harnessmix-gittree-node]")]) {
    const nodeKey = node.dataset.harnessmixGittreeNode;
    if (!nodeKey || !seen.has(nodeKey)) node.remove();
  }
  for (const laneHeader of layout.laneHeaders) {
    seen.add(`lane:${laneHeader.rootThreadId}`);
    let head = container.querySelector<HTMLElement>(
      `[data-harnessmix-gittree-lane="${laneHeader.rootThreadId}"]`,
    );
    if (!head) {
      head = ownerDocument.createElement("span");
      head.className = "harness-mix-gittree-lane-head";
      head.dataset.harnessmixGittreeLane = laneHeader.rootThreadId;
      container.append(head);
    }
    head.style.left = `${laneHeader.x}px`;
    head.style.top = `${laneHeader.y}px`;
    head.style.color = laneHeader.color;
    head.textContent = laneHeader.title;
  }
  for (const head of [...container.querySelectorAll<HTMLElement>("[data-harnessmix-gittree-lane]")]) {
    if (!seen.has(`lane:${head.dataset.harnessmixGittreeLane}`)) head.remove();
  }
  return {
    anchor(nodeKey) {
      const element = anchors.get(nodeKey);
      if (!element) return null;
      return () => (element.isConnected ? element : null);
    },
  };
}

/** Convenience for tests: expose forest-derived focus helper. */
export const forestOf = (model: GittreeModel): GittreeForest => model.forest;
export type { GittreeThread, GittreeEvent };
