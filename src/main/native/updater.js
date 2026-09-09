// Harness Mix auto-update: fast-forward the local checkout from its git upstream,
// reinstall dependencies and rebuild native artifacts when their inputs changed.
// Never touches a dirty or diverged working tree; update failures never block launch.
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

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
  if (install) hooks.install();
  if (rebuild) hooks.build();
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
      const outcome = applyUpdate(root, state, git, hooks || defaultHooks(root));
      log(`[Harness Mix] 更新完成：${outcome.changed} 个文件` +
        `${outcome.installed ? '，依赖已重装' : ''}${outcome.rebuilt ? '，原生组件已重建' : ''}`);
      return outcome;
    }
  }
}

module.exports = { autoUpdate, remoteState, applyUpdate, makeGit, defaultHooks };
