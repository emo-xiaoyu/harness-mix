const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { terminateTree } = require("../native/process-utils");

const DSH_ROOT = process.env.HARNESS_MIX_DSH_ROOT || null;

let cachedRuntime;
/** 解析 DSH 运行时：monorepo 源码 checkout（scripts.dsh → npm run dsh）或 npm 包（bin.dsh → node bin.js）。
 *  候选顺序：HARNESS_MIX_DSH_ROOT 显式指定（两种布局都接受）> Harness Mix 自带依赖（版本冻结、经过测试）
 *  > 全局 npm 安装（npm root -g 下的 @deepseek-ai/dsh）。 */
function resolveDshRuntime(diagnostic = () => {}) {
  if (cachedRuntime) return cachedRuntime;
  const candidates = [];
  if (DSH_ROOT) candidates.push(DSH_ROOT);
  try {
    candidates.push(path.dirname(require.resolve("@deepseek-ai/dsh/package.json")));
  } catch { /* 自带依赖缺失，继续尝试全局安装 */ }
  try {
    const cmd = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "npm.cmd root -g"]]
      : ["npm", ["root", "-g"]];
    const globalRoot = execFileSync(cmd[0], cmd[1], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
    if (globalRoot) candidates.push(path.join(globalRoot, "@deepseek-ai", "dsh"));
  } catch (error) { diagnostic(`[dsh-web] npm root -g 探测失败：${error.message}`); }
  for (const root of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (typeof pkg.bin?.dsh === "string") { cachedRuntime = { mode: "package", root, bin: path.join(root, pkg.bin.dsh) }; return cachedRuntime; }
      if (typeof pkg.scripts?.dsh === "string") { cachedRuntime = { mode: "checkout", root }; return cachedRuntime; }
    } catch { /* 候选不可用，试下一个 */ }
  }
  throw new Error("未找到 DSH 运行时；可设置 HARNESS_MIX_DSH_ROOT 指向源码仓库或 npm 包目录，或 npm install -g @deepseek-ai/dsh");
}

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
    const runtime = resolveDshRuntime(this.diagnostic);
    let stderrTail = "";
    const tap = (line) => { stderrTail = `${stderrTail}\n${line}`.slice(-2000); this.diagnostic(line); };
    try {
      await this.#bootOnce(runtime, tap);
    } catch (error) {
      // npm 包布局的已知上游问题：web profile 默认 patchReload=live，但 profile 目录里
      // 没有 Cordis HMR 服务，宿主打印 URL 后即崩溃。官方覆盖点是 profile manifest，
      // 改为 startup 后重试一次（仅动 dsh.profile.patchReload 一个字段）。
      const healed = runtime.mode === "package"
        && /requires the Cordis HMR service/.test(stderrTail)
        && this.#healWebProfilePatchReload();
      if (!healed) throw error;
      this.diagnostic("[dsh-web] web profile 缺 HMR 服务导致宿主崩溃，已将 patchReload 改为 startup 并重试");
      if (this.child && !this.child.killed) void terminateTree(this.child.pid);
      this.child = null;
      await this.#bootOnce(runtime, tap);
    }
  }

  /** 上游 @deepseek-ai/dsh npm 包的 web profile manifest 把 patchReload 固化为 live；
   *  HMR 服务不可用时 dsh web 必崩。改为 startup（下次启动生效，语义等价：无热重载）。 */
  #healWebProfilePatchReload() {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
      const manifestPath = path.join(home, "profiles", "web", "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest?.dsh?.profile?.patchReload === "startup") return false;
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, patchReload: "startup" } };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      return true;
    } catch (error) {
      this.diagnostic(`[dsh-web] patchReload 自愈失败：${error.message}`);
      return false;
    }
  }

  async #bootOnce(runtime, tap) {
    const child = runtime.mode === "checkout"
      ? spawn(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32'
        ? ["/d", "/s", "/c", "npm.cmd run dsh -- web --no-open --port 0"] : ['run', 'dsh', '--', 'web', '--no-open', '--port', '0'], {
        cwd: runtime.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      })
      : spawn(process.execPath, [runtime.bin, 'web', '--no-open', '--port', '0'], {
        cwd: runtime.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    this.child = child;
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) tap(line.slice(0, 240));
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

module.exports = { DshWebHost, DSH_ROOT, resolveDshRuntime };
