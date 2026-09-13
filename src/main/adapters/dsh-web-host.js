const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { terminateTree } = require("../native/process-utils");

const DSH_ROOT = process.env.HARNESS_MIX_DSH_ROOT || "E:\\dsh\\deepseek-harness";

/**
 * DSH Web Remote 宿主管理器（协议见 packages/api/gateway + client/connection）：
 * - 惰性拉起单个 `dsh web --no-open --port 0` 进程，全部会话共享（引用计数释放）。
 * - 认证：GET /?token → 303 Set-Cookie，之后所有请求原样回放 Cookie（authority 绑定）。
 * - 一元调用：POST /api/<namespace>/<method>，信封 { type:'client-request', rpcId, method, payload:{ args } }。
 * - 流：WS /api/remote.mux，逻辑流帧 { type:'open'|'cancel' } / { type:'item'|'end'|'error' }。
 * - 转发事件：$events 流（emit 通知 + waterfall 请求应答，应答走 POST /api/$events/result）。
 * 信任边界：只发 loopback Host，不发 Origin/sec-fetch-site（DSH 信任栅栏要求）。
 */
class DshWebHost {
  static #shared = null;
  static #refs = 0;
  static #starting = null;
  static #stopping = null;

  /** 获取共享宿主（必要时拉起）。配对调用 release()。 */
  static async acquire(diagnostic = () => {}) {
    if (DshWebHost.#stopping) await DshWebHost.#stopping;
    if (!DshWebHost.#shared && !DshWebHost.#starting) {
      DshWebHost.#starting = (async () => {
        const host = new DshWebHost(diagnostic);
        try { await host.#start(); DshWebHost.#shared = host; }
        catch (error) { await host.stop(); throw error; }
      })().finally(() => { DshWebHost.#starting = null; });
    }
    if (DshWebHost.#starting) await DshWebHost.#starting;
    DshWebHost.#refs++;
    return DshWebHost.#shared;
  }

  static async release() {
    DshWebHost.#refs = Math.max(0, DshWebHost.#refs - 1);
    if (DshWebHost.#refs === 0 && DshWebHost.#shared) {
      const host = DshWebHost.#shared;
      DshWebHost.#shared = null;
      const stopping = host.stop();
      DshWebHost.#stopping = stopping;
      try { await stopping; }
      finally { if (DshWebHost.#stopping === stopping) DshWebHost.#stopping = null; }
    }
  }

  constructor(diagnostic) {
    this.diagnostic = diagnostic;
    this.base = null;
    this.cookie = null;
    this.rpcSeq = 1;
    this.ws = null;
    this.streams = new Map(); // streamId -> { onItem, onEnd, onError }
    this.clientId = null;
    this.eventListeners = new Set(); // $events 帧监听（waterfall/emit）
    this.child = null;
  }

  async #start() {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", "npm.cmd run dsh -- web --no-open --port 0"], {
      cwd: DSH_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) this.diagnostic(`[dsh-web] ${line.slice(0, 240)}`);
    });
    const url = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`dsh web 启动超时：${buf.slice(-300) || "无输出"}`)), 120_000);
      const onData = (chunk) => {
        buf += chunk;
        const match = buf.match(/dsh web: (http:\/\/\S+)/);
        if (match) { clearTimeout(timer); child.stdout.off("data", onData); resolve(match[1]); }
      };
      child.stdout.on("data", onData);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`dsh web 进程退出（${code}）`)); });
    });
    child.stdout.on("data", () => {}); // 持续排空，防止管道写满阻塞
    this.base = new URL(url).origin;

    // 认证交换：GET /?token=… → 303 + Set-Cookie（原样回放，绝不自行构造）
    const res = await fetch(url, { redirect: "manual" });
    const setCookie = res.headers.getSetCookie?.()[0] ?? res.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0];
    if (res.status !== 303 || !cookie) throw new Error(`dsh web 认证失败（HTTP ${res.status}）`);
    this.cookie = cookie;

    // WS mux + $events 流
    await this.#openMux();
    await this.#openEvents();
  }

  async #openMux() {
    const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/api/remote.mux`, { headers: { cookie: this.cookie } });
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("dsh web WebSocket 连接失败"));
    });
    this.ws = ws;
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const stream = this.streams.get(msg.streamId);
      if (!stream) return;
      if (msg.type === "item") stream.onItem?.(msg.value);
      else if (msg.type === "end") stream.onEnd?.();
      else if (msg.type === "error") {
        const error = new Error(msg.error?.message ?? "Remote 流错误");
        error.code = msg.error?.code;
        stream.onError?.(error);
      }
    };
    ws.onclose = () => {
      const error = new Error("dsh web 连接已断开");
      for (const stream of this.streams.values()) stream.onError?.(error);
      this.streams.clear();
      for (const listener of this.eventListeners) listener({ type: "closed" });
    };
  }

  #openEvents() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("$events 流就绪超时")), 30_000);
      this.openStream("$events", {}, {
        onItem: (value) => {
          if (value?.type === "ready") {
            this.clientId = value.clientId;
            clearTimeout(timer);
            resolve();
            return;
          }
          for (const listener of this.eventListeners) listener(value);
        },
        onError: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  /** 一元 Remote 调用 → result.value（业务错误抛出带 code 的 Error） */
  async call(method, args = {}) {
    const res = await fetch(`${this.base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify({ type: "client-request", rpcId: String(this.rpcSeq++), method, payload: { args } }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`dsh web HTTP ${res.status}: ${text.slice(0, 200)}`); }
    const result = body.result ?? body;
    if (result.ok === false) {
      const error = new Error(result.error?.message ?? "Remote 调用失败");
      error.code = result.error?.code;
      throw error;
    }
    return result.value;
  }

  /** 打开逻辑流；返回 cancel()。onItem(value) 逐帧回调。 */
  openStream(endpoint, args, handlers) {
    const streamId = `s${this.rpcSeq++}-${Math.random().toString(36).slice(2, 8)}`;
    this.streams.set(streamId, {
      ...handlers,
      onError: (error) => { this.streams.delete(streamId); handlers.onError?.(error); },
      onEnd: () => { this.streams.delete(streamId); handlers.onEnd?.(); },
    });
    this.ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    return () => {
      this.streams.delete(streamId);
      try { this.ws.send(JSON.stringify({ type: "cancel", streamId })); } catch { /* 已断开 */ }
    };
  }

  /** 订阅 $events 帧（waterfall / emit / closed） */
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 应答 waterfall（审批/提问）：outcome = { kind:'result', value } | { kind:'next' } | { kind:'rejected', error } */
  async answerWaterfall(eventId, outcome) {
    await this.call("$events/result", { clientId: this.clientId, eventId, outcome });
  }

  async stop() {
    for (const listener of this.eventListeners) listener({ type: "closed" });
    this.eventListeners.clear();
    try { this.ws?.close(); } catch { /* 已关闭 */ }
    const child = this.child;
    this.child = null;
    // cmd.exe → npm → node 进程树需要整树终止
    if (child && !child.killed) void terminateTree(child.pid);
  }
}

module.exports = { DshWebHost, DSH_ROOT };
