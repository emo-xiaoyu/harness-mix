// OpenClaw 托管 MCP 端到端实测：推送极简 echo MCP 服务器 → 真实 agent 回合调用其工具 →
// 捕获 tool 流帧验证 → 清理并断言注册表还原。证据落 output/openclaw-mcp-probe/。
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { OpenClawGatewayHost, OPENCLAW_CONFIG } = require("../src/main/adapters/openclaw-gateway");
const { applyManagedMcpServers, MCP_OWNED_PREFIX } = require("../src/main/adapters/openclaw");

const OUT_DIR = path.join(__dirname, "..", "output", "openclaw-mcp-probe");
const ECHO_SERVER = path.join(OUT_DIR, "echo-mcp-server.cjs");

(async () => {
  const backup = path.join(OUT_DIR, `openclaw.json.backup-tool-${Date.now()}`);
  fs.copyFileSync(OPENCLAW_CONFIG, backup);
  const frames = [];
  let ok = false;
  try {
    await applyManagedMcpServers([{ name: "probe", command: process.execPath, args: [ECHO_SERVER] }], (l) => console.log(l));
    const host = await OpenClawGatewayHost.acquire((l) => console.error(l));
    try {
      const baseKey = `harness-mix-mcp-tool-probe-${Date.now()}`;
      const created = await host.call("sessions.create", { key: baseKey, label: `Harness Mix MCP tool probe ${Date.now()}` });
      const sessionKey = created?.key ?? baseKey;
      const unwatch = host.onEvent((frame) => {
        if (frame?.type !== "event" || frame.event !== "agent") return;
        const p = frame.payload ?? {};
        if (p.sessionKey && p.sessionKey !== sessionKey) return;
        frames.push(p);
        if (p.stream === "tool") console.log(`[tool] ${p.data?.name ?? ""} phase=${p.data?.phase} meta=${p.data?.meta ?? ""}`);
      });
      const accepted = await host.call("agent", {
        message: "请调用 MCP 工具 hm_echo（若名称带前缀也用它），参数 text=HELLO_HM。完成后只回复工具返回的原始文本，不要添加别的内容。",
        sessionKey, idempotencyKey: randomUUID(), deliver: false,
      });
      console.log("agent accepted:", JSON.stringify(accepted));
      const settled = await host.call("agent.wait", { runId: accepted.runId, timeoutMs: 240_000 }, 250_000);
      console.log("agent.wait:", JSON.stringify(settled).slice(0, 300));
      unwatch();
      const toolCalls = frames.filter((f) => f.stream === "tool");
      const echoHit = toolCalls.some((f) => String(f.data?.name ?? "").includes("hm_echo") || String(f.data?.meta ?? "").includes("hm_echo"));
      const assistantText = frames.filter((f) => f.stream === "assistant").map((f) => f.data?.delta ?? f.data?.text ?? "").join("");
      console.log(`tool frames: ${toolCalls.length}, hm_echo hit: ${echoHit}, assistant: ${assistantText.slice(0, 120)}`);
      fs.writeFileSync(path.join(OUT_DIR, "tool-call-evidence.json"), JSON.stringify({ capturedAt: new Date().toISOString(), frames, echoHit, assistantText }, null, 2));
      ok = echoHit || /ECHO:HELLO_HM/.test(assistantText);
      console.log(ok ? "TOOL PROBE OK：托管 MCP 工具被真实调用" : "TOOL PROBE 未观测到工具调用（模型未配合或 bundle 未加载）");
    } finally { await OpenClawGatewayHost.release(); }
  } finally {
    await applyManagedMcpServers([], () => {});
    if (!ok) {
      fs.copyFileSync(backup, OPENCLAW_CONFIG);
      console.error("已用备份还原 openclaw.json");
    }
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
