const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

/**
 * JSONL 进程传输层。
 * - 严格 JSONL 分帧：仅以 \n 切分，剥离行尾 \r（Node readline 会把 U+2028/U+2029
 *   当作换行，不符合 Pi RPC 协议要求，这里按规范自行实现）。
 * - 同时支持两种报文形态：
 *   1. Pi 命令式：{ id, type, ... }，响应为 { type: "response", id, success, data|error }
 *   2. JSON-RPC 式：{ jsonrpc, id, method, params }（DSH/ACP），包括 Agent → Client 的请求
 */
class JsonlProcess {
  constructor(command, args, options, hooks) {
    this.pending = new Map();
    this.nextId = 1;
    this.hooks = hooks;
    this.child = spawn(command, args, { windowsHide: true, ...options, stdio: ["pipe", "pipe", "pipe"] });
    this.#attachReader(this.child.stdout, (line) => this.#dispatch(line));
    this.#attachReader(this.child.stderr, (line) => hooks.onDiagnostic?.(line));
    this.child.on("error", (error) => this.#failAll(error));
    this.child.on("exit", (code, signal) => this.#failAll(new Error(`Harness 进程已退出 (${code ?? signal ?? "unknown"})`)));
  }

  #attachReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim()) onLine(line);
      }
    });
    stream.on("end", () => {
      buffer += decoder.end();
      if (buffer.trim()) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
  }

  #dispatch(line) {
    let value;
    try { value = JSON.parse(line); }
    catch { this.hooks.onDiagnostic?.(`Non-JSON stdout: ${line.slice(0, 500)}`); return; }
    // Agent → Client 请求（JSON-RPC，带 method 和 id），需要回复
    if (value.method !== undefined && value.id !== undefined) {
      Promise.resolve()
        .then(() => {
          if (!this.hooks.onRequest) throw new Error(`Unsupported native client request: ${value.method}`);
          return this.hooks.onRequest(value);
        })
        .then((result) => this.#write({ jsonrpc: "2.0", id: value.id, result: result ?? {} }))
        .catch((error) => this.#write({ jsonrpc: "2.0", id: value.id, error: { code: -32603, message: error.message } }));
      return;
    }
    // 命令响应（id 匹配 pending）
    if (value.id !== undefined && this.pending.has(value.id)) {
      const { resolve, reject } = this.pending.get(value.id);
      this.pending.delete(value.id);
      if (value.error || value.success === false) {
        reject(new Error(typeof value.error === "string" ? value.error : value.error?.message || "Harness 请求失败"));
      } else {
        resolve(value.result ?? value.data ?? value);
      }
      return;
    }
    // 普通事件 / 通知
    this.hooks.onEvent?.(value);
  }

  #write(payload) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /** JSON-RPC 请求（DSH/ACP） */
  request(method, params) {
    const id = this.nextId++;
    this.#write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** JSON-RPC 通知（无响应） */
  notify(method, params) { this.#write({ jsonrpc: "2.0", method, params }); }

  /** Pi 命令式请求 */
  command(payload) {
    const id = String(this.nextId++);
    this.#write({ id, ...payload });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** 回复 Agent → Client 请求之外的自由格式报文（如 Pi extension_ui_response） */
  send(payload) { this.#write(payload); }

  stop() { try { this.child.kill(); } catch { /* already gone */ } }

  #failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.hooks.onExit?.(error);
  }
}

/** 跨平台 CLI 启动：Windows 上 .cmd  shim 需要经 cmd.exe 执行 */
function cliSpawn(bin, args) {
  if (process.platform === "win32") {
    const safe = [`${bin}.cmd`, ...args.map(String)].map((a) => (/[&|<>^%"]/.test(a) ? `"${a.replace(/["&|<>^%]/g, "")}"` : a.includes(" ") ? `"${a}"` : a));
    return { command: "cmd.exe", args: ["/d", "/s", "/c", safe.join(" ")] };
  }
  return { command: bin, args: args.map(String) };
}

module.exports = { JsonlProcess, cliSpawn };
