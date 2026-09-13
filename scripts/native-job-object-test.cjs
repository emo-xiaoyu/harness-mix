// Job Object supervision e2e: a shim hard-killed with taskkill must take its
// whole descendant tree down (node host + its long-lived grandchild), because
// the shim assigns itself to a KILL_ON_JOB_CLOSE job at startup.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const candidates = [
  process.env.HARNESS_MIX_SHIM_EXE,
  path.join(root, 'output/native-build/harness-mix-shim.exe'),
  path.join(root, 'src/main/native/rs/target/release/harness-mix-shim.exe'),
].filter(Boolean);
const shim = candidates.find(candidate => fs.existsSync(candidate));
if (!shim) {
  console.log('SKIP native-job-object: shim binary missing; run npm run build:native first');
  process.exit(0);
}

const wait = async (check, timeoutMs, label) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-job-'));
  // Fixture "host": spawns a long-lived grandchild, records both pids, idles.
  const fixture = path.join(work, 'fake-host.cjs');
  fs.writeFileSync(fixture, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'fs.writeFileSync(process.env.FAKE_HOST_PIDS, JSON.stringify({ host: process.pid, child: grandchild.pid }));',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const pidFile = path.join(work, 'pids.json');
  let stderr = '';
  const shimProcess = spawn(shim, ['app-server'], {
    env: {
      ...process.env,
      HARNESS_MIX_HOST_SCRIPT: fixture,
      HARNESS_MIX_NODE_PATH: process.execPath,
      CODEXHOST_STOCK_CODEX_PATH: process.execPath,
      FAKE_HOST_PIDS: pidFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  shimProcess.stderr.setEncoding('utf8');
  shimProcess.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await wait(() => fs.existsSync(pidFile), 10000, 'fixture host to record pids');
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(shimProcess.pid), 'shim should be running');
    assert.ok(alive(pids.host), 'fixture host should be running');
    assert.ok(alive(pids.child), 'grandchild should be running');

    // Hard-kill the shim (no graceful shutdown): the job must reap the tree.
    spawnSync('taskkill.exe', ['/PID', String(shimProcess.pid), '/F'], { windowsHide: true });
    await wait(() => !alive(shimProcess.pid), 5000, 'shim to die');
    await wait(() => !alive(pids.host), 5000, 'fixture host to die with the shim');
    await wait(() => !alive(pids.child), 5000, 'grandchild to die with the shim');
    assert.ok(!stderr.includes('process supervision unavailable'), `shim reported job failure: ${stderr.trim()}`);
    console.log(`native-job-object: hard-killed shim ${shimProcess.pid}; host ${pids.host} + grandchild ${pids.child} reaped by the kill-on-close job`);
  } finally {
    try { shimProcess.kill(); } catch { /* already gone */ }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
