const { ParityObserver } = require('./support/parity-observer.cjs');
// 真实 Pi 链路自检（会发起一次最小模型请求）
const { HostRuntime } = require("../src/main/host/runtime");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: path.join(os.tmpdir(), "hm-e2e-pi") });
  rt.subscribe((e) => { if (e.type === "toast") console.log("  [toast]", e.text); });
  await rt.initialize();
  const thread = await rt.createThread({ harnessId: "pi", cwd: "E:\\harness-mix", title: "E2E 自检" });
  if (thread.status === "error") throw new Error("open failed: " + thread.error);
  console.log("opened, native session:", thread.nativeSessionId, "| model:", JSON.stringify(thread.model));
  const models = await rt.listModels(thread.id).catch((e) => "listModels: " + e.message);
  console.log("models:", Array.isArray(models) ? `${models.length} 个（首个 ${JSON.stringify(models[0])}）` : models);
  await rt.send(thread.id, "只回复两个字：收到");
  for (let i = 0; i < 90 && rt.threads.find((t) => t.id === thread.id).status === "working"; i++) await new Promise((r) => setTimeout(r, 1000));
  const t = rt.threads.find((t) => t.id === thread.id);
  console.log("status:", t.status, "| assistant:", JSON.stringify(t.messages.at(-1)?.text));
  console.log("usage:", JSON.stringify(t.usage));
  await rt.close();
  process.exit(t.status === "ready" && t.messages.at(-1)?.text ? 0 : 1);
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
