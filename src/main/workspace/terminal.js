const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// A bounded command runner, not a PTY. Only explicitly submitted user commands
// reach this service; transcript tool output is never executed here.
class CommandTerminal {
  constructor(emit) { this.emit = emit; this.sessions = new Map(); }
  run(root, command) {
    if (typeof command !== 'string' || !command.trim() || command.length > 16000) throw Error('请输入有效命令');
    if ([...this.sessions.values()].some(s => s.root === root && s.running)) throw Error('该项目已有命令运行中');
    const id = randomUUID();
    const proc = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const session = { id, root, command, output: '', running: true, proc };
    this.sessions.set(id, session);
    const publish = () => this.emit({ type: 'terminal', session: this.view(session) });
    const append = chunk => { session.output = (session.output + chunk).slice(-200000); publish(); };
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', append); proc.stderr.on('data', append);
    proc.on('error', e => { session.running = false; append('\n' + e.message); });
    proc.on('close', code => { session.running = false; session.exitCode = code; publish(); });
    publish();
    return this.view(session);
  }
  view({ proc, ...session }) { return session; }
  list(root) { return [...this.sessions.values()].filter(s => s.root === root).map(s => this.view(s)); }
  async stop(id) {
    const s = this.sessions.get(id);
    if (!s?.running) return;
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(s.proc.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', resolve); killer.on('close', resolve);
    });
  }
  close() { return Promise.all([...this.sessions.keys()].map(id => this.stop(id))); }
}
module.exports = { CommandTerminal };
