import { describe, expect, it } from "vitest";
import {
  buildGittreeModel,
  buildThreadForest,
  fnv1a,
  kahnRows,
  laneColorFor,
  layoutNodes,
  mergeSidebarThreads,
  parseThreadListEntries,
  projectTeamSnapshots,
  type GittreeEvent,
  type GittreeThread,
} from "../src/gittree/model.js";
import { layoutGittreeCanvas } from "../src/gittree/render.js";

const thread = (id: string, parentThreadId: string | null, overrides: Partial<GittreeThread> = {}): GittreeThread => ({
  id,
  parentThreadId,
  title: id,
  running: false,
  kind: "harnessmix",
  harness: null,
  updatedAtMs: 1000,
  ...overrides,
});

describe("gittree thread model", () => {
  it("parses thread/list projections with seconds→ms timestamps", () => {
    const threads = parseThreadListEntries([
      { id: "t1", name: "Lead", status: { type: "active" }, updatedAt: 5, parentThreadId: null },
      { id: "t2", name: "Worker", status: { type: "idle" }, updatedAt: 7, parentThreadId: "t1" },
      { name: "no id" },
      null,
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({ id: "t1", running: true, updatedAtMs: 5000 });
    expect(threads[1]).toMatchObject({ id: "t2", running: false, parentThreadId: "t1" });
  });

  it("merges sidebar codex threads without duplicating managed ones", () => {
    const merged = mergeSidebarThreads(
      [thread("t1", null)],
      [
        { threadId: "t1", title: "managed duplicate", owner: "external" },
        { threadId: "codex-9", title: "官方会话", owner: "codex" },
      ],
    );
    expect(merged.map(item => item.id).sort()).toEqual(["codex-9", "t1"]);
    expect(merged.find(item => item.id === "codex-9")).toMatchObject({ kind: "codex", parentThreadId: null });
    expect(merged.find(item => item.id === "t1")?.kind).toBe("harnessmix");
  });

  it("builds the forest with depths, children and cycle guards", () => {
    const forest = buildThreadForest([
      thread("lead", null),
      thread("w1", "lead"),
      thread("w2", "lead"),
      thread("grand", "w1"),
      thread("ghost", "missing-parent"),
      thread("loopA", "loopB"),
      thread("loopB", "loopA"),
    ]);
    expect(forest.roots).toContain("lead");
    expect(forest.roots).toContain("ghost");
    expect(forest.childrenOf.get("lead")).toEqual(["w1", "w2"]);
    expect(forest.depthOf.get("grand")).toBe(2);
    expect(forest.depthOf.get("loopA")).toBe(0);
    expect(forest.subtreeOf("lead")).toEqual(["lead", "w1", "grand", "w2"]);
  });

  it("projects team snapshots into task events with member threads", () => {
    const events = projectTeamSnapshots([
      {
        id: "s1",
        action: "task_assigned",
        at: 100,
        team: { members: [{ id: "m1", childId: "w1" }], tasks: [{ id: "task-1", title: "调研", assignee: "m1" }] },
      },
      {
        id: "s2",
        action: "task_settled",
        at: 200,
        team: { members: [{ id: "m1", childId: "w1" }], tasks: [{ id: "task-1", title: "调研", assignee: "m1" }] },
      },
      { id: "s3", action: "message_sent", at: 150, team: {} },
    ]);
    expect(events.map(event => event.kind)).toEqual(["spawn", "settle"]);
    expect(events[0]).toMatchObject({ threadId: "w1", taskId: "task-1", atMs: 100 });
  });

  it("orders rows by longest path with time tiebreaks", () => {
    const rows = kahnRows([
      { id: "a", deps: [], atMs: 1 },
      { id: "b", deps: ["a"], atMs: 2 },
      { id: "c", deps: ["a"], atMs: 3 },
      { id: "d", deps: ["b", "c"], atMs: 4 },
    ]);
    expect(rows.get("a")).toBe(0);
    expect(rows.get("b")).toBe(1);
    expect(rows.get("c")).toBe(1);
    expect(rows.get("d")).toBe(2);
    const cycled = kahnRows([
      { id: "x", deps: ["y"], atMs: 1 },
      { id: "y", deps: ["x"], atMs: 2 },
    ]);
    expect(cycled.size).toBe(2);
  });

  it("places settle events after earlier settles of sibling tasks", () => {
    const threads = [thread("lead", null), thread("w1", "lead"), thread("w2", "lead")];
    const events: GittreeEvent[] = [
      { id: "e1", kind: "settle", threadId: "w1", taskId: "task-1", title: "a", atMs: 100 },
      { id: "e2", kind: "settle", threadId: "w2", taskId: "task-2", title: "b", atMs: 200 },
    ];
    const { rows } = layoutNodes(threads, events);
    expect(rows.get("e:e2")!).toBeGreaterThan(rows.get("e:e1")!);
  });

  it("hashes stably and spreads lane colors", () => {
    expect(fnv1a("lead")).toBe(fnv1a("lead"));
    expect(fnv1a("lead")).not.toBe(fnv1a("lead2"));
    expect(laneColorFor("root-1")).toMatch(/^hsl\(\d+ 68% 47%\)$/);
  });

  it("focus mode keeps only the current session subtree", () => {
    const threads = [
      thread("leadA", null),
      thread("w1", "leadA"),
      thread("leadB", null),
      thread("w2", "leadB"),
    ];
    const model = buildGittreeModel({ threads, events: [], currentThreadId: "w1", focus: true });
    expect([...model.focusedIds ?? []].sort()).toEqual(["leadA", "w1"]);
    expect(model.threads.map(item => item.id)).toEqual(["leadA", "w1"]);
    const all = buildGittreeModel({ threads, events: [], currentThreadId: null, focus: false });
    expect(all.threads).toHaveLength(4);
  });
});

describe("gittree canvas layout", () => {
  it("lays out lanes, branch edges and event stubs within bounds", () => {
    const threads = [thread("lead", null), thread("w1", "lead", { running: true })];
    const events: GittreeEvent[] = [
      { id: "e1", kind: "spawn", threadId: "w1", taskId: "t", title: "x", atMs: 1 },
    ];
    const model = buildGittreeModel({ threads, events, currentThreadId: null, focus: false });
    const layout = layoutGittreeCanvas(model);
    const leadBox = layout.geometry.get("t:lead");
    const workerBox = layout.geometry.get("t:w1");
    const eventBox = layout.geometry.get("e:e1");
    expect(leadBox).toBeDefined();
    expect(workerBox).toBeDefined();
    expect(eventBox).toBeDefined();
    if (!leadBox || !workerBox || !eventBox) return;
    // Children sit deeper (right) and later (below) than the parent.
    expect(workerBox.x).toBeGreaterThan(leadBox.x);
    expect(workerBox.y).toBeGreaterThan(leadBox.y);
    expect(eventBox.x).toBeGreaterThan(workerBox.x);
    expect(layout.width).toBeGreaterThanOrEqual(eventBox.x + eventBox.width);
    expect(layout.height).toBeGreaterThanOrEqual(eventBox.y + eventBox.height);
    expect(layout.edges.some(edge => edge.key === "edge:w1")).toBe(true);
    expect(layout.edges.some(edge => edge.key === "stem:e1")).toBe(true);
    expect(layout.laneRails).toHaveLength(1);
  });
});
