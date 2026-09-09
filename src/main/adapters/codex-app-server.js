const { JsonlProcess, cliSpawn } = require('../host/jsonl');

let shared;

/**
 * A single native Codex app-server connection shared by every Codex thread.
 * app-server owns thread/session persistence; this class only routes JSON-RPC
 * traffic to the Adapter session that registered the native thread id.
 */
class CodexAppServer {
  constructor(diagnostic) {
    this.refs = 0;
    this.routes = new Map();
    this.notifications = new Set();
    this.diagnostics = new Set(diagnostic ? [diagnostic] : []);
    this.closed = false;
    const { command, args } = cliSpawn('codex', ['app-server', '--stdio']);
    this.process = new JsonlProcess(command, args, {}, {
      onEvent: (message) => this.#notification(message),
      onRequest: (message) => this.#request(message),
      onDiagnostic: (line) => this.#diagnostic(line),
      onExit: (error) => this.#exit(error),
    });
    this.ready = this.process.request('initialize', {
      clientInfo: { name: 'harness-mix', title: 'Harness Mix', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    }).then((result) => {
      this.process.notify('initialized', {});
      return result;
    });
  }

  static async acquire(diagnostic) {
    if (!shared || shared.closed) shared = new CodexAppServer(diagnostic);
    else if (diagnostic) shared.diagnostics.add(diagnostic);
    shared.refs++;
    try {
      await shared.ready;
      return shared;
    } catch (error) {
      shared.refs--;
      if (shared.refs === 0) shared.stop();
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
    if (shared === this) shared = undefined;
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
    if (shared === this) shared = undefined;
  }
}

module.exports = { CodexAppServer };
