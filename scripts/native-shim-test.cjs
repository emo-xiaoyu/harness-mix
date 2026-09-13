// Real compiled Shim with an isolated fixture host; no Desktop or account needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { nativePaths } = require('../src/main/native/config');
const { terminateTree } = require('../src/main/native/process-utils');

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hm shim spaces-'));
  const host = path.join(work, 'fixture host.cjs');
  const env = { ...process.env, HARNESS_MIX_NODE_PATH: process.execPath,
    CODEXHOST_STOCK_CODEX_PATH: process.execPath, HARNESS_MIX_HOST_SCRIPT: host, CODEX_CLI_PATH: 'must-be-removed' };
  let child;
  try {
    fs.writeFileSync(host, `const readline = require('node:readline');
if (process.env.CODEX_CLI_PATH) process.exit(90);
readline.createInterface({ input: process.stdin }).on('line', line => {
  process.stdout.write(JSON.stringify({ text: line, args: process.argv.slice(2) }) + '\\n');
}).on('close', () => process.exit(0));`);
    assert.equal(execFileSync(nativePaths().shim, ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim(), process.version);
    child = spawn(nativePaths().shim, ['app-server', 'argument with spaces'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Shim EOF/exit timed out')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    child.stdin.end('你好 Linux/macOS\n');
    assert.equal(await done, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { text: '你好 Linux/macOS', args: ['app-server', 'argument with spaces'] });
    console.log('PASS: compiled Shim routing, Unicode stdio, spaced arguments, environment and EOF');
  } finally {
    if (child && child.exitCode === null) await terminateTree(child.pid);
    fs.rmSync(work, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
