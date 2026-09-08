const { ParityObserver } = require('./support/parity-observer.cjs');
// §64 验收：真实 Harness 链路 + Protocol Core Shadow（通用版）。
// 用法：node scripts/e2e-shadow.cjs <pi|claude|dsh>
const { HostRuntime } = require("../src/main/host/runtime");
const os = require("node:os");
const path = require("node:path");

const harnessId = process.argv[2];
if (!harnessId) { console.error("usage: node scripts/e2e-shadow.cjs <harnessId>"); process.exit(2); }

(async () => {
  const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: path.join(os.tmpdir(), `hm-e2e-shadow-${harnessId}`) });
  rt.subscribe((e) => { if (e.type === "toast") console.log("  [toast]", e.text); });
  await rt.initialize();
  if (!rt.status[harnessId]?.available) throw new Error(`harness unavailable: ${rt.status[harnessId]?.detail}`);
  const thread = await rt.createThread({ harnessId, cwd: path.resolve(__dirname, ".."), title: "Shadow E2E 自检" });
  if (thread.status === "error") throw new Error("open failed: " + thread.error);
  await rt.send(thread.id, "只回复两个字：收到");
  for (let i = 0; i < 90 && rt.threads.find((t) => t.id === thread.id).status === "working"; i++) await new Promise((r) => setTimeout(r, 1000));
  const t = rt.threads.find((t) => t.id === thread.id);

  // 1) Legacy 路径完全正常
  console.log("[legacy] status:", t.status, "| assistant:", JSON.stringify(t.messages.at(-1)?.text));
  if (t.status !== "ready" || !t.messages.at(-1)?.text) throw new Error("legacy path broken");

  // 2) Core Shadow 快照
  const snap = rt.coreSnapshot();
  const coreThread = snap.threads.find((x) => x.id === thread.id);
  const coreTurn = snap.turns.find((x) => x.threadId === thread.id);
  const items = snap.items.filter((x) => x.turnId === coreTurn?.id);
  const types = [...new Set(items.map((x) => x.type))];
  console.log("[core] thread:", coreThread?.status, "| turn:", coreTurn?.status, "| item types:", types.join(","));
  console.log("[core] agent_message:", JSON.stringify(items.filter((x) => x.type === "agent_message").map((x) => x.content).join("")));

  const problems = [];
  if (!coreThread) problems.push("missing core thread");
  if (coreTurn?.status !== "completed") problems.push(`core turn status=${coreTurn?.status}`);
  if (!items.some((x) => x.type === "user_message")) problems.push("missing user_message item");
  if (!items.some((x) => x.type === "agent_message" && x.content)) problems.push("missing agent_message content");

  // 3) Shadow 对照报告
  const report = rt.shadowReport();
  console.log("[shadow] errors:", JSON.stringify(report.errors), "| warnings:", JSON.stringify(report.warnings));
  console.log("[shadow] mismatches:", JSON.stringify(report.mismatches, null, 2));
  if (report.errors.length) problems.push("shadow internal errors");
  if (report.mismatches.length) problems.push("shadow mismatch");

  await rt.close();
  if (problems.length) { console.error("SHADOW E2E FAILED:", problems.join("; ")); process.exit(1); }
  console.log("SHADOW E2E PASSED");
  process.exit(0);
})().catch((e) => { console.error("SHADOW E2E FAILED:", e.message); process.exit(1); });
