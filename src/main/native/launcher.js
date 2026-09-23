const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { nativePaths, nativeEnvironment, saveNativeSettings } = require('./config');
const { runUpdateFlow, reexecLauncher } = require('./updater');
const { markBootOk, pidAlive, compareVersions } = require('./update-state');
const { inspectPosix, assertDesktopStopped } = require('./platform');
const {
  evaluateDesktopCompatibility,
  enforceDesktopCompatibility,
} = require('./compatibility');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LIVE_HOST_HEARTBEAT_MS = 15000;
// Codex Desktop ≥26.917 vets CODEX_CLI_PATH: the app-server CLI resolver keeps the
// value only when it is a bare command name (path separators or a drive letter make
// it fall through to the desktop-managed core). For those builds the shim is handed
// over by name and its directory is prepended to PATH inside the activation block.
const BARE_CLI_NAME_DESKTOP_FLOOR = '26.917';

function codexCliOverride(desktopVersion, shimPath, env = process.env, platform = process.platform) {
  const forced = env.HARNESS_MIX_CODEX_CLI_PATH_MODE;
  const bare = forced ? forced === 'bare'
    : platform === 'win32' && compareVersions(desktopVersion, BARE_CLI_NAME_DESKTOP_FLOOR) >= 0;
  if (!bare) return { CODEX_CLI_PATH: shimPath };
  // 按目标平台语义解析路径，使 win32 场景在任何 CI 宿主上可测。
  const p = platform === 'win32' ? path.win32 : path;
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  return {
    CODEX_CLI_PATH: p.basename(shimPath).replace(/\.exe$/i, ''),
    PATH: `${p.dirname(shimPath)}${delimiter}${env.PATH || ''}`,
  };
}

const normalizeDir = value => String(value).trim().replace(/[\\/]+$/, '').toLowerCase();

/** 纯函数：把 shim 目录移到 PATH 首位并去除重复项；已在首位且无重复时返回 null（无需写入） */
function registryPathPlan(shimPath, userPath) {
  const dir = path.win32.dirname(shimPath);
  const entries = String(userPath || '').split(';').filter(entry => entry.trim());
  const kept = entries.filter(entry => normalizeDir(entry) !== normalizeDir(dir));
  if (entries.length > 0 && kept.length === entries.length - 1 && normalizeDir(entries[0]) === normalizeDir(dir)) return null;
  return [dir, ...kept].join(';');
}

/** 纯函数：从 PATH 中移除指定目录的所有出现 */
function withoutPathDir(userPath, dir) {
  return String(userPath || '').split(';')
    .filter(entry => entry.trim() && normalizeDir(entry) !== normalizeDir(dir))
    .join(';');
}

// Codex Desktop ≥26.917 自重启（broker → 主进程）时丢弃激活环境块，只有注册表
// 用户环境能进入真正的主进程。因此把 shim 以裸命令名持久写入 HKCU\Environment，
// 并把其目录移到用户 PATH 首位（裸名要求 shim 先于任何同名可执行文件被命中）。
// 写入幂等；PATH 保留原值类型；所有权记录在 <dataDir>/registry-env-state.json，
// --clean-env 只回退/移除经所有权记录证明由本启动器写入的值。
// HARNESS_MIX_REGISTRY_ENV=0 或 HARNESS_MIX_CODEX_CLI_PATH_MODE=absolute 时，
// 该通道不写入并清理此前由本启动器写入的值。

const REGISTRY_ENV_STATE_VERSION = 1;

function registryEnvStateFile(dataDir) {
  return path.join(dataDir, 'registry-env-state.json');
}

function readRegistryEnvState(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(registryEnvStateFile(dataDir), 'utf8'));
    return state?.schemaVersion === REGISTRY_ENV_STATE_VERSION ? state : null;
  } catch { return null; }
}

/** 迁移接管：无状态文件但注册表值与本启动器旧版本的注入形态一致时，按“本启动器所写”接管 */
function adoptLegacyInjection(shimPath, current) {
  const bare = path.win32.basename(shimPath).replace(/\.exe$/i, '');
  const dir = path.win32.dirname(shimPath);
  const entries = String(current.PATH || '').split(';').filter(entry => entry.trim());
  const occurrences = entries.filter(entry => normalizeDir(entry) === normalizeDir(dir));
  const dirOurs = entries.length > 0 && normalizeDir(entries[0]) === normalizeDir(dir) && occurrences.length === 1;
  const cliOurs = current.CODEX_CLI_PATH === bare || current.CODEX_CLI_PATH === shimPath;
  if (!cliOurs && occurrences.length === 0) return null;
  return {
    schemaVersion: REGISTRY_ENV_STATE_VERSION,
    shimPath,
    cliPath: { wrote: cliOurs, value: cliOurs ? current.CODEX_CLI_PATH : undefined, previous: null },
    path: { prepended: occurrences.length > 0, dir, presentBefore: !dirOurs },
  };
}

/** 纯函数：计算 shim 需要写入的用户级环境（PATH 为 null 表示无需改动） */
function registryEnvPlan(shimPath, userPath) {
  return {
    CODEX_CLI_PATH: path.win32.basename(shimPath).replace(/\.exe$/i, ''),
    PATH: registryPathPlan(shimPath, userPath),
  };
}

const psq = value => String(value).replace(/'/g, "''");

function readUserEnvironment() {
  const script = [
    "$item = Get-Item 'HKCU:\\Environment'",
    '$opt = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames',
    "$kind = try { $item.GetValueKind('PATH').ToString() } catch { '' }",
    "@{ PATH = $item.GetValue('PATH', '', $opt); CODEX_CLI_PATH = $item.GetValue('CODEX_CLI_PATH', '', $opt); PATH_KIND = $kind } | ConvertTo-Json -Compress",
  ].join('; ');
  return JSON.parse(powershell(script) || '{}');
}

// Set-ItemProperty 没有 -Type 参数（Registry provider 不支持）；已存在的值用 Set 保留
// 其类型（如 PATH 的 REG_EXPAND_SZ），新建时才用 New-ItemProperty -PropertyType 指定。
const psSetValue = (name, value, typeForCreate) =>
  `if ((Get-Item 'HKCU:\\Environment').GetValueNames() -contains '${name}') { Set-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' -Value '${psq(value)}' } else { New-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' -Value '${psq(value)}' -PropertyType ${typeForCreate} | Out-Null }`;

function writeRegistryEnvState(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(registryEnvStateFile(dataDir), JSON.stringify(state, null, 2));
  } catch { /* 状态记录失败不影响主流程 */ }
}

function removeRegistryEnvState(dataDir) {
  try { fs.rmSync(registryEnvStateFile(dataDir), { force: true }); } catch { /* best-effort */ }
}

/** 只回退/移除所有权记录证明由本启动器写入的值；用户随后改动过的值保持不动 */
function cleanupOwnedRegistryEnv(state, current) {
  const lines = [];
  const changed = [];
  if (state.cliPath?.wrote && current.CODEX_CLI_PATH === state.cliPath.value) {
    if (state.cliPath.previous) {
      lines.push(psSetValue('CODEX_CLI_PATH', state.cliPath.previous, 'String'));
      changed.push('CODEX_CLI_PATH restored');
    } else {
      lines.push("Remove-ItemProperty -Path 'HKCU:\\Environment' -Name CODEX_CLI_PATH -ErrorAction SilentlyContinue");
      changed.push('CODEX_CLI_PATH removed');
    }
  }
  if (state.path?.prepended && !state.path?.presentBefore) {
    const cleaned = withoutPathDir(current.PATH, state.path.dir);
    if (cleaned !== String(current.PATH || '')) {
      lines.push(psSetValue('PATH', cleaned, current.PATH_KIND === 'ExpandString' ? 'ExpandString' : 'String'));
      changed.push('PATH entry removed');
    }
  }
  if (lines.length) powershell(lines.join('; '));
  return changed;
}

function applyRegistryEnv(shimPath, dataDir, env = process.env) {
  const disabled = env.HARNESS_MIX_REGISTRY_ENV === '0' || env.HARNESS_MIX_CODEX_CLI_PATH_MODE === 'absolute';
  const current = readUserEnvironment();
  let state = readRegistryEnvState(dataDir) || adoptLegacyInjection(shimPath, current);
  if (disabled) {
    if (state) {
      const changed = cleanupOwnedRegistryEnv(state, current);
      removeRegistryEnvState(dataDir);
      return { applied: false, reason: env.HARNESS_MIX_REGISTRY_ENV === '0' ? 'disabled' : 'absolute-mode', cleaned: changed };
    }
    return { applied: false, reason: env.HARNESS_MIX_REGISTRY_ENV === '0' ? 'disabled' : 'absolute-mode' };
  }
  const plan = registryEnvPlan(shimPath, current.PATH);
  const lines = [];
  const changed = [];
  if (current.CODEX_CLI_PATH !== plan.CODEX_CLI_PATH) {
    lines.push(psSetValue('CODEX_CLI_PATH', plan.CODEX_CLI_PATH, 'String'));
    changed.push('CODEX_CLI_PATH');
  }
  if (plan.PATH !== null) {
    lines.push(psSetValue('PATH', plan.PATH, current.PATH_KIND === 'ExpandString' ? 'ExpandString' : 'String'));
    changed.push('PATH');
  }
  if (lines.length) powershell(lines.join('; '));
  // 所有权记录：首次写入时记下原值，之后各次运行保留最初的 previous。
  writeRegistryEnvState(dataDir, {
    schemaVersion: REGISTRY_ENV_STATE_VERSION,
    shimPath,
    cliPath: state?.cliPath?.wrote ? state.cliPath : {
      wrote: changed.includes('CODEX_CLI_PATH'),
      value: plan.CODEX_CLI_PATH,
      previous: current.CODEX_CLI_PATH || null,
    },
    path: state?.path?.prepended ? state.path : {
      prepended: changed.includes('PATH') || (state?.path?.prepended ?? false),
      dir: path.win32.dirname(shimPath),
      presentBefore: changed.includes('PATH') ? false : (state?.path?.presentBefore ?? true),
    },
  });
  return { applied: changed.length > 0, changed };
}

function cleanRegistryEnv(shimPath, dataDir) {
  const current = readUserEnvironment();
  const state = readRegistryEnvState(dataDir) || adoptLegacyInjection(shimPath, current);
  if (!state) return { removed: false, reason: 'no-owned-values' };
  const changed = cleanupOwnedRegistryEnv(state, current);
  removeRegistryEnvState(dataDir);
  return { removed: changed.length > 0, changed };
}

function isCodexTaskEnvironment(env = process.env) {
  return Boolean(
    env.CODEX_THREAD_ID ||
    env.CODEX_SESSION_ID ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === 'Codex Desktop'
  );
}

function readLiveHostInstance(dataDir, {
  now = Date.now(),
  isPidAlive = pidAlive,
  maxAgeMs = LIVE_HOST_HEARTBEAT_MS,
} = {}) {
  try {
    const instance = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime', 'instance.json'), 'utf8'));
    const age = now - Number(instance.beatAt || 0);
    if (
      instance.mode !== 'native-host' ||
      !Number.isInteger(instance.pid) ||
      instance.pid <= 0 ||
      age < 0 ||
      age > maxAgeMs ||
      !isPidAlive(instance.pid)
    ) return null;
    return instance;
  } catch {
    return null;
  }
}

function cacheCodexRuntime(resources, cache) {
  fs.mkdirSync(cache, { recursive: true });
  // The CLI resolves helper executables next to itself, including code mode.
  // Repair existing caches as well as preparing a new version.
  for (const entry of fs.readdirSync(resources, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:codex(?:-.+)?|rg)\.exe$/i.test(entry.name)) continue;
    const source = path.join(resources, entry.name);
    const destination = path.join(cache, entry.name);
    if (!fs.existsSync(destination) || fs.statSync(destination).size !== fs.statSync(source).size) {
      fs.copyFileSync(source, destination);
    }
  }
  return path.join(cache, 'codex.exe');
}

// PowerShell 7 (pwsh.exe) is preferred but not preinstalled on stock Windows;
// fall back to Windows PowerShell 5.1 — Get-AppxPackage/Get-CimInstance work in
// both. Only a missing binary (ENOENT) falls through: a failed command must
// surface, not silently retry in the other shell.
function powershell(source) {
  const args = ['-NoLogo', '-NoProfile', '-Command', source];
  let lastError = null;
  for (const bin of ['pwsh.exe', 'powershell.exe']) {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  throw new Error(`未找到可用的 PowerShell（pwsh.exe / powershell.exe）：${lastError.message}`);
}

// Match the verified installation executable; never terminate unrelated apps.
function stopDesktopProcesses(installation) {
  if (process.platform !== 'win32') return assertDesktopStopped(installation);
  const target = installation.executable.replace(/'/g, "''");
  powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${target}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
}

// Reports a live host instance and reaps leftovers from crashed or force-killed
// sessions before a new desktop is activated. Only processes that belong to this
// project (shim binary path or our known entry scripts) are touched.
function sweepLeftovers(root, dataDir) {
  if (process.platform !== 'win32') return;
  try {
    const instanceFile = path.join(dataDir, 'runtime', 'instance.json');
    let instance = null;
    try { instance = JSON.parse(fs.readFileSync(instanceFile, 'utf8')); } catch { /* no live instance record */ }
    if (instance && instance.pid && pidAlive(instance.pid) && Date.now() - Number(instance.beatAt || 0) < 30000) {
      console.warn(`[Harness Mix] 另一宿主实例（pid ${instance.pid}）心跳仍在；继续清扫其残留。`);
    }
    const shimDir = path.join(root, 'output', 'native-build').replace(/'/g, "''");
    const query = `Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -like '${shimDir}\\harness-mix-*.exe') -or ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*native-host.cjs*' -or $_.CommandLine -like '*desktop-controller.mjs*')) } | Select-Object -ExpandProperty ProcessId`;
    const output = powershell(query);
    const start = Date.now();
    const pids = output.split(/\s+/)
      .map(value => Number.parseInt(value, 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid);
    for (const pid of pids) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    if (pids.length) console.log(`[Harness Mix] 启动前清扫残留进程 ${pids.length} 个（${Date.now() - start}ms）`);
  } catch (error) {
    console.warn(`[Harness Mix] 残留进程清扫失败（不影响启动）：${error.message}`);
  }
}

// Stream a file into a sha256 digest. Avoids loading multi-hundred-MB binaries
// into a single buffer via Buffer.allocUnsafe, which Node rejects with
// ERR_MEMORY_ALLOCATION_FAILED on 64-bit Windows once the file outgrows the
// internal pool size (Codex Desktop's bundled codex.exe is ~295 MB).
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
async function inspect() {
  if (process.platform !== 'win32') return inspectPosix();
  const installation = JSON.parse(powershell("$p = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if (-not $p) { throw 'Codex Desktop not installed' }; $m = Get-AppxPackageManifest $p; @{ root=$p.InstallLocation; fullName=$p.PackageFullName; appId=($p.PackageFamilyName + '!' + @($m.Package.Applications.Application)[0].Id); version=$p.Version.ToString() } | ConvertTo-Json -Compress"));
  const packaged = path.join(installation.root, 'app/resources/codex.exe');
  if (!fs.existsSync(packaged)) throw new Error('Packaged Codex CLI not found');
  // An executable outside WindowsApps avoids package ACL/activation constraints.
  const digest = (await sha256OfFile(packaged)).slice(0, 16);
  const cache = path.join(process.env.LOCALAPPDATA, 'Harness Mix/codex', digest);
  const stock = cacheCodexRuntime(path.dirname(packaged), cache);
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
  const unknown = args.filter(arg => !['--check', '--update', '--no-update', '--restart', '--clean-env'].includes(arg));
  if (unknown.length) throw new Error('Unsupported Launcher arguments');
  const dataDir = nativeEnvironment().HARNESSMIX_DATA_DIR;
  if (!flags.has('--check') && isCodexTaskEnvironment()) {
    throw new Error('拒绝从 Codex 任务内部启动或重启 Harness Mix：这会终止当前 Codex Desktop 和正在执行的任务。请在 Codex 外部终端运行 Start-Codex.cmd 或 npm start。');
  }
  if (flags.has('--update')) {
    const outcome = await runUpdateFlow({
      root, dataDir, mode: 'apply', completePendingBuild: true,
      stopDesktop: async () => stopDesktopProcesses(await inspect()),
    });
    if (outcome.updated || outcome.repaired || outcome.rolledBack) {
      console.log('[Harness Mix] 更新流程完成，重新运行 npm start 生效。');
    }
    return;
  }
  if (flags.has('--clean-env')) {
    const result = cleanRegistryEnv(nativePaths().shim, dataDir);
    console.log(result.removed
      ? `[Harness Mix] 已回退本启动器写入的注册表环境（${result.changed.join(' + ')}）。`
      : '[Harness Mix] 用户环境中没有本启动器写入的值，无需清理。');
    return;
  }
  if (!flags.has('--check') && !flags.has('--restart')) {
    const live = readLiveHostInstance(dataDir);
    if (live) {
      console.log(`[Harness Mix] 已在运行（Host PID ${live.pid}）；不会重启当前 Codex Desktop。需要显式重启时使用 npm start -- --restart。`);
      return;
    }
  }
  const installation = await inspect();
  const compatibility = installation.version === 'unknown'
    ? { state: 'unverified', desktopVersion: 'unknown', evidence: null }
    : evaluateDesktopCompatibility(installation.version);
  const paths = nativePaths();
  for (const file of Object.values(paths)) if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run npm run build:native`);
  if (flags.has('--check')) {
    console.log(`platform=${process.platform}\narchitecture=${process.arch}\ndesktop_version=${installation.version}\ndesktop_compatibility=${compatibility.state}\ndesktop_evidence=${compatibility.evidence?.level || 'none'}\nexecutable_codex_cli=${installation.stock}\ncodex_mode=official-passthrough\ncodex_managed_route=codex-harness\nlauncher=${paths.cli}\nshim=${paths.shim}\nruntime=${paths.runtime}\nrenderer=${paths.renderer}\ncore=src/main/protocol-core`);
    return;
  }
  const skipUpdate = flags.has('--no-update') || process.env.HARNESS_MIX_AUTO_UPDATE === '0';
  if (!skipUpdate) {
    const outcome = await runUpdateFlow({
      root, dataDir, mode: 'apply', completePendingBuild: true,
      stopDesktop: async () => stopDesktopProcesses(installation),
    });
    if (outcome.restartRequired) {
      if (process.env.HARNESS_MIX_UPDATED === '1') throw new Error('更新后重启循环，已停止：请手动运行 npm run check:native 检查安装');
      console.log('[Harness Mix] 代码已更新，重新加载启动器…');
      process.exitCode = await reexecLauncher(root, args);
      return;
    }
  }
  enforceDesktopCompatibility(compatibility);
  if (compatibility.state !== 'verified') {
    console.warn(`[Harness Mix] Codex Desktop ${installation.version} compatibility is ${compatibility.state}; protocol checks continue, but full restarted Desktop acceptance is not recorded.`);
  }
  const env = nativeEnvironment();
  // Retire the previous runtime first: it still holds the data directory open
  // and would otherwise write over live sessions and accounts.
  console.log('[Harness Mix] Restarting Codex Desktop: official Codex passthrough + Harness Mix routes.');
  stopDesktopProcesses(installation);
  await new Promise(resolve => setTimeout(resolve, 1000));
  sweepLeftovers(root, dataDir);
  saveNativeSettings(env);
  fs.writeFileSync(path.join(path.dirname(paths.shim), 'node-path.txt'), process.execPath);
  fs.writeFileSync(path.join(path.dirname(paths.shim), 'stock-path.txt'), installation.stock);
  // ≥26.917 的 Desktop 自重启会丢弃激活环境块；把 shim 的裸名/路径写进注册表用户环境兜底。
  if (process.platform === 'win32' && compareVersions(installation.version, BARE_CLI_NAME_DESKTOP_FLOOR) >= 0) {
    const registry = applyRegistryEnv(paths.shim, dataDir);
    if (registry.applied) console.log(`[Harness Mix] 已写入用户注册表环境（${registry.changed.join(' + ')}），Desktop 自重启后仍能找到 shim；npm start -- --clean-env 可移除。`);
    if (registry.cleaned?.length) console.log(`[Harness Mix] 按开关移除注册表注入（${registry.cleaned.join(' + ')}）。`);
  }
  const port = await freePort();
  const attachmentPort = await freePort();
  const nonce = crypto.randomBytes(16).toString('hex');
  const overrides = { ...codexCliOverride(installation.version, paths.shim), HARNESSMIX_STOCK_CODEX_PATH: installation.stock,
    HARNESSMIX_DATA_DIR: env.HARNESSMIX_DATA_DIR, HARNESS_MIX_NODE_PATH: process.execPath,
    HARNESSMIX_DEFAULT_AGENT: 'codex' };
  if (overrides.CODEX_CLI_PATH !== paths.shim) {
    console.log(`[Harness Mix] Codex Desktop ${installation.version} 仅接受裸命令名：CODEX_CLI_PATH=${overrides.CODEX_CLI_PATH}（经激活环境 PATH 解析 shim）。`);
  }
  const block = Buffer.from(Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join('\0') + '\0\0', 'utf16le').toString('base64');
  let desktop;
  let pid;
  if (process.platform === 'win32') {
    pid = execFileSync(paths.activation, [installation.fullName, installation.appId, block, `--remote-debugging-port=${port}`], { encoding: 'utf8', windowsHide: true }).trim();
  } else {
    desktop = spawn(installation.executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
      { env: { ...env, ...overrides }, stdio: 'ignore' });
    await new Promise((resolve, reject) => { desktop.once('spawn', resolve); desktop.once('error', reject); });
    pid = desktop.pid;
  }
  console.log(`[Harness Mix] Desktop PID ${pid}, CDP ${port}`);
  const controller = spawn(process.execPath, [paths.controller, '--renderer-cdp-endpoint', `http://127.0.0.1:${port}`,
    '--renderer', paths.renderer, '--default-agent', 'codex', '--attachment-port', String(attachmentPort), '--attachment-nonce', nonce],
  { env, stdio: 'inherit', windowsHide: true });
  controller.on('error', error => { console.error(error.message); process.exitCode = 1; });
  controller.on('exit', code => { process.exitCode = code || 0; });
  if (desktop) {
    desktop.once('exit', () => controller.kill('SIGTERM'));
    // The GUI may remain open after controller failure; do not hold the launcher alive.
    controller.once('exit', () => desktop.unref());
    const stop = () => { controller.kill('SIGTERM'); desktop.kill('SIGTERM'); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  // A healthy boot = the controller still alive after 20s; then a freshly applied
  // update is marked good and the crash-loop counter resets.
  const bootTimer = setTimeout(() => { if (controller.exitCode === null) markBootOk(dataDir); }, 20000);
  controller.on('exit', () => clearTimeout(bootTimer));
  return controller;
}
module.exports = {
  inspect,
  launch,
  cacheCodexRuntime,
  codexCliOverride,
  registryEnvPlan,
  registryPathPlan,
  withoutPathDir,
  adoptLegacyInjection,
  applyRegistryEnv,
  cleanRegistryEnv,
  readUserEnvironment,
  isCodexTaskEnvironment,
  readLiveHostInstance,
  stopDesktopProcesses,
};
