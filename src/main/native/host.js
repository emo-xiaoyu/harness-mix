const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { HostRuntime } = require('../host/runtime');
const { CodexAppServer } = require('../adapters/codex-app-server');
const { NativeProtocol } = require('./protocol');
const { mergeThreadPage } = require('./thread-list');
const { projectIdsForThread } = require('./codex-projects');
const { terminateTree } = require('./process-utils');
const { redact } = require('./redact');
const { installCollaborationSkills } = require('../host/collaboration-skill');
const { dataDirectory } = require('./platform');

async function runNativeHost() {
  const sidecar = process.env.HARNESSMIX_SIDECAR === '1';
  const stock = process.env.HARNESSMIX_STOCK_CODEX_PATH;
  if (!stock || !fs.existsSync(stock)) throw new Error('Official Codex CLI path is missing');
  const directory = path.join(dataDirectory(), 'mix-core');
  const trafficLog = path.join(path.dirname(directory), 'host-traffic.jsonl');
  const slim = value => {
    if (typeof value === 'string') return value.length > 1500 ? `${value.slice(0, 1500)}…[${value.length}]` : value;
    if (Array.isArray(value)) return value.map(slim);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, slim(v)]));
    return value;
  };
  // Keep the debug journal bounded (5MB × 3) and free of credential-looking text.
  const rotateTraffic = () => {
    try {
      if (!fs.existsSync(trafficLog) || fs.statSync(trafficLog).size < 5 * 1024 * 1024) return;
      fs.rmSync(`${trafficLog}.2`, { force: true });
      if (fs.existsSync(`${trafficLog}.1`)) fs.renameSync(`${trafficLog}.1`, `${trafficLog}.2`);
      fs.renameSync(trafficLog, `${trafficLog}.1`);
    } catch { /* best-effort */ }
  };
  const traffic = (kind, message) => {
    try { fs.appendFileSync(trafficLog, JSON.stringify({ ts: Date.now(), pid: process.pid, kind, message: redact(slim(message)) }) + '\n'); } catch {}
  };
  const runtime = new HostRuntime({ dataDirectory: directory });
  // Heartbeat: lets the launcher tell a live instance from leftovers, and gives
  // crash recovery a timestamp to reason about.
  const startedAt = Date.now();
  const instanceFile = path.join(path.dirname(directory), 'runtime', 'instance.json');
  const writeInstance = () => {
    try {
      rotateTraffic();
      fs.mkdirSync(path.dirname(instanceFile), { recursive: true });
      fs.writeFileSync(`${instanceFile}.tmp`, JSON.stringify({ pid: process.pid, version: process.env.HARNESS_MIX_VERSION || null, startedAt, beatAt: Date.now(), mode: 'native-host' }));
      fs.renameSync(`${instanceFile}.tmp`, instanceFile);
    } catch { /* heartbeat is best-effort */ }
  };
  writeInstance();
  const heartbeat = setInterval(writeInstance, 5000);
  if (heartbeat.unref) heartbeat.unref();
  const writeCrash = (kind, error) => {
    try {
      fs.writeFileSync(path.join(path.dirname(instanceFile), `crash-${Date.now()}.json`), JSON.stringify({
        kind, pid: process.pid, version: process.env.HARNESS_MIX_VERSION || null, at: Date.now(),
        message: String((error && error.message) || error), stack: String((error && error.stack) || ''),
      }, null, 2));
    } catch { /* diagnostics are best-effort */ }
  };
  process.on('uncaughtException', error => {
    writeCrash('uncaughtException', error);
    const bail = setTimeout(() => process.exit(1), 3000);
    if (bail.unref) bail.unref();
    void close().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', reason => writeCrash('unhandledRejection', reason));
  process.on('SIGBREAK', () => void close());
  // 受管协作技能播种（best-effort）：给有原生 skill 系统的 harness 种 CLI 用法指南；
  // 用户改过的副本标记 conflict 后跳过，不影响宿主启动
  const seededSkills = await installCollaborationSkills().catch(error => {
    traffic('skill-seed', `collaboration skill seeding failed: ${error.message}`);
    return [];
  });
  for (const result of seededSkills) traffic('skill-seed', `${result.status} ${result.path}`);
  const ready = runtime.initialize();
  const write = message => { traffic('out', message); process.stdout.write(`${JSON.stringify(message)}\n`); };
  const internal = new Map();
  let internalId = 0;
  let queryServer = null;
  let queryServerPromise = null;
  let unwatchQueryServer = null;
  let queryIdleTimer = null;
  let queryRequests = 0;
  let loginUntil = 0;
  const releaseQueryServer = (force = false) => {
    if (queryRequests > 0 && !force) return;
    clearTimeout(queryIdleTimer);
    queryIdleTimer = null;
    unwatchQueryServer?.();
    unwatchQueryServer = null;
    queryServer?.release();
    queryServer = null;
    queryServerPromise = null;
  };
  const scheduleQueryRelease = () => {
    if (!queryServer || queryRequests > 0) return;
    clearTimeout(queryIdleTimer);
    const delay = loginUntil > Date.now() ? loginUntil - Date.now() : 15_000;
    queryIdleTimer = setTimeout(releaseQueryServer, delay);
    queryIdleTimer.unref?.();
  };
  const acquireQueryServer = () => {
    if (!queryServerPromise || queryServer?.closed) {
      queryServerPromise = CodexAppServer.acquire().then(server => {
        queryServer = server;
        unwatchQueryServer = server.onNotification(message => {
          if (message?.method !== 'account/login/completed') return;
          loginUntil = 0;
          write(message);
          scheduleQueryRelease();
        });
        return server;
      }).catch(error => { queryServerPromise = null; throw error; });
    }
    return queryServerPromise;
  };
  const requestOfficial = (method, params) => {
    if (sidecar) return (async () => {
      clearTimeout(queryIdleTimer);
      queryIdleTimer = null;
      queryRequests++;
      try {
        const server = await acquireQueryServer();
        const result = await server.request(method, params);
        if (method === 'account/login/start' && result?.loginId) loginUntil = Date.now() + 5 * 60_000;
        if (method === 'account/login/cancel' || method === 'account/logout') loginUntil = 0;
        return result;
      } finally {
        queryRequests--;
        scheduleQueryRelease();
      }
    })();
    return new Promise((resolve, reject) => {
      const id = `harness-mix:internal:${++internalId}`;
      const timer = setTimeout(() => { internal.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
      internal.set(id, { resolve, reject, timer });
      official.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const protocol = new NativeProtocol(runtime, write, requestOfficial);
  const env = { ...process.env };
  delete env.CODEX_CLI_PATH;
  // Forward the Desktop's original CLI arguments (the shim preserves them in argv):
  // -c overrides such as features.* and mcp_servers.codex_app must reach the stock
  // app-server, otherwise per-thread configs referencing them fail config loading.
  const passthrough = process.argv.slice(2);
  const officialArgs = passthrough.includes('--listen') ? passthrough : [...passthrough, '--listen', 'stdio://'];
  const official = sidecar ? null : spawn(stock, officialArgs, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  // official 异常退出后迟到的 stdin.write 会异步抛 EPIPE，无监听即 crash 宿主；退出由 close() 路径处理
  official?.stdin.on('error', () => {});
  const forwarded = new Map();
  const lines = official ? readline.createInterface({ input: official.stdout }) : null;
  lines?.on('line', line => {
    try {
      const value = JSON.parse(line);
      const pending = internal.get(value.id);
      if (pending) {
        internal.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error(value.error.message));
        else pending.resolve(value.result);
        return;
      }
      const request = forwarded.get(value.id);
      if (request) {
        forwarded.delete(value.id);
        if (value.error) traffic('official-error', { method: request.method, error: value.error });
        if (request.method === 'thread/list' && value.result?.data && !request.params?.cursor) {
          value.result = mergeThreadPage(value.result, runtime.threads, request.params || {}, t => protocol.projectThread(t, false), projectIdsForThread);
        }
      }
      write(value);
    } catch (error) { console.error('[Harness Mix protocol]', error.message); }
  });
  const input = readline.createInterface({ input: process.stdin });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    try { fs.rmSync(instanceFile, { force: true }); } catch { /* already gone */ }
    input.close(); protocol.close();
    for (const pending of internal.values()) { clearTimeout(pending.timer); pending.reject(new Error('Native host closed')); }
    internal.clear();
    clearTimeout(queryIdleTimer);
    if (queryServerPromise) await queryServerPromise.catch(() => null);
    releaseQueryServer(true);
    await ready.catch(() => {});
    await runtime.close();
    if (official) {
      official.stdin.end();
      const timer = setTimeout(() => { void terminateTree(official.pid); }, 2000); timer.unref();
    }
  }
  input.on('line', line => {
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        traffic('in', message);
        if (!message.method) {
          if (String(message.id).startsWith('harness-mix:approval:')) { await ready; await protocol.respond(message); return; }
        } else if (message.id !== undefined && message.method !== 'initialize') {
          await ready;
          const result = await protocol.request(message.method, message.params);
          if (result !== undefined) { write({ id: message.id, result }); return; }
        }
        if (sidecar) {
          if (message.id !== undefined && message.method) {
            write({ id: message.id, error: { code: -32601, message: `${message.method} belongs to the stock Desktop app-server` } });
          }
          return;
        }
        if (message.id !== undefined && message.method) { forwarded.set(message.id, message); traffic('forward', message); }
        official.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        if (message?.method && message.id !== undefined) write({ id: message.id, error: { code: -32603, message: error.message } });
        else console.error('[Harness Mix host]', error.message);
      }
    })();
  });
  input.on('close', () => void close());
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  official?.on('error', error => { console.error(error); void close(); });
  official?.on('exit', () => { void close(); });
  await ready;
  // 线程索引加载完成后补发持久化外部线程的 thread/started：转正重发修复上线前
  // 创建的会话没有这条宣告，Desktop 重启后侧栏 state db 里不会有它们
  protocol.announcePersistedThreads();
  console.error(sidecar
    ? '[Harness Mix] external Harness sidecar ready; official account queries start on demand'
    : '[Harness Mix] official Codex passthrough + external Harness routes via HostRuntime/ProtocolCore');
}
module.exports = { runNativeHost };
