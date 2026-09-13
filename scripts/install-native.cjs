const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const platform = process.platform;
const arch = process.arch;
const packageName = `@harness-mix/native-${platform}-${arch}`;
const packageRoot = path.join(root, 'node_modules', '@harness-mix', `native-${platform}-${arch}`);
const destination = path.join(root, 'output', 'native-build');
const files = platform === 'win32'
  ? ['harness-mix-shim.exe', 'harness-mix-appx.exe', 'harness-mix-secret.exe']
  : ['harness-mix-shim'];

if (!fs.existsSync(packageRoot)) {
  console.warn(`[Harness Mix] Optional native package ${packageName} is not installed; build:native can create a local Shim.`);
  process.exit(0);
}
fs.mkdirSync(destination, { recursive: true });
for (const name of files) {
  const source = path.join(packageRoot, 'bin', name);
  if (!fs.existsSync(source)) {
    console.warn(`[Harness Mix] ${packageName} contains source-only platform metadata; run npm run build:native on this machine.`);
    process.exit(0);
  }
  const target = path.join(destination, name);
  fs.copyFileSync(source, target);
  if (platform !== 'win32') fs.chmodSync(target, 0o755);
}
console.log(`[Harness Mix] Installed native runtime for ${platform}-${arch}`);
