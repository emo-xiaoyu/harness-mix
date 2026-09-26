// Entry point for the explicitly labelled online installer. Uses only Node
// built-ins until npm has downloaded the runtime dependencies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function install(app) {
  const node = path.join(app, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const npm = path.join(app, 'tools/npm/bin/npm-cli.js');
  if (!fs.existsSync(node) || !fs.existsSync(npm)) throw new Error('安装包缺少 Node 或 npm CLI');
  console.log('Harness Mix：安装时联网下载依赖，可能需要下载数百 MB，请保持网络连接。');
  const result = spawnSync(node, [npm, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: app, stdio: 'inherit', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`联网下载依赖失败：${result.error?.message || `npm 退出码 ${result.status}`}。请检查网络后重试安装。`);
  fs.writeFileSync(path.join(app, '.online-deps-ready'), 'ok\n');
}

function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function launchMac(source, args) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'online-installer.json'), 'utf8'));
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'Harness Mix', 'online');
  const name = `${manifest.version}-${manifest.arch}`;
  const target = path.join(base, name);
  const ready = path.join(target, '.online-deps-ready');
  const lock = `${target}.lock`;
  fs.mkdirSync(base, { recursive: true });
  if (!fs.existsSync(ready)) {
    const notice = spawnSync('osascript', ['-e', 'display dialog "Harness Mix 精简版将在首次打开时联网下载运行依赖，可能需要数百 MB。请保持网络连接。" buttons {"取消", "开始下载"} default button "开始下载"'], { stdio: 'ignore' });
    if (notice.status !== 0) throw new Error('已取消下载依赖');
    let owned = false;
    for (let attempt = 0; attempt < 300 && !fs.existsSync(ready); attempt += 1) {
      try {
        fs.mkdirSync(lock);
        owned = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // An interrupted first launch must not block retries forever.
        if (Date.now() - fs.statSync(lock).mtimeMs > 30 * 60 * 1000) {
          fs.rmSync(lock, { recursive: true, force: true });
        } else await sleep(1000);
      }
    }
    if (!owned && !fs.existsSync(ready)) throw new Error('另一个安装进程仍在运行；请稍后重试');
    if (owned) {
      const staging = path.join(base, `${name}.tmp-${process.pid}`);
      try {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.cpSync(source, staging, { recursive: true });
        install(staging);
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(staging, target);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(lock, { recursive: true, force: true });
      }
    }
  }
  const result = spawnSync(path.join(target, 'runtime/node'), [path.join(target, 'scripts/launch-codex.cjs'), ...args], {
    cwd: target, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function main() {
  const [mode, source, ...args] = process.argv.slice(2);
  if (mode === '--install' && source) install(path.resolve(source));
  else if (mode === '--launch-macos' && source) await launchMac(path.resolve(source), args);
  else throw new Error('用法：online-bootstrap.cjs --install <app> | --launch-macos <app> [launcher args]');
}

if (require.main === module) main().catch(error => {
  console.error(`Harness Mix 联网版：${error.message}`);
  if (process.platform === 'darwin') {
    const message = `Harness Mix 联网版：${error.message}`.replace(/["\\]/g, '').slice(0, 500);
    spawnSync('osascript', ['-e', `display dialog "${message}" buttons {"确定"} default button "确定"`], { stdio: 'ignore' });
  }
  process.exitCode = 1;
});
