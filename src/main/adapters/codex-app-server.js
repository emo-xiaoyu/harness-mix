const { JsonlProcess, cliSpawn } = require('../host/jsonl');

const shared = new Map();

// codex 拒绝在缺失的 CODEX_HOME 下启动、或握手被外部因素（杀软扫描/磁盘/版本握手）挂住时，
// initialize 永不返回。没有这个上限，thread/start 会永久 pending，Desktop 端表现为
// 新对话"一直在执行"却没有会话产生。测试可用 env 覆盖。
function handshakeTimeoutMs() {
  const raw = Number(process.env.HARNESS_MIX_CODEX_HANDSHAKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : 20_000;
}

/**
 * A single native Codex app-server connection shared by every Codex thread.
 * app-server owns thread/session persistence; this class only routes JSON-RPC
 * traffic to the Adapter session that registered the native thread id.
 */
class CodexAppServer {
  constructor(diagnostic, codexHome) {
    this.refs = 0;
    this.routes = new Map();
    this.notifications = new Set();
    this.diagnostics = new Set(diagnostic ? [diagnostic] : []);
    this.closed = false;
    this.codexHome = codexHome ? require('node:path').resolve(codexHome) : null;
    // The Desktop-bundled CLI and the PATH CLI can be different versions.
    const executable = process.env.HARNESS_MIX_CODEX_EXECUTABLE || process.env.HARNESSMIX_STOCK_CODEX_PATH;
    const { command, args } = executable ? { command: executable, args: ['app-server', '--listen', 'stdio://'] } : cliSpawn('codex', ['app-server', '--stdio']);
    const env = { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) };
    this.process = new JsonlProcess(command, args, { env }, {
      onEvent: (message) => this.#notification(message),
      onRequest: (message) => this.#request(message),
      onDiagnostic: (line) => this.#diagnostic(line),
      onExit: (error) => this.#exit(error),
    });
    let rejectHandshake;
    const handshakeGuard = new Promise((_unused, reject) => { rejectHandshake = reject; });
    const handshakeTimer = setTimeout(() => {
      this.stop();
      rejectHandshake(new Error(`Codex app-server 未在 ${Math.round(handshakeTimeoutMs() / 1000)} 秒内完成初始化握手，已终止进程`));
    }, handshakeTimeoutMs());
    handshakeTimer.unref?.();
    this.ready = Promise.race([
      this.process.request('initialize', {
        clientInfo: { name: 'harness-mix', title: 'Harness Mix', version: '0.1.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      }).then((result) => {
        this.process.notify('initialized', {});
        return result;
      }),
      handshakeGuard,
    ]).finally(() => clearTimeout(handshakeTimer));
  }

  static async acquire(diagnostic, codexHome) {
    const key = codexHome ? require('node:path').resolve(codexHome).toLowerCase() : '<default>';
    let server = shared.get(key);
    if (!server || server.closed) {
      server = new CodexAppServer(diagnostic, codexHome);
      server.sharedKey = key;
      shared.set(key, server);
    } else if (diagnostic) server.diagnostics.add(diagnostic);
    server.refs++;
    try {
      await server.ready;
      return server;
    } catch (error) {
      server.refs--;
      if (server.refs === 0) server.stop();
      throw error;
    }
  }

  retain() {
    if (this.closed) throw new Error('Codex app-server 已关闭');
    this.refs++;
    return this;
  }

  watch(threadId, handlers) {
    this.routes.set(threadId, handlers);
    return () => {
      if (this.routes.get(threadId) === handlers) this.routes.delete(threadId);
    };
  }

  request(method, params) { return this.process.request(method, params); }

  onNotification(listener) { this.notifications.add(listener); return () => this.notifications.delete(listener); }

  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) this.stop();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.routes.clear();
    this.notifications.clear();
    this.process.stop();
    if (this.sharedKey && shared.get(this.sharedKey) === this) shared.delete(this.sharedKey);
  }

  #route(message) {
    const threadId = message?.params?.threadId ?? message?.params?.thread?.id;
    return threadId ? this.routes.get(threadId) : undefined;
  }

  #notification(message) {
    for (const listener of this.notifications) listener(message);
    const route = this.#route(message);
    if (route) route.onEvent?.(message);
    else if (message?.method === 'warning' || message?.method === 'configWarning') {
      this.#diagnostic(message.params?.message ?? JSON.stringify(message.params));
    }
  }

  #request(message) {
    if (message.method === 'currentTime/read') {
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    }
    const route = this.#route(message);
    if (!route?.onRequest) throw new Error(`没有可处理 ${message.method} 的 Codex 任务`);
    return route.onRequest(message);
  }

  #diagnostic(line) {
    for (const listener of this.diagnostics) listener(String(line));
  }

  #exit(error) {
    this.closed = true;
    for (const route of this.routes.values()) route.onExit?.(error);
    this.routes.clear();
    if (this.sharedKey && shared.get(this.sharedKey) === this) shared.delete(this.sharedKey);
  }
}

module.exports = { CodexAppServer };
