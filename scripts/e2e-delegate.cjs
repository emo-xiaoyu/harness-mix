// 真实跨 Harness 协作自检（会发起真实的子任务模型请求）：
// 父线程 → /delegate 委派子任务到目标 Harness → 等待结算 → 协作工具项回收最终答复。
// 用法：node scripts/e2e-delegate.cjs [--from=pi] [--to=pi]
const { HostRuntime } = require("../src/main/host/runtime");
const os = require("node:os");
const path = require("node:path");

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const from = arg("from", "pi");
const to = arg("to", "pi");

(async () => {
  const rt = new HostRuntime({ dataDirectory: path.join(os.tmpdir(), "hm-e2e-delegate") });
  rt.subscribe((e) => { if (e.type === "toast") console.log("  [toast]", e.text); });
  await rt.initialize();
  if (!rt.status[from]?.available) throw new Error(`父 Harness 不可用：${from}`);
  if (!rt.status[to]?.available) throw new Error(`子 Harness 不可用：${to}`);

  const parent = await rt.createThread({ harnessId: from, cwd: "E:\\harness-mix", title: "E2E 协作" });
  if (parent.status === "error") throw new Error("parent open failed: " + parent.error);
  console.log(`parent: ${parent.id.slice(0, 8)} (${from})`);

  const { child, turn } = await rt.delegateTask({ fromThreadId: parent.id, harnessId: to, task: "只回复两个字：收到" });
  console.log(`child:  ${child.id.slice(0, 8)} (${child.harnessId}) parentThreadId=${child.parentThreadId === parent.id ? "ok" : "MISSING"}`);

  for (let i = 0; i < 180 && rt.execution.isRunning(parent.id); i++) await new Promise((r) => setTimeout(r, 1000));
  const settled = rt.threads.find((t) => t.id === parent.id);
  const items = rt.core.getItemsForTurn(turn.id);
  const tool = items.find((i) => i.type === "tool_call");
  console.log("parent status:", settled.status, "| tool:", tool?.title, "→", tool?.status);
  console.log("tool output:", JSON.stringify(String(tool?.output ?? "").slice(0, 120)));
  const childThread = rt.threads.find((t) => t.id === child.id);
  console.log("child status:", childThread.status, "| child reply:", JSON.stringify(childThread.messages.at(-1)?.text?.slice(0, 60)));
  await rt.close();
  const ok = settled.status === "ready" && tool?.status === "completed" && String(tool?.output ?? "").includes("收到");
  console.log(ok ? "PASS: 委派 → 等待 → 答复回收" : "FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
