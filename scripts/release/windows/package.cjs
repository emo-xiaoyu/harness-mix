// Compiles the Windows installer: assembles the per-arch payload, then feeds
// it to Inno Setup (ISCC.exe) with version and architecture injected. The
// resulting setup runs per-user (no admin), installs under
// %LOCALAPPDATA%\Programs\Harness Mix and creates a Start Menu shortcut that
// launches the bundled Node runtime against scripts/launch-codex.cjs.
//
// 用法：node package.cjs [--arch x64|arm64] [--skip-prepare]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');

function parseArgs(argv) {
  const options = { arch: process.arch, skipPrepare: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--arch') options.arch = argv[++index];
    else if (flag === '--skip-prepare') options.skipPrepare = true;
    else throw new Error(`未知参数：${flag}`);
  }
  if (!['x64', 'arm64'].includes(options.arch)) throw new Error(`不支持的架构：${options.arch}`);
  return options;
}

function locateIscc() {
  const candidates = [
    process.env.HARNESS_MIX_ISCC,
    'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
    'C:/Program Files/Inno Setup 6/ISCC.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const where = spawnSync('where.exe', ['iscc'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) {
    const found = where.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
    if (found) return found;
  }
  throw new Error('未找到 Inno Setup 6（ISCC.exe）。请安装：winget install JRSoftware.InnoSetup 或 choco install innosetup，或用 HARNESS_MIX_ISCC 指定 ISCC.exe 路径。');
}

function assemblePayload(arch, skipPrepare) {
  if (skipPrepare) {
    const existing = path.join(root, 'output', 'installer-payload', `win32-${arch}`, 'payload');
    if (!fs.existsSync(path.join(existing, 'runtime', 'node.exe'))) {
      throw new Error(`--skip-prepare 需要已就绪的 payload：${existing}`);
    }
    return existing;
  }
  const prepare = path.join(root, 'scripts/release/prepare-payload.cjs');
  const run = spawnSync(process.execPath, [prepare, '--platform', 'win32', '--arch', arch], { stdio: 'inherit', windowsHide: true });
  if (run.status !== 0) throw new Error(`payload 组装失败（exit ${run.status}）`);
  return path.join(root, 'output', 'installer-payload', `win32-${arch}`, 'payload');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payloadRoot = assemblePayload(options.arch, options.skipPrepare);
  const iscc = locateIscc();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const outputDirectory = path.join(root, 'output', 'installers');
  fs.mkdirSync(outputDirectory, { recursive: true });

  console.log(`[Harness Mix] 编译 Windows 安装器：${version} ${options.arch}`);
  const arm64 = options.arch === 'arm64';
  const run = spawnSync(iscc, [
    path.join(root, 'scripts/release/windows/Installer.iss'),
    `/DPayloadRoot=${payloadRoot}`,
    `/DProductVersion=${version}`,
    `/DArch=${options.arch}`,
    `/DArchAllowed=${arm64 ? 'arm64' : 'x64compatible'}`,
    `/DArch64Bit=${arm64 ? 'arm64' : 'x64compatible'}`,
    `/O${outputDirectory}`,
  ], { stdio: 'inherit', windowsHide: true });
  if (run.status !== 0) throw new Error(`ISCC 编译失败（exit ${run.status}）`);

  const installer = path.join(outputDirectory, `harness-mix-${version}-windows-${options.arch}.exe`);
  if (!fs.existsSync(installer)) throw new Error(`ISCC 未产出预期的安装器文件：${installer}`);
  console.log(`[Harness Mix] Windows 安装器完成：${installer} (${(fs.statSync(installer).size / 1024 / 1024).toFixed(1)} MB)`);
}

if (require.main === module) main();
