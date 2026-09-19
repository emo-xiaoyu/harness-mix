// Desktop-triggered update helper, spawned detached by the native host
// (harnessmix/update/start). Everything here runs outside the host process:
// - host stdout is the JSONL protocol channel; updater and child output must
//   never mix into it, so this process writes <dataDir>/update.log instead;
// - the host sits inside the shim's kill-on-close job: stopping the Desktop
//   from inside the host would kill the update together with the host, so the
//   flow applies with stopDesktop disabled and stops the Desktop only as its
//   last act, and only when work was parked for the next `npm start`;
// - native binaries locked by the running Desktop defer their rebuild via the
//   pendingBuild state; the launcher completes it at the next boot.
const fs = require('node:fs');
const path = require('node:path');
const { nativeEnvironment } = require('../src/main/native/config');
const { runUpdateFlow, defaultHooks } = require('../src/main/native/updater');
const { readState, updateState } = require('../src/main/native/update-state');
const { inspect, stopDesktopProcesses } = require('../src/main/native/launcher');

const REPO_ROOT = path.resolve(__dirname, '..');
// build-native.cjs surfaces EBUSY as "... is locked by a running Codex Desktop";
// EPERM covers antivirus transient holds on the same files.
const LOCKED_BUILD = /locked by a running Codex Desktop|EBUSY|EPERM|being used by another process/i;

const dataDir = nativeEnvironment().HARNESSMIX_DATA_DIR;
const logFile = path.join(dataDir, 'update.log');
const log = message => {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`); } catch { /* best-effort */ }
};

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  log('--- 桌面触发的更新开始 ---');
  const base = defaultHooks(REPO_ROOT);
  const hooks = {
    install: () => base.install(),
    build: () => {
      try {
        base.build();
      } catch (error) {
        if (!LOCKED_BUILD.test(String((error && error.message) || ''))) throw error;
        updateState(dataDir, { pendingBuild: { since: Date.now() } });
        log(`[Harness Mix] 原生组件被运行中的 Desktop 锁定，构建推迟到下次启动：${error.message}`);
      }
    },
  };
  let outcome;
  try {
    outcome = await runUpdateFlow({
      root: REPO_ROOT,
      dataDir,
      mode: 'apply',
      log,
      stopDesktop: async () => {},
      hooks,
    });
  } catch (error) {
    log(`[Harness Mix] 更新流程异常退出：${error.message}`);
    process.exitCode = 1;
    return;
  }
  log(`[Harness Mix] 更新流程结束：${JSON.stringify(outcome)}`);
  const state = readState(dataDir);
  // Parked work (deferred build / npm pendingVersion) can only complete once
  // the Desktop releases its file locks, i.e. at the next `npm start` boot.
  if (state.pendingBuild || state.pendingVersion) {
    log('[Harness Mix] 存在待下次启动完成的工作，正在关闭 Codex Desktop…');
    try {
      stopDesktopProcesses(await inspect());
      log('[Harness Mix] 已请求关闭 Codex Desktop；请重新运行 npm start 完成更新。');
    } catch (error) {
      log(`[Harness Mix] 关闭 Desktop 失败（可手动关闭后运行 npm start）：${error.message}`);
    }
  }
}

main().catch(error => {
  log(`[Harness Mix] 更新助手崩溃：${(error && error.stack) || error}`);
  process.exitCode = 1;
});
