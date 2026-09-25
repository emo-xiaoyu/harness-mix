// Downloads the official Node.js runtime that ships inside the installer
// payload. Every download is verified against the matching SHASUMS256.txt
// before extraction; archives are cached under output/installer-cache/ so
// repeated packaging runs stay offline-friendly. HARNESS_MIX_NODE_VERSION
// pins an exact release; otherwise the newest v24 release on nodejs.org
// (matching the launcher's engines range) is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const distBase = (process.env.HARNESS_MIX_NODE_DIST || 'https://nodejs.org/dist').replace(/\/+$/, '');
const cacheRoot = path.join(root, 'output', 'installer-cache', 'node');

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
  throw new Error(`下载失败（已重试 ${attempts} 次）：${lastError.message}`);
}

async function resolveVersion() {
  if (process.env.HARNESS_MIX_NODE_VERSION) return process.env.HARNESS_MIX_NODE_VERSION.replace(/^v/, '');
  const index = JSON.parse((await fetchWithRetry(`${distBase}/index.json`, 2)).toString('utf8'));
  const entry = index.find(item => typeof item.version === 'string' && item.version.startsWith('v24.'));
  if (!entry) throw new Error('nodejs.org dist 索引中没有找到 v24 系列版本');
  return entry.version.replace(/^v/, '');
}

function archiveName(version, platform, arch) {
  return platform === 'win32'
    ? `node-v${version}-win-${arch}.zip`
    : `node-v${version}-${platform}-${arch}.tar.gz`;
}

async function fetchVerifiedArchive(version, platform, arch) {
  const name = archiveName(version, platform, arch);
  const destination = path.join(cacheRoot, name);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return destination;
  const shasums = (await fetchWithRetry(`${distBase}/v${version}/SHASUMS256.txt`, 2)).toString('utf8');
  const line = shasums.split('\n').find(row => row.trimEnd().endsWith(`  ${name}`));
  if (!line) throw new Error(`SHASUMS256.txt 中没有 ${name} 的校验项`);
  const expected = line.trim().split(/\s+/)[0];
  const archive = await fetchWithRetry(`${distBase}/v${version}/${name}`);
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`${name} sha256 校验失败：期望 ${expected}，实际 ${actual}`);
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(destination, archive);
  return destination;
}

function extractBinary(platform, version, arch, archivePath, destination) {
  const staging = path.join(cacheRoot, `extract-${platform}-${arch}-${version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // On Windows, System32's bsdtar understands zip archives and drive-letter
  // paths; GNU tar (Git Bash) would misread "E:\..." as a remote host spec.
  let cmd = 'tar';
  let args = platform === 'win32' ? ['-xf', archivePath, '-C', staging] : ['-xzf', archivePath, '-C', staging];
  if (platform === 'win32') {
    const bsdtar = `${process.env.SystemRoot || 'C:/Windows'}\\System32\\tar.exe`;
    if (fs.existsSync(bsdtar)) cmd = bsdtar;
    else args = [...args, '--force-local'];
  }
  const run = spawnSync(cmd, args, { stdio: 'pipe', windowsHide: true });
  if (run.status !== 0) throw new Error(`tar 解压失败：${run.stderr?.toString().trim() || run.status}`);
  const folder = `node-v${version}${platform === 'win32' ? `-win-${arch}` : `-${platform}-${arch}`}`;
  const binary = platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  const extracted = path.join(staging, folder, binary);
  if (!fs.existsSync(extracted)) throw new Error(`解压结果缺少 ${binary}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(extracted, destination);
  if (platform !== 'win32') fs.chmodSync(destination, 0o755);
  fs.rmSync(staging, { recursive: true, force: true });
}

async function installNodeRuntime({ platform = process.platform, arch = process.arch, destination }) {
  const version = await resolveVersion();
  const archivePath = await fetchVerifiedArchive(version, platform, arch);
  extractBinary(platform, version, arch, archivePath, destination);
  return { version, destination };
}

async function main() {
  const [platform, arch, destination] = process.argv.slice(2);
  if (!platform || !arch || !destination) {
    console.error('用法：node node-runtime.cjs <platform> <arch> <目标文件路径>');
    process.exitCode = 1;
    return;
  }
  const result = await installNodeRuntime({ platform, arch, destination: path.resolve(destination) });
  console.log(`[Harness Mix] 已就位 Node 运行时 v${result.version} -> ${result.destination}`);
}

module.exports = { installNodeRuntime };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
