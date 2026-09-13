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

function makeGit(root, exec = spawnSync) {
  return (args, timeout = 20000) => {
    const result = exec('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(String(result.stderr || `git ${args[0]} failed`).trim());
    return String(result.stdout).trim();
  };
}

// remoteState classifies the checkout relative to its upstream:
// current | ahead | diverged | dirty | available (fast-forward possible).
function remoteState(root, git = makeGit(root)) {
  const head = git(['rev-parse', 'HEAD']);
  let upstream = 'origin/main';
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch { /* no upstream configured: fall back to origin/main */ }
  git(['fetch', '--quiet', ...upstream.split('/')], 30000);
  const remote = git(['rev-parse', upstream]);
  if (remote === head) return { state: 'current', head, remote, upstream };
  const base = git(['merge-base', 'HEAD', upstream]);
  if (base === remote) return { state: 'ahead', head, remote, upstream };
  if (base !== head) return { state: 'diverged', head, remote, upstream };
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
  if (dirty) return { state: 'dirty', head, remote, upstream };
  return { state: 'available', head, remote, upstream };
}

function defaultHooks(root) {
  return {
    install() {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execFileSync(npm, ['install'], { cwd: root, stdio: 'inherit', windowsHide: true });
    },
    build() {
      execFileSync(process.execPath, [path.join(root, 'scripts/build-native.cjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
    },
  };
}

function applyUpdate(root, state, git = makeGit(root), hooks = defaultHooks(root)) {
  git(['merge', '--ff-only', state.upstream]);
  const changed = git(['diff', '--name-only', state.head, state.remote]).split('\n').filter(Boolean);
  const install = changed.some(file => file === 'package.json' || file === 'package-lock.json');
  const rebuild = install || changed.some(file => file.startsWith('src/') || file.startsWith('scripts/'));
  try {
    if (install) hooks.install();
    if (rebuild) hooks.build();
  } catch (error) {
    // A failed install/build would leave a half-updated tree behind; restore it.
    try { git(['reset', '--hard', state.head]); } catch { /* keep the original failure */ }
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

async function autoUpdate({ root, log = console.log, exec, hooks } = {}) {
  const git = makeGit(root, exec);
  let state;
  try {
    state = remoteState(root, git);
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
        outcome = applyUpdate(root, state, git, hooks || defaultHooks(root));
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

function resolveRegistry({ env = process.env, run = spawnSync } = {}) {
  if (env.HARNESS_MIX_UPDATE_REGISTRY) return env.HARNESS_MIX_UPDATE_REGISTRY;
  if (env.npm_config_registry) return env.npm_config_registry;
  const result = run(npmCommand(), ['config', 'get', 'registry'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
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
function reexecLauncher(root, args = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'launch-codex.cjs'), ...args], {
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
async function runUpdateFlow({ root, dataDir, log = console.log, stopDesktop = async () => {}, mode = 'apply', deps = {} } = {}) {
  const {
    gitExec,
    run = spawnSync,
    fetchImpl = fetch,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    env = process.env,
  } = deps;
  const halt = async () => { await stopDesktop(); await delay(3000); };

  const currentVersion = (readJson(path.join(root, 'package.json')) || {}).version || '0.0.0';
  const channel = detectChannel(root);
  let state = readState(dataDir);

  if (channel === 'portable') {
    log('[Harness Mix] 当前安装形态不支持自动更新（portable 通道未实现）');
    return { updated: false, channel };
  }

  // A version the user installed by hand is not ours to track.
  if (channel === 'npm' && state.appliedVersion && state.appliedVersion !== currentVersion && state.prevVersion !== currentVersion) {
    state = writeState(dataDir, { ...state, phase: 'idle', appliedVersion: null, prevVersion: null, attempts: 0, pendingVersion: null });
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
        if (target) await npmInstallGlobal(target, { run, log, delay });
      } else if (state.channel === 'git' && state.preUpdateHead) {
        await halt();
        makeGit(root, gitExec)(['reset', '--hard', state.preUpdateHead]);
      }
      writeState(dataDir, { ...readState(dataDir), phase: 'idle', pendingVersion: null });
      return true;
    });
    if (repaired.value) return { updated: false, repaired: true, restartRequired: true };
    if (repaired.skipped) return { updated: false, failed: true, reason: 'lock' };
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
          makeGit(root, gitExec)(['reset', '--hard', state.preUpdateHead]);
          defaultHooks(root).build();
        }
        writeState(dataDir, { ...readState(dataDir), phase: 'idle', appliedVersion: null, prevVersion: null, attempts: 0, pendingVersion: null, rolledBackAt: Date.now() });
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
      remote = remoteState(root, makeGit(root, gitExec));
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
        outcome = applyUpdate(root, remote, makeGit(root, gitExec), defaultHooks(root));
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
  if (!isGlobalInstall(root, { run })) {
    log('[Harness Mix] 当前不是 npm 全局安装，跳过自动更新；可手动运行 npm install -g harness-mix@latest');
    return { updated: false, reason: 'not-global' };
  }
  let latest = null;
  try {
    latest = await fetchLatestVersion({ registry: resolveRegistry({ env, run }), dataDir, fetchImpl });
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
      writeState(dataDir, { ...readState(dataDir), phase: 'idle', pendingVersion: target });
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
  autoUpdate, remoteState, applyUpdate, makeGit, defaultHooks,
  runUpdateFlow, reexecLauncher, fetchLatestVersion, npmInstallGlobal,
  resolveRegistry, isGlobalInstall, npmGlobalRoot, readJson,
};
