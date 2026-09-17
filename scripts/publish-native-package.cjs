const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [platform = process.platform, arch = process.arch, ...flags] = process.argv.slice(2);
const allowed = new Set(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
const key = `${platform}-${arch}`;
if (!allowed.has(key)) throw new Error(`Unsupported native package target: ${key}`);
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'native-build');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-native-package-'));
const pkg = path.join(work, 'package');
fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const names = platform === 'win32' ? ['harness-mix-shim.exe', 'harness-mix-appx.exe', 'harness-mix-secret.exe'] : ['harness-mix-shim'];
const sourceOnly = flags.includes('--source-only');
if (!sourceOnly) {
  for (const name of names) {
    const source = path.join(output, name);
    if (!fs.existsSync(source)) throw new Error(`Missing ${source}; build the target runtime first (or use --source-only)`);
    fs.copyFileSync(source, path.join(pkg, 'bin', name));
  }
}
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
  name: `@harness-mix/native-${key}`, version, description: `Harness Mix native runtime for ${key}${sourceOnly ? ' (source-only; build locally)' : ''}`,
  license: '(Apache-2.0 OR MIT)', os: [platform], cpu: [arch], files: ['bin'], publishConfig: { access: 'public' },
}, null, 2) + '\n');
fs.writeFileSync(path.join(pkg, 'README.md'), `# @harness-mix/native-${key}\n\nNative runtime selected automatically by @harness-mix/cli.\n`);
const publish = flags.includes('--publish');
const npmArgs = ['pack', '--json'];
if (publish) npmArgs.splice(0, npmArgs.length, 'publish', '--access', 'public', '--registry=https://registry.npmjs.org');
const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs] : npmArgs;
const result = execFileSync(npmCommand, commandArgs, { cwd: pkg, encoding: 'utf8', stdio: 'pipe' });
process.stdout.write(result);
console.log(`${publish ? 'Published' : 'Packed'} @harness-mix/native-${key}@${version}`);
