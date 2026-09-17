const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const DATA_DIRECTORY_NAME = 'harnessmix';
// Kernel data used to live in a nested `<base>/harness-mix/codexhost` directory.
// That component name is gone, so an existing install is relocated once instead
// of silently starting from an empty directory.
const LEGACY_DATA_DIRECTORY_PARTS = [['harness-mix', 'codexhost']];
// Files whose presence proves the target already holds live kernel data.
const DATA_DIRECTORY_MARKERS = ['mix-core', 'mapping-store', 'codex-accounts', 'runtime', 'secrets.dat'];

function dataBase(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return env.APPDATA || home;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
}

function dataDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.HARNESSMIX_DATA_DIR) return env.HARNESSMIX_DATA_DIR;
  return path.join(dataBase(env, platform, home), DATA_DIRECTORY_NAME);
}

function legacyDataDirectories(env = process.env, platform = process.platform, home = os.homedir()) {
  // An explicit HARNESSMIX_DATA_DIR is a deliberate choice; never relocate around it.
  if (env.HARNESSMIX_DATA_DIR) return [];
  return LEGACY_DATA_DIRECTORY_PARTS.map(parts => path.join(dataBase(env, platform, home), ...parts));
}

function holdsKernelData(directory) {
  return DATA_DIRECTORY_MARKERS.some(name => fs.existsSync(path.join(directory, name)));
}

function relocateEntries(source, target) {
  const moved = [];
  const copied = [];
  const skipped = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (fs.existsSync(to)) { skipped.push(entry.name); continue; }
    try {
      fs.renameSync(from, to);
      moved.push(entry.name);
    } catch {
      // A locked file, or a base directory on another volume: copy and leave the
      // original untouched so nothing is ever lost to a half-finished move.
      try {
        fs.cpSync(from, to, { recursive: true, errorOnExist: false });
        copied.push(entry.name);
      } catch { skipped.push(entry.name); }
    }
  }
  return { moved, copied, skipped };
}

// Relocates a pre-rename data directory into its current home. Idempotent: it is
// a no-op once the target holds kernel data, and it never overwrites a file that
// already exists at the destination.
function migrateLegacyDataDirectory({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  target = dataDirectory(env, platform, home),
  now = Date.now(),
  log = () => {},
} = {}) {
  if (holdsKernelData(target)) return { status: 'current', target, source: null, moved: [], copied: [], skipped: [] };
  for (const source of legacyDataDirectories(env, platform, home)) {
    if (!fs.existsSync(source) || !fs.readdirSync(source).length) continue;
    fs.mkdirSync(target, { recursive: true });
    const { moved, copied, skipped } = relocateEntries(source, target);
    fs.writeFileSync(path.join(target, 'data-directory-migration.json'), `${JSON.stringify({
      migratedAt: new Date(now).toISOString(), source, target, moved, copied, skipped,
    }, null, 2)}\n`);
    log(`[Harness Mix] 数据目录已迁移：${source} → ${target}（移动 ${moved.length} 项，复制 ${copied.length} 项，保留 ${skipped.length} 项）`);
    return { status: 'migrated', target, source, moved, copied, skipped };
  }
  return { status: 'none', target, source: null, moved: [], copied: [], skipped: [] };
}

function executableName(name, platform = process.platform) {
  return name + (platform === 'win32' ? '.exe' : '');
}

function requireExecutable(file, label) {
  if (!file || !path.isAbsolute(file)) throw new Error(`${label} must be an absolute executable path`);
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file');
    fs.accessSync(file, fs.constants.X_OK);
  } catch { throw new Error(`${label} is missing or not executable: ${file}`); }
  return fs.realpathSync(file);
}

// Never modify a signed app bundle or guess a Linux download/vendor URL.
function inspectPosix(env = process.env, platform = process.platform, run = execFileSync) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  let executable = env.HARNESS_MIX_DESKTOP_EXECUTABLE;
  let stock = env.HARNESSMIX_STOCK_CODEX_PATH;
  let version = env.HARNESS_MIX_DESKTOP_VERSION;
  let root;
  if (platform === 'darwin') {
    root = env.HARNESS_MIX_DESKTOP_APP || ['/Applications/Codex.app', path.join(os.homedir(), 'Applications/Codex.app')].find(file => fs.existsSync(file));
    if (root) {
      const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Contents/Info.plist')], { encoding: 'utf8' }));
      if (!executable && (typeof plist.CFBundleExecutable !== 'string' || !plist.CFBundleExecutable || /[\\/]/.test(plist.CFBundleExecutable))) throw new Error('Invalid CFBundleExecutable in Codex Info.plist');
      executable ||= path.join(root, 'Contents/MacOS', plist.CFBundleExecutable);
      stock ||= path.join(root, 'Contents/Resources/codex');
      version ||= plist.CFBundleShortVersionString || plist.CFBundleVersion;
    }
  }
  if (!executable || !stock) throw new Error('Install Codex Desktop first. On Linux set HARNESS_MIX_DESKTOP_EXECUTABLE and HARNESSMIX_STOCK_CODEX_PATH to absolute paths of a compatible Electron desktop and its bundled Codex CLI; Linux desktop availability is not guaranteed. On macOS set HARNESS_MIX_DESKTOP_APP if the .app is outside Applications.');
  executable = requireExecutable(executable, 'HARNESS_MIX_DESKTOP_EXECUTABLE');
  stock = requireExecutable(stock, 'HARNESSMIX_STOCK_CODEX_PATH');
  if (version && !/^\d+(?:\.\d+){1,3}$/.test(String(version))) throw new Error('HARNESS_MIX_DESKTOP_VERSION must be a numeric desktop version');
  return { root: root || path.dirname(executable), executable, stock, version: String(version || 'unknown'), platform };
}

function assertDesktopStopped(installation) {
  // An existing Electron singleton would silently discard the new CLI environment.
  // macOS comm is a path; Linux comm is only a name, so resolve /proc/PID/exe.
  const rows = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'comm='], { encoding: 'utf8' });
  for (const row of rows.split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid) continue;
    let file = match[2];
    try { file = fs.realpathSync(process.platform === 'linux' ? `/proc/${match[1]}/exe` : file); } catch { /* inaccessible process */ }
    if (file === installation.executable) throw new Error(`Quit Codex Desktop (PID ${match[1]}) before launching Harness Mix so the Shim environment can take effect.`);
  }
}

module.exports = {
  dataDirectory,
  legacyDataDirectories,
  migrateLegacyDataDirectory,
  executableName,
  inspectPosix,
  assertDesktopStopped,
};
