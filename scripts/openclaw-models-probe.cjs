// 列出 OpenClaw 模型及其视觉支持标记
const { OpenClawGatewayHost } = require("../src/main/adapters/openclaw-gateway");
(async () => {
  const host = await OpenClawGatewayHost.acquire(() => {});
  try {
    const res = await host.call("models.list", {});
    const models = res?.models ?? res ?? [];
    for (const m of models) {
      console.log(JSON.stringify({ id: m.id ?? m, name: m.name, input: m.input ?? m.modalities ?? m.inputs ?? m.capabilities?.input, vision: m.vision ?? m.supportsImages ?? m.image }));
    }
  } finally { await OpenClawGatewayHost.release(); }
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
