#!/usr/bin/env node
// Bundles versions, update/runtime state and redacted log tails into
// output/diagnostics-<timestamp>.zip for bug reports. Read-only: touches
// nothing in the desktop, host or install.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nativeEnvironment } = require('../src/main/native/config');
const { redactText } = require('../src/main/native/redact');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-diagnostics-'));
const out = path.join(root, 'output');
fs.mkdirSync(out, { recursive: true });

const run = (command, args) => {
  try { return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim(); }
  catch (error) { return `unavailable: ${error.message}`; }
};
const tail = (file, lines = 200) => {
  try {
    const rows = fs.readFileSync(file, 'utf8').split('\n');
    return rows.slice(-lines).map(redactText).join('\n');
  } catch { return '(missing)'; }
};
const write = (name, content) => fs.writeFileSync(path.join(stage, name), String(content));

const env = nativeEnvironment();
const data = env.CODEXHOST_DATA_DIR;
write('versions.json', JSON.stringify({
  'harness-mix': pkg.version,
  node: process.version,
  npm: run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']),
  cargo: run('cargo', ['--version']),
  platform: process.platform,
  os: os.release(),
  check: run(process.execPath, [path.join(root, 'scripts', 'launch-codex.cjs'), '--check']),
}, null, 2));
write('update-state.json', tail(path.join(data, 'update-state.json'), 400));
write('instance.json', tail(path.join(data, 'runtime', 'instance.json'), 400));
write('host-traffic.tail.jsonl', tail(path.join(data, 'host-traffic.jsonl')));
write('shim-invocations.tail.log', tail(path.join(root, 'output', 'native-build', 'shim-invocations.log')));
const crashDir = path.join(data, 'runtime');
if (fs.existsSync(crashDir)) {
  for (const name of fs.readdirSync(crashDir).filter(entry => entry.startsWith('crash-')).slice(-3)) {
    write(name, tail(path.join(crashDir, name), 400));
  }
}

const zip = path.join(out, `diagnostics-${stamp}.zip`);
// bsdtar treats "E:\..." as a remote host:path spec, so pack via PowerShell.
const script = `Compress-Archive -Path '${path.join(stage, '*')}' -DestinationPath '${zip}' -Force`;
run('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
if (!fs.existsSync(zip)) run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
if (!fs.existsSync(zip)) throw new Error('诊断打包失败：Compress-Archive 不可用');
try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* leave for inspection */ }
console.log(`[Harness Mix] 诊断包已生成：${zip}`);
