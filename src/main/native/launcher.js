const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { nativePaths, nativeEnvironment, saveNativeSettings } = require('./config');
const { autoUpdate, defaultHooks } = require('./updater');

const REPO_ROOT = path.resolve(__dirname, '../..');

function powershell(source) {
  return execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', source], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
}
function inspect() {
  if (process.platform !== 'win32') throw new Error('The local native Launcher currently supports Windows');
  const installation = JSON.parse(powershell("$p = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if (-not $p) { throw 'Codex Desktop not installed' }; $m = Get-AppxPackageManifest $p; @{ root=$p.InstallLocation; fullName=$p.PackageFullName; appId=($p.PackageFamilyName + '!' + @($m.Package.Applications.Application)[0].Id); version=$p.Version.ToString() } | ConvertTo-Json -Compress"));
  const packaged = path.join(installation.root, 'app/resources/codex.exe');
  if (!fs.existsSync(packaged)) throw new Error('Packaged Codex CLI not found');
  // An executable outside WindowsApps avoids package ACL/activation constraints.
  const digest = crypto.createHash('sha256').update(fs.readFileSync(packaged)).digest('hex').slice(0, 16);
  const cache = path.join(process.env.LOCALAPPDATA, 'Harness Mix/codex', digest);
  fs.mkdirSync(cache, { recursive: true });
  const stock = path.join(cache, 'codex.exe');
  if (!fs.existsSync(stock)) fs.copyFileSync(packaged, stock);
  return { ...installation, stock, executable: path.join(installation.root, 'app/ChatGPT.exe') };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function launch(args = []) {
  const root = REPO_ROOT;
  const flags = new Set(args);
  const unknown = args.filter(arg => !['--check', '--update', '--no-update'].includes(arg));
  if (unknown.length) throw new Error('Unsupported Launcher arguments');
  if (flags.has('--update')) {
    await autoUpdate({ root, hooks: defaultHooks(root) });
    return;
  }
  const skipUpdate = flags.has('--no-update') || process.env.HARNESS_MIX_AUTO_UPDATE === '0';
  if (!flags.has('--check') && !skipUpdate) {
    await autoUpdate({ root, hooks: defaultHooks(root) });
  }
  const installation = inspect();
  const paths = nativePaths();
  for (const file of Object.values(paths)) if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run npm run build:native`);
  if (flags.has('--check')) {
    console.log(`desktop_version=${installation.version}\nexecutable_codex_cli=${installation.stock}\nlauncher=${paths.cli}\nshim=${paths.shim}\nruntime=${paths.runtime}\nrenderer=${paths.renderer}\ncore=src/main/protocol-core`);
    return;
  }
  const env = nativeEnvironment();
  saveNativeSettings(env);
  fs.writeFileSync(path.join(path.dirname(paths.shim), 'node-path.txt'), process.execPath);
  fs.writeFileSync(path.join(path.dirname(paths.shim), 'stock-path.txt'), installation.stock);
  const port = await freePort();
  const attachmentPort = await freePort();
  const nonce = crypto.randomBytes(16).toString('hex');
  const overrides = { CODEX_CLI_PATH: paths.shim, CODEXHOST_STOCK_CODEX_PATH: installation.stock,
    CODEXHOST_DATA_DIR: env.CODEXHOST_DATA_DIR, HARNESS_MIX_NODE_PATH: process.execPath,
    CODEXHOST_DEFAULT_AGENT: 'codex' };
  const block = Buffer.from(Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join('\0') + '\0\0', 'utf16le').toString('base64');
  console.log('[Harness Mix] Restarting Codex Desktop with the local Shim and ProtocolCore.');
  // Match the verified installation executable; never terminate unrelated apps.
  const target = installation.executable.replace(/'/g, "''");
  powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${target}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  const pid = execFileSync(paths.activation, [installation.fullName, installation.appId, block, `--remote-debugging-port=${port}`], { encoding: 'utf8', windowsHide: true }).trim();
  console.log(`[Harness Mix] Desktop PID ${pid}, CDP ${port}`);
  const controller = spawn(process.execPath, [paths.controller, '--renderer-cdp-endpoint', `http://127.0.0.1:${port}`,
    '--renderer', paths.renderer, '--default-agent', 'codex', '--attachment-port', String(attachmentPort), '--attachment-nonce', nonce],
  { env, stdio: 'inherit', windowsHide: true });
  controller.on('error', error => { console.error(error.message); process.exitCode = 1; });
  controller.on('exit', code => { process.exitCode = code || 0; });
  return controller;
}
module.exports = { inspect, launch };
