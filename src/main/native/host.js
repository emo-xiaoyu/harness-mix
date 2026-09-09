const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { HostRuntime } = require('../host/runtime');
const { NativeProtocol } = require('./protocol');

async function runNativeHost() {
  const stock = process.env.CODEXHOST_STOCK_CODEX_PATH;
  if (!stock || !fs.existsSync(stock)) throw new Error('Official Codex CLI path is missing');
  const directory = path.join(process.env.CODEXHOST_DATA_DIR || path.join(process.env.APPDATA, 'harness-mix/native'), 'mix-core');
  const trafficLog = path.join(path.dirname(directory), 'host-traffic.jsonl');
  const traffic = (kind, message) => {
    try { fs.appendFileSync(trafficLog, JSON.stringify({ ts: Date.now(), kind, message }) + '\n'); } catch {}
  };
  const runtime = new HostRuntime({ dataDirectory: directory });
  const ready = runtime.initialize();
  const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const protocol = new NativeProtocol(runtime, write);
  const env = { ...process.env };
  delete env.CODEX_CLI_PATH;
  // Forward the Desktop's original CLI arguments (the shim preserves them in argv):
  // -c overrides such as features.* and mcp_servers.codex_app must reach the stock
  // app-server, otherwise per-thread configs referencing them fail config loading.
  const passthrough = process.argv.slice(2);
  const officialArgs = passthrough.includes('--listen') ? passthrough : [...passthrough, '--listen', 'stdio://'];
  const official = spawn(stock, officialArgs, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const forwarded = new Map();
  const lines = readline.createInterface({ input: official.stdout });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line);
      const request = forwarded.get(value.id);
      if (request) {
        forwarded.delete(value.id);
        if (value.error) traffic('official-error', { method: request.method, error: value.error });
        if (request.method === 'thread/list' && value.result?.data && !request.params?.cursor) {
          const local = runtime.threads.filter(t => Boolean(t.archived) === Boolean(request.params?.archived) && (!request.params?.cwd || t.cwd === request.params.cwd));
          value.result.data = [...local.map(t => protocol.projectThread(t, false)), ...value.result.data];
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
    input.close(); protocol.close();
    await ready.catch(() => {});
    await runtime.close();
    official.stdin.end();
    const timer = setTimeout(() => official.kill(), 2000); timer.unref();
  }
  input.on('line', line => {
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (!message.method) {
          if (String(message.id).startsWith('harness-mix:approval:')) { await ready; await protocol.respond(message); return; }
        } else if (message.id !== undefined && message.method !== 'initialize') {
          await ready;
          const result = await protocol.request(message.method, message.params);
          if (result !== undefined) { write({ id: message.id, result }); return; }
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
  official.on('error', error => { console.error(error); void close(); });
  official.on('exit', () => { void close(); });
  await ready;
  console.error('[Harness Mix] native protocol -> local HostRuntime -> local ProtocolCore');
}
module.exports = { runNativeHost };
