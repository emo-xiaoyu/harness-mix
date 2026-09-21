// OpenClaw Gateway 思考流探针：开启 reasoningLevel=stream 后跑一个真实回合，
// 捕获 agent 广播原始帧（重点 stream:"thinking"），为适配器投影与能力声明提供实测证据。
// 用法：node scripts/openclaw-thinking-probe.cjs [modelId]
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { OpenClawGatewayHost } = require("../src/main/adapters/openclaw-gateway");

const OUT_DIR = path.join(__dirname, "..", "output", "openclaw-thinking-probe");

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const host = await OpenClawGatewayHost.acquire((line) => console.error(line));
  const frames = [];
  try {
    const key = `harness-mix-thinking-probe-${Date.now()}`;
    const created = await host.call("sessions.create", { key, label: `Harness Mix thinking probe ${Date.now()}` });
    console.log("sessions.create ->", JSON.stringify(created));
    const sessionKey = created?.key ?? key;

    // 两个独立维度：thinkingLevel 控制推理投入，reasoningLevel=stream 才把思考流广播给客户端
    let patched = null;
    try {
      patched = await host.call("sessions.patch", { key: sessionKey, reasoningLevel: "stream", thinkingLevel: "medium" });
    } catch (error) {
      console.error("sessions.patch FAILED:", error.message, "code=", error.code);
    }
    console.log("sessions.patch ->", JSON.stringify(patched));

    const modelArg = process.argv[2] || undefined;
    if (modelArg) console.log("using model override:", modelArg);

    const unwatch = host.onEvent((frame) => {
      if (frame?.type !== "event" || frame.event !== "agent") return;
      const p = frame.payload ?? {};
      if (p.sessionKey && p.sessionKey !== sessionKey) return;
      frames.push(p);
      const data = p.data ?? {};
      const brief = typeof data.delta === "string" ? data.delta : typeof data.text === "string" ? data.text : "";
      console.log(`[stream=${p.stream}] ${(brief || JSON.stringify(data)).slice(0, 160).replace(/\n/g, "\\n")}`);
    });

    const accepted = await host.call("agent", {
      message: "一个三位数，各位数字之和为 18，百位比个位大 3，且它是 4 的倍数。求这个数，并给出推理过程。",
      sessionKey,
      idempotencyKey: randomUUID(),
      deliver: false,
      thinking: "high",
      ...(modelArg ? { model: modelArg } : {}),
    });
    console.log("agent ->", JSON.stringify(accepted));
    if (!accepted?.runId) throw new Error("未返回 runId");
    const settled = await host.call("agent.wait", { runId: accepted.runId, timeoutMs: 240_000 }, 250_000);
    console.log("agent.wait ->", JSON.stringify(settled));
    unwatch();

    const described = await host.call("sessions.describe", { key: sessionKey }).catch((e) => ({ error: e.message }));
    console.log("sessions.describe ->", JSON.stringify(described?.session ?? described));

    const summary = {};
    for (const f of frames) summary[f.stream] = (summary[f.stream] ?? 0) + 1;
    const hasThinking = frames.some((f) => f.stream === "thinking" && (f.data?.delta || f.data?.text));
    console.log("stream summary ->", JSON.stringify(summary), "thinkingVerified=", hasThinking);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outFile = path.join(OUT_DIR, `thinking-frames-${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ capturedAt: new Date().toISOString(), key, frames, described: described?.session ?? null, summary, hasThinking }, null, 2));
    console.log("saved ->", outFile);
  } finally {
    await OpenClawGatewayHost.release();
  }
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
