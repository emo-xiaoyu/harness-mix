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
  const stockProbe = path.join(work, 'stock probe.cjs');
  const env = { ...process.env, HARNESS_MIX_NODE_PATH: process.execPath,
    CODEXHOST_STOCK_CODEX_PATH: process.execPath, HARNESS_MIX_HOST_SCRIPT: host, CODEX_CLI_PATH: 'must-be-removed' };
  let child;
  try {
    fs.writeFileSync(host, `const readline = require('node:readline');
if (process.env.CODEX_CLI_PATH) process.exit(90);
readline.createInterface({ input: process.stdin }).on('line', line => {
  process.stdout.write(JSON.stringify({ text: line, args: process.argv.slice(2) }) + '\\n');
}).on('close', () => process.exit(0));`);
    fs.writeFileSync(stockProbe, `process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(0);`);
    const passthrough = args => execFileSync(nativePaths().shim, args, { env, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(passthrough(['--version']), process.version);
    const probeEnv = { ...env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(stockProbe)}`].filter(Boolean).join(' ') };
    const probeStock = args => JSON.parse(execFileSync(nativePaths().shim, args, { env: probeEnv, encoding: 'utf8', timeout: 10000 }));
    const assertStock = (args, message) => {
      const observed = probeStock(args);
      assert.equal(observed.length, args.length, message);
      assert.equal(path.basename(observed[0]), args[0], message);
      assert.deepEqual(observed.slice(1), args.slice(1), message);
    };
    assertStock(['app-server', 'proxy'], 'app-server proxy stays on the official CLI');
    assertStock(['app-server', 'daemon'], 'app-server daemon stays on the official CLI');
    assertStock(['app-server', '--future-option'], 'unknown app-server forms fail open to the official CLI');
    assertStock(['exec', 'app-server'], 'an argument named app-server is not treated as the subcommand');
    const serverArgs = ['-c', 'feature.label=argument with spaces', 'app-server', '--listen', 'stdio://', '--analytics-default-enabled'];
    child = spawn(nativePaths().shim, serverArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    assert.deepEqual(JSON.parse(stdout), { text: '你好 Linux/macOS', args: serverArgs });
    console.log('PASS: precise app-server routing, official management passthrough, Unicode stdio, arguments, environment and EOF');
  } finally {
    if (child && child.exitCode === null) await terminateTree(child.pid);
    fs.rmSync(work, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
