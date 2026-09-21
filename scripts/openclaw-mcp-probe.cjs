// OpenClaw 托管 MCP 对账实测探针：
// 备份 openclaw.json → 推送一个仓库内 stdio MCP 服务器（collaboration-mcp.cjs）→
// 验证 openclaw mcp list / Gateway tools 面能看到 → 移除 → 断言用户键零变化。
// 任何一步异常都会用备份还原配置。
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { OpenClawGatewayHost } = require("../src/main/adapters/openclaw-gateway");
const { applyManagedMcpServers, MCP_OWNED_PREFIX } = require("../src/main/adapters/openclaw");
const { OPENCLAW_CONFIG } = require("../src/main/adapters/openclaw-gateway");
const { cliSpawn } = require("../src/main/host/jsonl");

const OUT_DIR = path.join(__dirname, "..", "output", "openclaw-mcp-probe");
const SERVER = path.join(__dirname, "..", "src", "main", "host", "collaboration-mcp.cjs");

const readCfg = () => JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf8"));
const stripOwned = (servers) => Object.fromEntries(Object.entries(servers ?? {}).filter(([k]) => !k.startsWith(MCP_OWNED_PREFIX)));
// 键序无关的规范化序列化（CLI 规范化会重排键序）；meta.lastTouched* 是 CLI 自维护簿记，不计入
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};
const userViewOf = (cfg) => {
  const { meta, ...rest } = cfg;
  const mcp = { ...rest.mcp, servers: stripOwned(rest.mcp?.servers) };
  // CLI 规范化会删除空的 mcp/servers 键；空对象与键缺失视为等价（不含用户内容）
  if (mcp.servers && Object.keys(mcp.servers).length === 0) delete mcp.servers;
  if (Object.keys(mcp).length === 0) delete rest.mcp; else rest.mcp = mcp;
  return rest;
};
const userView = (cfg) => JSON.stringify(canonical(userViewOf(cfg)));
const diffViews = (beforeStr, nowStr) => {
  const walk = (x, y, p) => {
    for (const k of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
      const q = p ? `${p}.${k}` : k;
      if (JSON.stringify(x?.[k]) !== JSON.stringify(y?.[k])) {
        if (x?.[k] && y?.[k] && typeof x[k] === "object" && typeof y[k] === "object" && !Array.isArray(x[k]) && !Array.isArray(y[k])) walk(x[k], y[k], q);
        else console.error(`USERVIEW DIFF: ${q} | ${JSON.stringify(x?.[k])?.slice(0, 90)} -> ${JSON.stringify(y?.[k])?.slice(0, 90)}`);
      }
    }
  };
  walk(JSON.parse(beforeStr), JSON.parse(nowStr), "");
};
const mcpList = () => {
  const cli = cliSpawn("openclaw", ["mcp", "list", "--json"]);
  return JSON.parse(execFileSync(cli.command, cli.args, { encoding: "utf8", windowsHide: true, timeout: 20000 }));
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const backup = path.join(OUT_DIR, `openclaw.json.backup-${Date.now()}`);
  fs.copyFileSync(OPENCLAW_CONFIG, backup);
  console.log("backup ->", backup);
  const before = userView(readCfg());
  let ok = false;
  try {
    // 1. 推送托管服务器（与适配器 open() 同路径）
    await applyManagedMcpServers([{ name: "probe", command: process.execPath, args: [SERVER], env: {} }], (line) => console.log(line));
    const listed = mcpList();
    console.log("mcp list after push ->", JSON.stringify(Object.keys(listed)));
    if (!listed[MCP_OWNED_PREFIX + "probe"]) throw new Error("自有键未出现在 mcp list");
    const viewNow = userView(readCfg());
    if (viewNow !== before) {
      diffViews(before, viewNow);
      throw new Error("用户键视图发生变化（不应发生）");
    }

    // 2. Gateway 侧确认注册表可读；tools 面尝试 catalog/effective（effective 需要 sessionKey）
    const host = await OpenClawGatewayHost.acquire(() => {});
    try {
      const sessionKey = `harness-mix-mcp-probe-${Date.now()}`;
      await host.call("sessions.create", { key: sessionKey, label: `Harness Mix MCP probe ${Date.now()}` });
      const evidence = {};
      evidence.catalog = await host.call("tools.catalog", {}).catch((e) => ({ error: e.message }));
      evidence.effective = await host.call("tools.effective", { sessionKey }).catch((e) => ({ error: e.message }));
      const text = JSON.stringify(evidence);
      fs.writeFileSync(path.join(OUT_DIR, "tools-evidence.json"), JSON.stringify(evidence, null, 2));
      const hitCount = (text.match(new RegExp(MCP_OWNED_PREFIX + "probe", "g")) || []).length;
      console.log("tools evidence saved; owned-server mentions:", hitCount);
      console.log("effective summary ->", JSON.stringify(evidence.effective).slice(0, 400));
    } finally { await OpenClawGatewayHost.release(); }

    // 3. 移除托管服务器，断言注册表回到初始用户视图
    await applyManagedMcpServers([], (line) => console.log(line));
    const after = mcpList();
    console.log("mcp list after cleanup ->", JSON.stringify(Object.keys(after)));
    if (after[MCP_OWNED_PREFIX + "probe"]) throw new Error("自有键未被移除");
    const finalView = userView(readCfg());
    if (finalView !== before) { diffViews(before, finalView); throw new Error("清理后用户键视图与初始不一致"); }
    ok = true;
    console.log("PROBE OK：推送/注册表可见/清理/用户键零变化 全部通过");
  } finally {
    if (!ok) {
      fs.copyFileSync(backup, OPENCLAW_CONFIG);
      console.error("已用备份还原 openclaw.json");
    }
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
