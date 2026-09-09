const { spawn } = require('node:child_process');
const path = require('node:path');
const root = process.env.HARNESS_MIX_DSH_ROOT;
const entry = root ? ['--import', 'tsx/esm', path.join(root, 'apps/cli/src/bin.ts')] : [require.resolve('@deepseek-ai/dsh/lib/bin.js')];
const child = spawn(process.execPath, [...entry, ...process.argv.slice(2)], {
  cwd: root || process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
