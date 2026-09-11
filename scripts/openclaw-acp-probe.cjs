// 一次性探针：spawn `openclaw acp`，发 ACP initialize，打印能力面后退出。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cliSpawn } = require('../src/main/host/jsonl');
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
const token = cfg?.gateway?.auth?.token;

const args = ['acp'];
if (token) args.push('--token', token);
const cli = cliSpawn('openclaw', args);
const child = spawn(cli.command, cli.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
child.stdout.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      console.log('RECV:', JSON.stringify(msg).slice(0, 2000));
      if (msg.id === 0) {
        // 再试一个 session/new 看 resume 面
        send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
      } else if (msg.id === 1 || msg.id === 2) {
        setTimeout(() => { child.kill(); process.exit(0); }, 500);
      }
    } catch { console.log('NONJSON:', line.slice(0, 200)); }
  }
});
child.stderr.on('data', (c) => { const s = String(c).trim(); if (s) console.log('STDERR:', s.slice(0, 300)); });
child.on('exit', (code) => { console.log('EXIT', code); process.exit(0); });
function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } } });
setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1); }, 25000);
