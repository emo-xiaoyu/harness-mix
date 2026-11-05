// GitTree data model: merge harness-mix managed threads (RPC) with official
// Codex sessions (sidebar enumeration), build the parent→child forest, project
// team snapshots into task events, and lay everything out with Kahn
// longest-path rows (return events order after the transitions they settle).

export interface GittreeThread {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly title: string;
  readonly running: boolean;
  readonly kind: "harnessmix" | "codex";
  readonly harness: string | null;
  readonly updatedAtMs: number;
}

/** Loose projection of `harnessmix/thread/list` entries (protocol.js projectThread). */
export interface GittreeThreadListEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly parentThreadId?: unknown;
  readonly status?: unknown;
  readonly updatedAt?: unknown;
  readonly agentRole?: unknown;
}

export interface GittreeSidebarThread {
  readonly threadId: string;
  readonly title: string;
  readonly owner: "codex" | "external";
  readonly harnessId?: string | null;
}

export type GittreeEventKind = "spawn" | "ready" | "settle" | "fail";

export interface GittreeEvent {
  /** Stable across polls: the snapshot record id. */
  readonly id: string;
  readonly kind: GittreeEventKind;
  readonly threadId: string | null;
  readonly taskId: string | null;
  readonly title: string;
  readonly atMs: number;
}

export interface GittreeTeamSnapshotTeamMember {
  readonly id?: unknown;
  readonly childId?: unknown;
}
export interface GittreeTeamSnapshotTask {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly assignee?: unknown;
  readonly dependsOn?: unknown;
}
export interface GittreeTeamSnapshot {
  readonly id?: unknown;
  readonly action?: unknown;
  readonly at?: unknown;
  readonly team?: unknown;
}

const EVENT_ACTIONS: Record<string, GittreeEventKind> = {
  task_assigned: "spawn",
  task_started: "spawn",
  task_resumed: "spawn",
  task_reassigned: "spawn",
  member_session_ready: "ready",
  task_settled: "settle",
  task_failed: "fail",
  task_cancelled: "fail",
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Parse `harnessmix/thread/list` entries into the renderer-side shape. */
export function parseThreadListEntries(entries: readonly unknown[]): GittreeThread[] {
  const threads: GittreeThread[] = [];
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as GittreeThreadListEntry;
    const id = asString(entry.id);
    if (!id) continue;
    const status = entry.status as { type?: unknown } | null | undefined;
    // projectThread timestamps are seconds; sidebar-free RPC path only.
    const updatedAtSec = asNumber(entry.updatedAt);
    threads.push({
      id,
      parentThreadId: asString(entry.parentThreadId),
      title: asString(entry.name) ?? id,
      running: Boolean(status) && (status as { type?: unknown }).type === "active",
      kind: "harnessmix",
      harness: null,
      updatedAtMs: updatedAtSec === null ? 0 : updatedAtSec * 1000,
    });
  }
  return threads;
}

/** Union of RPC threads and sidebar rows; RPC wins on duplicates because it
 * carries parentThreadId. Official Codex threads join as parentless lanes. */
export function mergeSidebarThreads(
  listThreads: readonly GittreeThread[],
  sidebarThreads: readonly GittreeSidebarThread[],
): GittreeThread[] {
  const byId = new Map(listThreads.map(thread => [thread.id, thread]));
  for (const sidebar of sidebarThreads) {
    if (byId.has(sidebar.threadId)) continue;
    byId.set(sidebar.threadId, {
      id: sidebar.threadId,
      parentThreadId: null,
      title: sidebar.title || sidebar.threadId,
      running: false,
      kind: "codex",
      harness: sidebar.harnessId ?? null,
      updatedAtMs: 0,
    });
  }
  return [...byId.values()];
}

export interface GittreeForest {
  readonly roots: readonly string[];
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly depthOf: ReadonlyMap<string, number>;
  readonly subtreeOf: (id: string) => readonly string[];
}

/** Parent→child forest with cycle guards; unknown parents demote to roots. */
export function buildThreadForest(threads: readonly GittreeThread[]): GittreeForest {
  const ids = new Set(threads.map(thread => thread.id));
  const parentOf = new Map<string, string>();
  for (const thread of threads) {
    const parent = thread.parentThreadId;
    if (parent && parent !== thread.id && ids.has(parent)) parentOf.set(thread.id, parent);
  }
  const depthOf = new Map<string, number>();
  const depth = (id: string): number => {
    const memo = depthOf.get(id);
    if (memo !== undefined) return memo;
    const visiting = new Set<string>([id]);
    let current = parentOf.get(id) ?? null;
    let depthValue = 0;
    while (current) {
      if (visiting.has(current)) {
        depthValue = 0; // cycle: treat as root
        break;
      }
      const memoized = depthOf.get(current);
      if (memoized !== undefined) {
        depthValue += memoized + 1;
        break;
      }
      visiting.add(current);
      depthValue += 1;
      current = parentOf.get(current) ?? null;
    }
    depthOf.set(id, depthValue);
    return depthValue;
  };
  const childrenOf = new Map<string, string[]>();
  for (const thread of threads) childrenOf.set(thread.id, []);
  const roots: string[] = [];
  for (const thread of threads) {
    const parent = parentOf.get(thread.id);
    if (parent) childrenOf.get(parent)?.push(thread.id);
    else roots.push(thread.id);
    depth(thread.id);
  }
  const subtreeOf = (id: string): readonly string[] => {
    const collected: string[] = [];
    const walk = (current: string) => {
      collected.push(current);
      for (const child of childrenOf.get(current) ?? []) walk(child);
    };
    walk(id);
    return collected;
  };
  return { roots, childrenOf, parentOf, depthOf, subtreeOf };
}

/** Snapshot actions worth showing as nodes; message traffic stays in the feed. */
export function projectTeamSnapshots(snapshots: readonly GittreeTeamSnapshot[]): readonly GittreeEvent[] {
  const events: GittreeEvent[] = [];
  for (const snapshot of snapshots) {
    const action = asString(snapshot.action);
    const kind = action ? EVENT_ACTIONS[action] : undefined;
    if (!kind) continue;
    const team = snapshot.team as
      | { members?: unknown; tasks?: unknown; lead_thread_id?: unknown }
      | null
      | undefined;
    const id = asString(snapshot.id) ?? `${action}:${asString(snapshot.at) ?? events.length}`;
    // Prefer per-snapshot team state for assignee→childId accuracy.
    const members = Array.isArray(team?.members) ? (team?.members as GittreeTeamSnapshotTeamMember[]) : [];
    const childByMember = new Map<string, string>();
    for (const member of members) {
      const memberId = asString(member.id);
      const childId = asString(member.childId);
      if (memberId && childId) childByMember.set(memberId, childId);
    }
    // The acting task is the one the action's snapshot shows as in flight or
    // most recently updated; fall back to the last task in the list.
    const tasks = Array.isArray(team?.tasks) ? (team?.tasks as GittreeTeamSnapshotTask[]) : [];
    const focus =
      tasks.find(task => asString(task.assignee) !== null) ?? tasks[tasks.length - 1] ?? null;
    const taskId = focus ? asString(focus.id) : null;
    const assignee = focus ? asString(focus.assignee) : null;
    const threadId = (assignee && childByMember.get(assignee)) || null;
    events.push({
      id,
      kind,
      threadId,
      taskId,
      title: (focus && asString(focus.title)) ?? action ?? "task",
      atMs: asNumber(snapshot.at) ?? 0,
    });
  }
  return events.sort((left, right) => left.atMs - right.atMs);
}

export interface GittreeLayoutNode {
  readonly id: string;
  readonly deps: readonly string[];
  readonly atMs: number;
}

/** Kahn longest-path rows with time/id tiebreaks; cycles resolve append-first. */
export function kahnRows(nodes: readonly GittreeLayoutNode[]): ReadonlyMap<string, number> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const rows = new Map<string, number>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    dependents.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (dep === node.id || !byId.has(dep)) continue;
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      dependents.get(dep)?.push(node.id);
    }
  }
  const compare = (left: string, right: string) =>
    (byId.get(left)?.atMs ?? 0) - (byId.get(right)?.atMs ?? 0) || left.localeCompare(right);
  const ready = nodes
    .filter(node => (indegree.get(node.id) ?? 0) === 0)
    .map(node => node.id)
    .sort(compare);
  const queue = [...ready];
  const queued = new Set(ready);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const own = rows.get(id) ?? 0;
    for (const dependent of dependents.get(id) ?? []) {
      rows.set(dependent, Math.max(rows.get(dependent) ?? 0, own + 1));
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0 && !queued.has(dependent)) {
        queued.add(dependent);
        const insertAt = queue.findIndex(candidate => compare(dependent, candidate) < 0);
        if (insertAt === -1) queue.push(dependent);
        else queue.splice(insertAt, 0, dependent);
      }
    }
    if (!rows.has(id)) rows.set(id, 0);
  }
  // Cycles (shouldn't happen — forest guards): linear append so nothing drops.
  let fallback = Math.max(-1, ...rows.values()) + 1;
  for (const node of nodes) {
    if (!rows.has(node.id)) rows.set(node.id, fallback++);
  }
  return rows;
}

/** Node graph for layout: thread nodes, their chained events, child-after-parent
 * edges, and settle events ordered after the tasks they depend on. */
export function layoutNodes(
  threads: readonly GittreeThread[],
  events: readonly GittreeEvent[],
): { rows: ReadonlyMap<string, number>; nodeIds: readonly string[] } {
  const threadNode = (id: string) => `t:${id}`;
  const eventNode = (id: string) => `e:${id}`;
  const lastEventByTask = new Map<string, { id: string; atMs: number }>();
  for (const event of events) {
    if (!event.taskId) continue;
    const previous = lastEventByTask.get(event.taskId);
    if (!previous || event.atMs >= previous.atMs) lastEventByTask.set(event.taskId, { id: event.id, atMs: event.atMs });
  }
  const nodes: GittreeLayoutNode[] = [];
  const eventsByThread = new Map<string, GittreeEvent[]>();
  for (const thread of threads) nodes.push({ id: threadNode(thread.id), deps: [], atMs: thread.updatedAtMs });
  for (const event of events) {
    if (event.threadId) {
      const chain = eventsByThread.get(event.threadId) ?? [];
      chain.push(event);
      eventsByThread.set(event.threadId, chain);
    }
  }
  for (const [threadId, chain] of eventsByThread) {
    chain.sort((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id));
    let previous: string | null = null;
    for (const event of chain) {
      const deps = [threadNode(threadId)];
      if (previous) deps.push(eventNode(previous));
      nodes.push({ id: eventNode(event.id), deps, atMs: event.atMs });
      previous = event.id;
    }
  }
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    nodes.push({
      id: threadNode(thread.id),
      deps: [threadNode(thread.parentThreadId)],
      atMs: thread.updatedAtMs,
    });
  }
  // A settle event lands after the settle events of the tasks it depended on —
  // the "return nodes order after contributing transitions" rule.
  for (const event of events) {
    if (event.kind !== "settle" || !event.taskId) continue;
    // dependsOn is not carried on the event; conservatively order after the
    // latest earlier settle of any other task on the same parent lane.
    const deps: string[] = [];
    for (const other of events) {
      if (other.id === event.id || other.kind !== "settle" || !other.taskId) continue;
      if (other.taskId !== event.taskId && other.atMs < event.atMs) deps.push(eventNode(other.id));
    }
    const existing = nodes.find(node => node.id === eventNode(event.id));
    if (existing) nodes.push({ id: existing.id, deps: [...existing.deps, ...deps], atMs: existing.atMs });
  }
  // Drop the pre-duplicate entries created just above (keep the last one).
  const deduped = new Map<string, GittreeLayoutNode>();
  for (const node of nodes) deduped.set(node.id, node);
  const rows = kahnRows([...deduped.values()]);
  return { rows, nodeIds: [...deduped.keys()] };
}

/** FNV-1a 32-bit; stable lane colors across sessions and restarts. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export const laneColorFor = (threadId: string): string =>
  `hsl(${fnv1a(threadId) % 360} 68% 47%)`;

export interface GittreeModel {
  readonly threads: readonly GittreeThread[];
  readonly events: readonly GittreeEvent[];
  readonly forest: GittreeForest;
  readonly rows: ReadonlyMap<string, number>;
  readonly laneColor: ReadonlyMap<string, string>;
  /** Focus mode: ids of the current session's subtree, or null for all. */
  readonly focusedIds: ReadonlySet<string> | null;
}

export interface GittreeModelInput {
  readonly threads: readonly GittreeThread[];
  readonly events: readonly GittreeEvent[];
  readonly currentThreadId: string | null;
  readonly focus: boolean;
}

export function buildGittreeModel(input: GittreeModelInput): GittreeModel {
  const forest = buildThreadForest(input.threads);
  const laneColor = new Map<string, string>();
  for (const root of forest.roots) {
    const color = laneColorFor(root);
    for (const id of forest.subtreeOf(root)) laneColor.set(id, color);
  }
  let focusedIds: ReadonlySet<string> | null = null;
  if (input.focus && input.currentThreadId) {
    let root = input.currentThreadId;
    for (let hop = 0; hop < 32; hop += 1) {
      const parent = forest.parentOf.get(root);
      if (!parent) break;
      root = parent;
    }
    focusedIds = new Set(forest.subtreeOf(root));
  }
  const visibleThreads = focusedIds
    ? input.threads.filter(thread => focusedIds.has(thread.id))
    : input.threads;
  const visibleEvents = focusedIds
    ? input.events.filter(event => !event.threadId || focusedIds.has(event.threadId))
    : input.events;
  const { rows } = layoutNodes(visibleThreads, visibleEvents);
  return {
    threads: visibleThreads,
    events: visibleEvents,
    forest,
    rows,
    laneColor,
    focusedIds,
  };
}
