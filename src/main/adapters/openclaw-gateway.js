const { spawn } = require("node:child_process");
const { promises: fs } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cliSpawn } = require("../host/jsonl");
const { terminateTree } = require("../native/process-utils");

const OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_PORT = 18789;
// 与本机 2026.5.x Gateway 实测协商通过（protocol 4）；范围放宽交给服务端裁决
const PROTOCOL_MIN = 1;
const PROTOCOL_MAX = 10;
const CLIENT_INFO = { id: "gateway-client", version: "0.1.0", mode: "backend" };
// approvals 事件需要 operator.approvals；模型覆盖（agent 的 model 参数）需要 operator.admin
const SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];
const CAPS = ["tool-events"];

/**
 * 读取本机 OpenClaw Gateway 连接参数。
 * 信任边界：token 只在内存中用于 loopback 握手（与官方 CLI 一致），不持久化、不外发、不写日志。
 */
async function readGatewayConfig() {
  const raw = await fs.readFile(OPENCLAW_CONFIG, "utf8");
  const cfg = JSON.parse(raw);
  const auth = cfg?.gateway?.auth ?? {};
  const token = typeof auth.token === "string" && auth.token ? auth.token : null;
  if ((auth.mode ?? "token") === "token" && !token) throw new Error("OpenClaw Gateway 为 token 认证但配置中缺少 token");
  const port = Number.isInteger(cfg?.gateway?.port) ? cfg.gateway.port : DEFAULT_PORT;
  return { token, port, url: `ws://127.0.0.1:${port}` };
}

/**
 * OpenClaw Gateway 共享宿主（协议见 docs.openclaw.ai/gateway/protocol，已按 2026.5.12 实测校准）：
 * - 帧：{type:'req',id,method,params} → {type:'res',id,ok,payload|error}；广播 {type:'event',event,payload,seq?}。
 * - 握手：连接后服务端先发 connect.challenge；token 认证直接发 connect（challenge 仅设备签名需要）。
 * - 惰性拉起：优先连接已运行的 Gateway（每机一个，归用户所有）；未运行才 spawn `openclaw gateway`，
 *   且仅当子进程由本宿主拉起时才随释放终止。
 */
class OpenClawGatewayHost {
  static #shared = null;
  static #refs = 0;
  static #starting = null;
  static #stopping = null;

  /** 获取共享宿主（必要时连接/拉起）。配对调用 release()。autostart:false 时只连已有 Gateway。 */
  static async acquire(diagnostic = () => {}, { autostart = true } = {}) {
    if (OpenClawGatewayHost.#stopping) await OpenClawGatewayHost.#stopping;
    if (!OpenClawGatewayHost.#shared && !OpenClawGatewayHost.#starting) {
      OpenClawGatewayHost.#starting = (async () => {
        const host = new OpenClawGatewayHost(diagnostic);
        try { await host.#start(autostart); OpenClawGatewayHost.#shared = host; }
        catch (error) { await host.stop(); throw error; }
      })().finally(() => { OpenClawGatewayHost.#starting = null; });
    }
    if (OpenClawGatewayHost.#starting) await OpenClawGatewayHost.#starting;
    OpenClawGatewayHost.#refs++;
    return OpenClawGatewayHost.#shared;
  }

  static async release() {
    OpenClawGatewayHost.#refs = Math.max(0, OpenClawGatewayHost.#refs - 1);
    if (OpenClawGatewayHost.#refs === 0 && OpenClawGatewayHost.#shared) {
      const host = OpenClawGatewayHost.#shared;
      OpenClawGatewayHost.#shared = null;
      const stopping = host.stop();
      OpenClawGatewayHost.#stopping = stopping;
      try { await stopping; }
      finally { if (OpenClawGatewayHost.#stopping === stopping) OpenClawGatewayHost.#stopping = null; }
    }
  }

  constructor(diagnostic) {
    this.diagnostic = diagnostic;
    this.config = null;      // { token, port, url }
    this.hello = null;       // hello-ok payload（features/snapshot/policy/auth）
    this.ws = null;
    this.rpcSeq = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.eventListeners = new Set();
    this.child = null;        // 仅当 Gateway 由本宿主拉起时非空
  }

  async #start(autostart) {
    this.config = await readGatewayConfig();
    try {
      await this.#connect();
      return;
    } catch (error) {
      if (!autostart) throw error;
      this.diagnostic(`[openclaw] 未连接到运行中的 Gateway（${error.message}），尝试拉起本地 Gateway`);
    }
    await this.#spawnGateway();
    await this.#connect();
  }

  /** 拉起本机 Gateway（loopback），等待 WS 就绪。每机只允许一个 Gateway，端口占用时直接复用。 */
  async #spawnGateway() {
    const cli = cliSpawn("openclaw", ["gateway"]);
    const child = spawn(cli.command, cli.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", () => {}); // 持续排空，防止管道写满阻塞
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) this.diagnostic(`[openclaw-gateway] ${line.slice(0, 240)}`);
    });
    child.on("exit", () => { if (this.child === child) this.child = null; });
    this.child = child;
    const deadline = Date.now() + 90_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await this.#connect();
        return;
      } catch (error) {
        lastError = error;
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error(`OpenClaw Gateway 启动后仍无法连接：${lastError?.message ?? "未知错误"}`);
  }

  /** 建立 WS 并完成 connect 握手（hello-ok）。 */
  async #connect() {
    const ws = new WebSocket(this.config.url);
    this.ws = ws;
    ws.onmessage = (event) => this.#onFrame(event);
    ws.onclose = () => this.#onClosed();
    ws.onerror = () => {};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket 连接超时")), 10_000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket 连接失败")); };
    });
    const hello = await this.call("connect", {
      minProtocol: PROTOCOL_MIN,
      maxProtocol: PROTOCOL_MAX,
      client: { ...CLIENT_INFO, platform: process.platform },
      role: "operator",
      scopes: SCOPES,
      caps: CAPS,
      commands: [],
      permissions: {},
      ...(this.config.token ? { auth: { token: this.config.token } } : {}),
      locale: "zh-CN",
    });
    if (hello?.type !== "hello-ok") throw new Error("Gateway 握手未返回 hello-ok");
    this.hello = hello;
    this.diagnostic(`[openclaw] Gateway 已连接（协议 ${hello.protocol}，服务 ${hello.server?.version ?? "unknown"}）`);
  }

  #onFrame(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "res") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.payload);
      else {
        const error = new Error(msg.error?.message ?? "Gateway 调用失败");
        error.code = msg.error?.code;
        pending.reject(error);
      }
      return;
    }
    if (msg.type === "event") {
      for (const listener of this.eventListeners) listener(msg);
    }
  }

  #onClosed() {
    const error = new Error("OpenClaw Gateway 连接已断开");
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.eventListeners) listener({ type: "closed" });
  }

  /** 一元 Gateway RPC → payload（业务错误抛出带 code 的 Error）。 */
  call(method, params = {}, timeoutMs = 30_000) {
    const id = `hm-${this.rpcSeq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 调用超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ type: "req", id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  /** 订阅广播事件帧（agent / exec.approval.* / closed 等）。 */
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async stop() {
    for (const listener of this.eventListeners) listener({ type: "closed" });
    this.eventListeners.clear();
    try { this.ws?.close(); } catch { /* 已关闭 */ }
    this.ws = null;
    // 仅终止由本宿主拉起的 Gateway；用户自有的 Gateway 服务保持运行
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) void terminateTree(child.pid);
  }
}

module.exports = { OpenClawGatewayHost, readGatewayConfig, OPENCLAW_CONFIG, DEFAULT_PORT };
