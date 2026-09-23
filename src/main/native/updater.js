// Harness Mix auto-update.
// - git channel: fast-forward the local checkout from its upstream, reinstall
//   dependencies and rebuild native artifacts when their inputs changed.
// - npm channel: compare the installed version with the registry and apply via
//   `npm install -g`, with lock, retries, pending and crash-loop rollback.
// - State/lock/semver live in ./update-state. Failures never block launch.
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const {
  acquireLock, compareVersions, detectChannel, readState, writeState,
} = require('./update-state');

// The checkout this module ships in. The host process is spawned by the Desktop
// (via the shim) with an arbitrary working directory — commonly the Desktop
// install dir, never the repo root — so git/npm must anchor here instead of
// inheriting process.cwd(). Mirrors REPO_ROOT in protocol.js.
const REPO_ROOT = path.resolve(__dirname, '../../..');

// A caller-supplied root resolves against REPO_ROOT, never against the process
// cwd: '.' must keep meaning "the checkout", wherever the host was started.
function resolveRoot(root) {
  if (!root) return REPO_ROOT;
  return path.isAbsolute(root) ? path.normalize(root) : path.resolve(REPO_ROOT, root);
}

// A bare "git rev-parse failed" was undiagnosable: a spawn-timeout kill or a
// crashed git exits non-zero with an EMPTY stderr, and the old fallback dropped
// the exit status, the signal and stdout with it. Keep the requested prefix and
// append the status plus a bounded tail of stderr (stdout as fallback).
function gitFailureDetail(result, args) {
  const parts = [`git ${args[0]} failed`];
  if (result.status !== null && result.status !== undefined) parts.push(`exit ${result.status}`);
  if (result.signal) parts.push(`signal ${result.signal}`);
  const output = String(result.stderr || result.stdout || '').trim();
  if (output) parts.push(output.split('\n').slice(-2).join(' | ').slice(0, 300));
  return parts.join(': ');
}

function makeGit(root = REPO_ROOT, exec = spawnSync) {
  const cwd = resolveRoot(root);
  // The wrapper awaits the exec result so synchronous runners (spawnSync, the
  // test fakes) and promise runners (asyncRun, used by the host's settings-page
  // check) share one code path. Checking `result.status` on an unresolved
  // promise is always `undefined !== 0` — the original settings-page failure
  // ("git rev-parse failed" on the very first rev-parse) — so never bypass it.
  return async (args, timeout = 20000) => {
    const result = await exec('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error) {
      throw new Error(`git ${args[0]} failed to start: ${result.error.message}`, { cause: result.error });
    }
    if (result.status !== 0) throw new Error(gitFailureDetail(result, args));
    return String(result.stdout).trim();
  };
}

// spawn-based drop-in for spawnSync with the same { error, status, stdout, stderr }
// result shape. Host-side callers must never block their event loop on git/npm,
// so they hand this to makeGit()/resolveRegistry() instead of spawnSync.
function asyncRun() {
  return (cmd, args, options = {}) => new Promise(resolve => {
    const child = spawn(cmd, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => resolve({ error, stdout, stderr, status: null, signal: null }));
    // `close` also reports the signal: a spawn-timeout kill delivers
    // status=null and (on Windows) empty streams, and the signal is then the
    // only evidence of what happened.
    child.on('close', (status, signal) => resolve({ error: null, stdout, stderr, status, signal }));
  });
}

// remoteState classifies the checkout relative to its upstream:
// current | ahead | diverged | dirty | available (fast-forward possible).
async function remoteState(root = REPO_ROOT, git = makeGit(root)) {
  const head = await git(['rev-parse', 'HEAD']);
  let upstream = 'origin/main';
  try {
    upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch { /* no upstream configured: fall back to origin/main */ }
  // The refspec must stay a single argument: splitting `origin/release/1.2`
  // on '/' would make git fetch two unrelated refs.
  const [remoteName, ...ref] = upstream.split('/');
  await git(['fetch', '--quiet', remoteName, ref.join('/')], 30000);
  const remote = await git(['rev-parse', upstream]);
  if (remote === head) return { state: 'current', head, remote, upstream };
  const base = await git(['merge-base', 'HEAD', upstream]);
  if (base === remote) return { state: 'ahead', head, remote, upstream };
  if (base !== head) return { state: 'diverged', head, remote, upstream };
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).length > 0;
  if (dirty) return { state: 'dirty', head, remote, upstream };
  return { state: 'available', head, remote, upstream };
}

// Child output must never be inherited: in the host/helper context stdout may
// be a protocol channel, and even at the launcher it interleaves with progress
// lines. stdio is piped and only the failure tail is surfaced.
function hookErrorDetail(error) {
  const stderr = String((error && error.stderr) || '').trim();
  const tail = stderr ? stderr.split('\n').slice(-3).join(' | ') : (error && error.message) || String(error);
  return tail.slice(0, 300);
}

function defaultHooks(root = REPO_ROOT) {
  const repo = resolveRoot(root);
  return {
    install() {
      try {
        execFileSync(npmCommand(), ['install'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        throw new Error(`npm install 失败：${hookErrorDetail(error)}`);
      }
    },
    build() {
      try {
        execFileSync(process.execPath, [path.join(repo, 'scripts/build-native.cjs')], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        throw new Error(`build:native 失败：${hookErrorDetail(error)}`);
      }
    },
  };
}

async function applyUpdate(root, state, git = makeGit(root), hooks = defaultHooks(root)) {
  await git(['merge', '--ff-only', state.upstream]);
  const changed = (await git(['diff', '--name-only', state.head, state.remote])).split('\n').filter(Boolean);
  const install = changed.some(file => file === 'package.json' || file === 'package-lock.json');
  const rebuild = install || changed.some(file => file.startsWith('src/') || file.startsWith('scripts/'));
  try {
    if (install) await hooks.install();
    if (rebuild) await hooks.build();
  } catch (error) {
    // A failed install/build would leave a half-updated tree behind; restore it.
    try { await git(['reset', '--hard', state.head]); } catch { /* keep the original failure */ }
    throw error;
  }
  return {
    updated: true,
    from: state.head.slice(0, 8),
    to: state.remote.slice(0, 8),
    changed: changed.length,
    installed: install,
    rebuilt: rebuild,
  };
}

async function autoUpdate({ root = REPO_ROOT, log = console.log, exec, hooks } = {}) {
  const repo = resolveRoot(root);
  const git = makeGit(repo, exec);
  let state;
  try {
    state = await remoteState(repo, git);
  } catch (error) {
    log(`[Harness Mix] 自动更新检查失败（不影响启动）：${error.message}`);
    return { updated: false, failed: true };
  }
  switch (state.state) {
    case 'current':
      log('[Harness Mix] 已是最新版本');
      return { updated: false, state: state.state };
    case 'ahead':
      log('[Harness Mix] 本地提交领先远端，跳过自动更新');
      return { updated: false, state: state.state };
    case 'diverged':
      log('[Harness Mix] 本地与远端已分叉，请手动处理后重启，跳过自动更新');
      return { updated: false, state: state.state };
    case 'dirty':
      log('[Harness Mix] 工作区存在未提交改动，跳过自动更新');
      return { updated: false, state: state.state };
    default: {
      log(`[Harness Mix] 发现新版本 ${state.head.slice(0, 8)} → ${state.remote.slice(0, 8)}，正在更新…`);
      let outcome;
      try {
        outcome = await applyUpdate(repo, state, git, hooks || defaultHooks(repo));
      } catch (error) {
        log(`[Harness Mix] 更新失败并已回退（不影响启动）：${error.message}`);
        return { updated: false, failed: true };
      }
      log(`[Harness Mix] 更新完成：${outcome.changed} 个文件` +
        `${outcome.installed ? '，依赖已重装' : ''}${outcome.rebuilt ? '，原生组件已重建' : ''}`);
      return outcome;
    }
  }
}

/* ---------------- npm channel ---------------- */

const REGISTRY_CACHE_FILE = 'update-registry-cache.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function resolveRegistry({ env = process.env, run = spawnSync } = {}) {
  if (env.HARNESS_MIX_UPDATE_REGISTRY) return env.HARNESS_MIX_UPDATE_REGISTRY;
  if (env.npm_config_registry) return env.npm_config_registry;
  const result = await run(npmCommand(), ['config', 'get', 'registry'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const value = result && result.status === 0 ? String(result.stdout || '').trim() : '';
  return value && value !== 'undefined' && value !== 'null' ? value : 'https://registry.npmjs.org/';
}

async function fetchLatestVersion({ registry, dataDir, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const url = `${String(registry).replace(/\/+$/, '')}/harness-mix`;
  const cacheFile = dataDir ? path.join(dataDir, REGISTRY_CACHE_FILE) : null;
  const cache = cacheFile ? readJson(cacheFile) : null;
  const headers = { accept: 'application/vnd.npm.install-v1+json' };
  if (cache && cache.etag) headers['if-none-match'] = cache.etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (response.status === 304 && cache && cache.version) return cache.version;
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
    const body = await response.json();
    const version = body && body['dist-tags'] && body['dist-tags'].latest;
    if (!version) throw new Error('registry response has no dist-tags.latest');
    if (cacheFile) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ etag: response.headers && response.headers.get ? response.headers.get('etag') : null, version, at: Date.now() }));
      } catch { /* cache is best-effort */ }
    }
    return version;
  } finally {
    clearTimeout(timer);
  }
}

function npmGlobalRoot({ run = spawnSync } = {}) {
  const result = run(npmCommand(), ['root', '-g'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return result && result.status === 0 ? String(result.stdout || '').trim() : null;
}

function isGlobalInstall(root, deps = {}) {
  const globalRoot = npmGlobalRoot(deps);
  if (!globalRoot) return false;
  const normalize = value => path.resolve(value).toLowerCase().replace(/[\\/]+$/, '');
  return normalize(root).startsWith(normalize(globalRoot));
}

async function npmInstallGlobal(version, { run = spawnSync, log = () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const args = ['install', '-g', `harness-mix@${version}`, '--no-audit', '--no-fund'];
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = run(npmCommand(), args, { encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, npm_config_update_notifier: 'false' } });
    if (result && result.status === 0) return { ok: true, attempts: attempt };
    last = result ? String(result.error || result.stderr || `exit ${result.status}`).trim() : 'npm run failed';
    log(`[Harness Mix] npm 安装失败（第 ${attempt}/3 次）：${last.split('\n').pop()}`);
    if (attempt < 3) await delay(2000);
  }
  return { ok: false, attempts: 3, error: last };
}

// Runs `scripts/launch-codex.cjs` from the (possibly just updated) checkout and
// forwards its exit code. HARNESS_MIX_UPDATED guards against update loops.
function reexecLauncher(root = REPO_ROOT, args = []) {
  const repo = resolveRoot(root);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(repo, 'scripts', 'launch-codex.cjs'), ...args], {
      env: { ...process.env, HARNESS_MIX_UPDATED: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', () => resolve(1));
    child.on('exit', code => resolve(code === null ? 0 : code));
  });
}

/* ---------------- orchestration ---------------- */

// One launch-time update pass. Returns:
//   { updated, restartRequired, repaired, rolledBack, pending, failed, ... }
// restartRequired tells the caller to re-exec the launcher so new code loads.
// `hooks` lets the desktop-triggered helper inject lock-aware build handling;
// `completePendingBuild` (launcher boot path) finishes a build the helper had
// to defer because the running Desktop held the native binaries locked.
async function runUpdateFlow({ root = REPO_ROOT, dataDir, log = console.log, stopDesktop = async () => {}, mode = 'apply', hooks = null, completePendingBuild = false, deps = {} } = {}) {
  const {
    gitExec,
    run = spawnSync,
    fetchImpl = fetch,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    env = process.env,
  } = deps;
  // Anchor every git/npm/package.json access to the checkout, not the host cwd.
  const repo = resolveRoot(root);
  const halt = async () => { await stopDesktop(); await delay(3000); };
  const flowHooks = () => hooks || defaultHooks(repo);

  const currentVersion = (readJson(path.join(repo, 'package.json')) || {}).version || '0.0.0';
  const channel = detectChannel(repo);
  let state = readState(dataDir);

  if (channel === 'portable') {
    log('[Harness Mix] 当前安装形态不支持自动更新（portable 通道未实现）');
    return { updated: false, channel };
  }

  // A version the user installed by hand is not ours to track.
  if (channel === 'npm' && state.appliedVersion && state.appliedVersion !== currentVersion && state.prevVersion !== currentVersion) {
    state = writeState(dataDir, { ...state, phase: 'idle', appliedVersion: null, prevVersion: null, attempts: 0, pendingVersion: null, pendingBuild: null });
  }

  let lockBusy = false;
  async function mutate(fn) {
    let release;
    try {
      release = acquireLock(dataDir, 'update');
    } catch (error) {
      lockBusy = true;
      log(`[Harness Mix] 跳过更新：${error.message}`);
      return { skipped: true };
    }
    try { return { value: await fn() }; } finally { release(); }
  }

  // 1) Repair an apply that was interrupted by a crash or a hard kill.
  if (state.phase === 'applying') {
    log('[Harness Mix] 检测到上次更新中断，正在修复…');
    const repaired = await mutate(async () => {
      if (state.channel === 'npm') {
        if (state.pendingVersion && state.pendingVersion === currentVersion) {
          // The install actually completed before the crash: keep it, fix bookkeeping.
          writeState(dataDir, { ...readState(dataDir), phase: 'idle', pendingVersion: null, appliedVersion: state.pendingVersion, prevVersion: state.appliedVersion, appliedAt: Date.now() });
          return true;
        }
        await halt();
        const target = state.appliedVersion || state.prevVersion;
        if (target) {
          const result = await npmInstallGlobal(target, { run, log, delay });
          if (!result.ok) return false;
        }
      } else if (state.channel === 'git' && state.preUpdateHead) {
        await halt();
        await makeGit(repo, gitExec)(['reset', '--hard', state.preUpdateHead]);
        // Sources are back to the old head: rebuild so the binaries match it.
        await flowHooks().build();
      }
      writeState(dataDir, { ...readState(dataDir), phase: 'idle', pendingVersion: null, pendingBuild: null });
      return true;
    });
    if (repaired.value) return { updated: false, repaired: true, restartRequired: true };
    if (repaired.skipped) return { updated: false, failed: true, reason: 'lock' };
    return { updated: false, failed: true };
  }

  // 1.5) Finish a build the desktop-triggered helper deferred because the
  // running Desktop held the native binaries locked (launcher boot path: the
  // desktop is stopped via halt() first, so the files are writable again).
  if (state.pendingBuild && completePendingBuild) {
    log('[Harness Mix] 正在完成上次推迟的原生构建…');
    const completed = await mutate(async () => {
      await halt();
      try {
        await flowHooks().build();
      } catch (error) {
        log(`[Harness Mix] 补完成构建失败，回退到更新前版本：${error.message}`);
        if (state.channel === 'git' && state.preUpdateHead) await makeGit(repo, gitExec)(['reset', '--hard', state.preUpdateHead]);
        writeState(dataDir, { ...readState(dataDir), pendingBuild: null, appliedVersion: null, prevVersion: null, attempts: 0 });
        return false;
      }
      writeState(dataDir, { ...readState(dataDir), pendingBuild: null });
      return true;
    });
    if (completed.value) return { updated: false, repaired: true };
    if (completed.skipped) return { updated: false, failed: true, reason: 'lock' };
    return { updated: false, failed: true };
  }

  // 2) Boot bookkeeping and crash-loop rollback.
  if (state.appliedVersion && state.lastBootOkAt < state.appliedAt) {
    state = writeState(dataDir, { ...state, attempts: state.attempts + 1 });
    if (state.attempts >= 2 && state.prevVersion) {
      log(`[Harness Mix] ${state.appliedVersion} 连续两次启动未成功，自动回滚到 ${state.prevVersion}…`);
      const rolledBack = await mutate(async () => {
        await halt();
        if (state.channel === 'npm') {
          const result = await npmInstallGlobal(state.prevVersion, { run, log, delay });
          if (!result.ok) return false;
        } else if (state.channel === 'git' && state.preUpdateHead) {
          await makeGit(repo, gitExec)(['reset', '--hard', state.preUpdateHead]);
          await flowHooks().build();
        }
        writeState(dataDir, { ...readState(dataDir), phase: 'idle', appliedVersion: null, prevVersion: null, attempts: 0, pendingVersion: null, pendingBuild: null, rolledBackAt: Date.now() });
        return true;
      });
      if (rolledBack.value) {
        log(`[Harness Mix] 已回滚到 ${state.prevVersion}；如问题持续请运行 npm run diagnostics 反馈。`);
        return { updated: false, rolledBack: true, restartRequired: true };
      }
      return { updated: false, failed: true, reason: 'lock' };
    }
  }

  // 3a) git channel.
  if (channel === 'git') {
    let remote;
    try {
      remote = await remoteState(repo, makeGit(repo, gitExec));
    } catch (error) {
      log(`[Harness Mix] 自动更新检查失败（不影响启动）：${error.message}`);
      return { updated: false, failed: true };
    }
    if (remote.state !== 'available') {
      const messages = {
        current: '[Harness Mix] 已是最新版本',
        ahead: '[Harness Mix] 本地提交领先远端，跳过自动更新',
        diverged: '[Harness Mix] 本地与远端已分叉，请手动处理后重启，跳过自动更新',
        dirty: '[Harness Mix] 工作区存在未提交改动，跳过自动更新',
      };
      if (messages[remote.state]) log(messages[remote.state]);
      return { updated: false, state: remote.state };
    }
    if (mode === 'check') return { updated: false, available: true, to: remote.remote.slice(0, 8) };
    log(`[Harness Mix] 发现新版本 ${remote.head.slice(0, 8)} → ${remote.remote.slice(0, 8)}，正在更新…`);
    const applied = await mutate(async () => {
      await halt();
      writeState(dataDir, { ...readState(dataDir), channel: 'git', phase: 'applying', preUpdateHead: remote.head });
      let outcome = null;
      let failure = null;
      try {
        outcome = await applyUpdate(repo, remote, makeGit(repo, gitExec), flowHooks());
      } catch (error) {
        failure = error;
      } finally {
        writeState(dataDir, { ...readState(dataDir), phase: 'idle' });
      }
      if (failure) {
        log(`[Harness Mix] 更新失败并已回退（不影响启动）：${failure.message}`);
        return null;
      }
      writeState(dataDir, { ...readState(dataDir), channel: 'git', appliedVersion: remote.remote.slice(0, 8), prevVersion: remote.head.slice(0, 8), appliedAt: Date.now(), pendingVersion: null });
      log(`[Harness Mix] 更新完成：${outcome.changed} 个文件` +
        `${outcome.installed ? '，依赖已重装' : ''}${outcome.rebuilt ? '，原生组件已重建' : ''}`);
      return outcome;
    });
    if (applied.skipped) return { updated: false, failed: true, reason: 'lock' };
    if (applied.value) return { ...applied.value, restartRequired: true };
    return { updated: false, failed: true };
  }

  // 3b) npm channel.
  if (!isGlobalInstall(repo, { run })) {
    log('[Harness Mix] 当前不是 npm 全局安装，跳过自动更新；可手动运行 npm install -g harness-mix@latest');
    return { updated: false, reason: 'not-global' };
  }
  let latest = null;
  try {
    latest = await fetchLatestVersion({ registry: await resolveRegistry({ env, run }), dataDir, fetchImpl });
  } catch (error) {
    log(`[Harness Mix] 自动更新检查失败（不影响启动）：${error.message}`);
    return { updated: false, failed: true };
  }
  if (!latest) return { updated: false, state: 'current' };
  if (!env.HARNESS_MIX_UPDATE_PRERELEASE && String(latest).includes('-') && !currentVersion.includes('-')) {
    log('[Harness Mix] 远端仅有预发布版本，已跳过（设置 HARNESS_MIX_UPDATE_PRERELEASE=1 可启用）');
    return { updated: false, state: 'current' };
  }
  const target = state.pendingVersion || latest;
  if (compareVersions(target, currentVersion) <= 0 && !state.pendingVersion) {
    log('[Harness Mix] 已是最新版本');
    return { updated: false, state: 'current' };
  }
  if (mode === 'check') return { updated: false, available: true, to: target };
  log(`[Harness Mix] 发现新版本 ${currentVersion} → ${target}，正在更新…`);
  const applied = await mutate(async () => {
    await halt();
    writeState(dataDir, { ...readState(dataDir), channel: 'npm', phase: 'applying', pendingVersion: target });
    const result = await npmInstallGlobal(target, { run, log, delay });
    if (!result.ok) {
      writeState(dataDir, { ...readState(dataDir), phase: 'idle', pendingVersion: target, pendingBuild: null });
      log(`[Harness Mix] 更新失败，已安排下次启动重试（${target}）`);
      return false;
    }
    writeState(dataDir, { ...readState(dataDir), phase: 'idle', pendingVersion: null, appliedVersion: target, prevVersion: currentVersion, appliedAt: Date.now(), lastCheckAt: Date.now() });
    return true;
  });
  if (applied.skipped) return { updated: false, failed: true, reason: 'lock' };
  if (applied.value) {
    log(`[Harness Mix] 更新完成 ${currentVersion} → ${target}，正在重新启动…`);
    return { updated: true, from: currentVersion, to: target, restartRequired: true };
  }
  return { updated: false, failed: true, pending: target };
}

module.exports = {
  autoUpdate, remoteState, applyUpdate, makeGit, asyncRun, defaultHooks,
  runUpdateFlow, reexecLauncher, fetchLatestVersion, npmInstallGlobal,
  resolveRegistry, isGlobalInstall, npmGlobalRoot, readJson,
  REPO_ROOT, resolveRoot, gitFailureDetail,
};
