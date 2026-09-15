const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const os = require('node:os');
const { executableName } = require('../src/main/native/platform');
const { getAllIconsDictionary, MODEL_FAMILIES } = require('../src/main/native/icons');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/native-build');

function cargoCommand() {
  const candidates = ['cargo', path.join(os.homedir(), '.cargo/bin', executableName('cargo'))];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true });
      return candidate;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Rust toolchain (cargo) not found; install via https://rustup.rs (use the x86_64-pc-windows-gnu host when Visual Studio Build Tools are absent)');
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const alias = { '@codexhost/shared-contracts': path.join(root, 'src/native-ui/shared-contracts/src/index.ts') };
  const common = { bundle: true, alias, logLevel: 'warning', target: 'es2024' };
  const icons = getAllIconsDictionary();
  icons.harnesses['claude-code'] = icons.harnesses.claude;
  icons.harnesses['deepseek-harness'] = icons.harnesses.dsh;
  await esbuild.build({ ...common, entryPoints: ['src/native-ui/renderer-extension/src/production-entry.ts'],
    platform: 'browser', format: 'iife', outfile: path.join(out, 'renderer-extension.js'),
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.css': 'text' },
    banner: { js: `globalThis.__HARNESS_MIX_ICONS__=${JSON.stringify(icons)};globalThis.__HARNESS_MIX_MODEL_FAMILIES__=${JSON.stringify(MODEL_FAMILIES.map(f => ({ id: f.id, pattern: f.regex.source })))};` } });
  await esbuild.build({ ...common, entryPoints: ['src/native-ui/desktop-control/src/release-main.ts'],
    platform: 'node', format: 'esm', outfile: path.join(out, 'desktop-controller.mjs') });
  execFileSync(cargoCommand(), ['build', '--release', '--manifest-path', path.join(root, 'src/main/native/rs/Cargo.toml'),
    ...(process.platform === 'win32' ? [] : ['--package', 'harness-mix-shim'])], { stdio: 'inherit', windowsHide: true });
  const target = path.join(root, 'src/main/native/rs/target/release');
  for (const exe of process.platform === 'win32' ? ['harness-mix-shim.exe', 'harness-mix-appx.exe', 'harness-mix-secret.exe'] : ['harness-mix-shim']) {
    const source = path.join(target, exe);
    const destination = path.join(out, exe);
    // An unchanged executable may be running while UI-only fixes are built.
    try {
      fs.copyFileSync(source, destination);
      if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
    } catch (err) {
      if (err && err.code === 'EBUSY') {
        console.warn(`[build:native] Notice: ${exe} is in use, keeping existing binary.`);
      } else {
        throw err;
      }
    }
  }
  fs.writeFileSync(path.join(out, 'node-path.txt'), process.execPath);
  console.log('Harness Mix local Renderer, Desktop Controller and Shim built.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
