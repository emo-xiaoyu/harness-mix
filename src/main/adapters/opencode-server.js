const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cliSpawn } = require('../host/jsonl');
function executable(args) {
  const local = process.env.HARNESS_MIX_OPENCODE_EXECUTABLE || path.join(process.env.APPDATA || '', 'npm/node_modules/opencode-ai/bin/opencode.exe');
  return fs.existsSync(local) ? { command: local, args } : cliSpawn('opencode', args);
}
class OpenCodeServer {
  constructor(cwd, options = {}) { this.cwd = cwd; this.env = options.env; this.controllers = new Set(); this.closed = false; }
  async start() {
    const cli = executable(['serve', '--hostname', '127.0.0.1', '--port', '0']);
    this.child = spawn(cli.command, cli.args, { cwd: this.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(this.env ? { env: { ...process.env, ...this.env } } : {}) });
    try {
      this.url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OpenCode Server startup timed out')), 30000);
        let buffer = '';
        const data = chunk => { buffer = (buffer + chunk).slice(-8192); const m = buffer.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } };
        this.child.stdout.on('data', data); this.child.stderr.on('data', data);
        this.child.once('error', error => { clearTimeout(timer); reject(error); });
        this.child.once('exit', () => { clearTimeout(timer); reject(new Error('OpenCode Server exited')); });
      });
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  address(route) { const url = new URL(route, this.url); url.searchParams.set('directory', this.cwd); url.searchParams.set('location[directory]', this.cwd); return url; }
  async request(method, route, body, timeout = 30000) {
    if (this.closed) throw new Error('OpenCode Server is closed');
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(this.address(route), { method, signal: controller.signal, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`OpenCode ${method} ${route}: HTTP ${response.status}`);
      return response.status === 204 ? null : await response.json();
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async subscribe(onEvent, onError) {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    let response;
    try { response = await fetch(this.address('/event'), { signal: controller.signal }); } finally { clearTimeout(timer); }
    if (!response.ok || !response.body) throw new Error('OpenCode event stream unavailable');
    const reader = response.body.getReader();
    this.readerTask = (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { if (!this.closed) throw new Error('OpenCode event stream ended'); break; }
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) onEvent(JSON.parse(data));
          }
        }
      } catch (error) { if (!this.closed) onError(error); }
      finally { reader.releaseLock(); this.controllers.delete(controller); }
    })();
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    if (this.child && this.child.exitCode === null) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true }, () => resolve()));
      else this.child.kill();
    }
    await this.readerTask;
  }
}
module.exports = { OpenCodeServer, executable };
