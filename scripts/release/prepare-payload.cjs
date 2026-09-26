// Assembles the self-contained installer payload for one platform/arch:
// package sources, freshly built native binaries, production node_modules and
// a bundled Node.js runtime. The layout intentionally mirrors the npm package
// root (the launcher resolves every path relative to its own package root, so
// an installed copy behaves exactly like `npm install -g @harness-mix/cli`).
//
// 用法：node prepare-payload.cjs --platform win32 --arch x64 [--out <dir>]
//       [--skip-deps] [--skip-runtime]
// 输出：<out>/payload（默认 output/installer-payload/<platform>-<arch>/payload）
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installNodeRuntime } = require('./node-runtime.cjs');

const root = path.resolve(__dirname, '../..');

// Skipped inside copied trees: Rust build artifacts and nested dependency
// installs are rebuilt for the payload itself and must never leak in.
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git']);
const EXCLUDED_PATHS = new Set(['src/main/native/rs/target']);

function parseArgs(argv) {
  const options = {
    platform: process.platform,
    arch: process.arch,
    out: null,
    skipDeps: false,
    skipRuntime: false,
    online: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--platform') options.platform = argv[++index];
    else if (flag === '--arch') options.arch = argv[++index];
    else if (flag === '--out') options.out = argv[++index];
    else if (flag === '--skip-deps') options.skipDeps = true;
    else if (flag === '--skip-runtime') options.skipRuntime = true;
    else if (flag === '--online') options.online = true;
    else throw new Error(`未知参数：${flag}`);
  }
  if (!['win32', 'darwin', 'linux'].includes(options.platform)) throw new Error(`不支持的平台：${options.platform}`);
  if (!['x64', 'arm64'].includes(options.arch)) throw new Error(`不支持的架构：${options.arch}`);
  return options;
}

function copyWithExcludes(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(destinationRoot, { recursive: true });
  const walk = (sourceDir, destinationDir) => {
    for (const entry of fs.readdirSync(sourceDir)) {
      if (EXCLUDED_SEGMENTS.has(entry)) continue;
      const source = path.join(sourceDir, entry);
      const destination = path.join(destinationDir, entry);
      const relative = path.relative(root, source).replace(/\\/g, '/');
      if (EXCLUDED_PATHS.has(relative)) continue;
      if (fs.statSync(source).isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        walk(source, destination);
      } else {
        fs.copyFileSync(source, destination);
      }
    }
  };
  walk(sourceRoot, destinationRoot);
}

// output/native-build holds stale copies and local logs alongside the real
// artifacts; only the shipped whitelist (mirroring the npm `files` entries)
// enters the payload.
const NATIVE_BUILD_FILES = new Set([
  'harness-mix-shim',
  'harness-mix-shim.exe',
  'harness-mix-appx.exe',
  'harness-mix-secret.exe',
  'renderer-extension.js',
  'desktop-controller.mjs',
]);

function copyNativeBuild(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const entry of fs.readdirSync(sourceRoot)) {
    if (!NATIVE_BUILD_FILES.has(entry)) continue;
    const source = path.join(sourceRoot, entry);
    if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(destinationRoot, entry));
  }
}

// The repo's Start-Codex.cmd shells out to npm; an installed copy has no npm
// project (and may have no npm at all), so the payload ships a variant that
// drives the launcher through the bundled runtime directly.
function writeStartCommand(payload) {
  fs.writeFileSync(path.join(payload, 'Start-Codex.cmd'), [
    '@echo off',
    'title Harness Mix - Codex Native Launcher',
    'cd /d "%~dp0"',
    '"runtime\\node.exe" "scripts\\launch-codex.cjs" %*',
    'pause',
    '',
  ].join('\r\n'));
}

// The staged package.json keeps runtime metadata only: no workspaces, no dev
// dependencies and no lifecycle scripts — the payload's own postinstall would
// race with the freshly built native binaries shipped in output/native-build.
function writeStagedPackageJson(destination) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const staged = {
    name: source.name,
    version: source.version,
    license: source.license,
    description: source.description,
    homepage: source.homepage,
    repository: source.repository,
    os: source.os,
    cpu: source.cpu,
    engines: source.engines,
    dependencies: source.dependencies,
    optionalDependencies: source.optionalDependencies,
  };
  fs.writeFileSync(path.join(destination, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);
}

function npmCommand() {
  const localCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(localCli)) return { command: process.execPath, args: [localCli], shell: false };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: true };
}

function installProductionDependencies(payload) {
  const npm = npmCommand();
  const run = spawnSync(npm.command, [...npm.args, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: payload,
    stdio: 'inherit',
    shell: npm.shell,
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(`payload 生产依赖安装失败（exit ${run.status}）`);
}

function bundleNpm(payload) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm'),
    process.env.HARNESS_MIX_NPM_ROOT,
  ].filter(Boolean);
  const npmRoot = candidates.find(candidate => fs.existsSync(path.join(candidate, 'bin/npm-cli.js')));
  if (!npmRoot) throw new Error('联网版需要构建机上的 npm CLI；设置 HARNESS_MIX_NPM_ROOT 指向 npm 包目录');
  const destination = path.join(payload, 'tools/npm');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['bin', 'lib', 'node_modules', 'package.json', 'LICENSE']) {
    const source = path.join(npmRoot, name);
    if (!fs.existsSync(source)) throw new Error(`npm 包缺少 ${name}`);
    fs.cpSync(source, path.join(destination, name), { recursive: true });
  }
  if (!fs.existsSync(path.join(destination, 'lib/cli.js'))) throw new Error('捆绑的 npm CLI 不完整');
}

function nativeBinaries(platform) {
  return platform === 'win32'
    ? ['harness-mix-shim.exe', 'harness-mix-appx.exe', 'harness-mix-secret.exe']
    : ['harness-mix-shim'];
}

function verifyPayload(payload, platform) {
  const required = [
    ...nativeBinaries(platform).map(name => path.join('output/native-build', name)),
    'output/native-build/renderer-extension.js',
    'output/native-build/desktop-controller.mjs',
    'scripts/launch-codex.cjs',
    'scripts/native-host.cjs',
    'src/main/native/host.js',
    'config/codex-desktop-compatibility.json',
    'resources/harness-mix.ico',
    platform === 'win32' ? 'runtime/node.exe' : 'runtime/node',
    ...(fs.existsSync(path.join(payload, 'online-installer.json')) ? ['tools/npm/bin/npm-cli.js', 'scripts/release/online-bootstrap.cjs'] : []),
  ];
  const missing = required.filter(file => !fs.existsSync(path.join(payload, file)));
  if (missing.length) {
    throw new Error(`payload 缺少必需文件（先运行 npm run build:native）：\n${missing.map(file => `  - ${file}`).join('\n')}`);
  }
}

function directorySize(directory) {
  let total = 0;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(directory);
  return total;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = options.out ? path.resolve(options.out) : path.join(root, 'output', 'installer-payload', `${options.platform}-${options.arch}${options.online ? '-online' : ''}`);
  const payload = path.join(out, 'payload');
  fs.rmSync(payload, { recursive: true, force: true });
  fs.mkdirSync(payload, { recursive: true });

  console.log(`[Harness Mix] 组装 payload：${options.platform}-${options.arch} -> ${path.relative(root, payload)}`);
  for (const name of ['CHANGELOG.md', 'NOTICE']) {
    if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(payload, name));
  }
  writeStartCommand(payload);
  for (const name of ['src', 'scripts', 'config', 'docs', 'licenses']) {
    copyWithExcludes(path.join(root, name), path.join(payload, name));
  }
  copyNativeBuild(path.join(root, 'output/native-build'), path.join(payload, 'output/native-build'));
  fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/release/brand/harness-mix.ico'), path.join(payload, 'resources/harness-mix.ico'));
  writeStagedPackageJson(payload);

  if (options.online) {
    fs.writeFileSync(path.join(payload, 'online-installer.json'), JSON.stringify({ version: JSON.parse(fs.readFileSync(path.join(payload, 'package.json'))).version, platform: options.platform, arch: options.arch }) + '\n');
    bundleNpm(payload);
    console.log('[Harness Mix] 联网版：安装时再下载生产依赖');
  } else if (options.skipDeps) {
    console.log('[Harness Mix] 跳过生产依赖安装（--skip-deps）');
  } else {
    console.log('[Harness Mix] 安装 payload 生产依赖…');
    installProductionDependencies(payload);
  }

  const runtimeBinary = options.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node';
  if (options.skipRuntime) {
    console.log('[Harness Mix] 跳过 Node 运行时下载（--skip-runtime）');
  } else {
    console.log('[Harness Mix] 获取 Node 运行时…');
    const result = await installNodeRuntime({
      platform: options.platform,
      arch: options.arch,
      destination: path.join(payload, runtimeBinary),
    });
    console.log(`[Harness Mix] Node v${result.version} 已放入 ${runtimeBinary}`);
  }

  verifyPayload(payload, options.platform);
  const size = directorySize(payload);
  console.log(`[Harness Mix] payload 就绪：${(size / 1024 / 1024).toFixed(1)} MB（${path.relative(root, payload)}）`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
