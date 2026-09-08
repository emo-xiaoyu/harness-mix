const { ParityObserver } = require('./support/parity-observer.cjs');
// 真实 DSH(ACP) 链路自检（会发起一次最小模型请求；DSH 启动较慢，耐心等）
const { HostRuntime } = require("../src/main/host/runtime");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: path.join(os.tmpdir(), "hm-e2e-dsh") });
  rt.subscribe((e) => { if (e.type === "toast") console.log("  [toast]", e.text.slice(0, 200)); });
  await rt.initialize();
  const t0 = Date.now();
  const thread = await rt.createThread({ harnessId: "dsh", cwd: "E:\\harness-mix", title: "DSH E2E 自检" });
  console.log(`open 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (thread.status === "error") throw new Error("open failed: " + thread.error);
  console.log("opened, native session:", thread.nativeSessionId, "| models:", JSON.stringify(thread.models?.slice(0, 3)), "| current:", JSON.stringify(thread.model));
  await rt.send(thread.id, "只回复两个字：收到");
  for (let i = 0; i < 120 && rt.threads.find((t) => t.id === thread.id).status === "working"; i++) await new Promise((r) => setTimeout(r, 1000));
  const t = rt.threads.find((t) => t.id === thread.id);
  console.log("status:", t.status, "| assistant:", JSON.stringify(t.messages.at(-1)?.text));
  console.log("usage:", JSON.stringify(t.usage));
  await rt.close();
  process.exit(t.status === "ready" && t.messages.at(-1)?.text ? 0 : 1);
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
