// Update v2 coverage: state file / lock / channel detection / semver, plus the
// runUpdateFlow orchestration with mocked deps. Fully offline; no real npm/git.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  acquireLock, compareVersions, detectChannel, markBootOk, readState, writeState,
} = require('../src/main/native/update-state');
const { fetchLatestVersion, runUpdateFlow } = require('../src/main/native/updater');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const quiet = () => {};
const delay = () => Promise.resolve();
const fetchVersion = version => async () => ({
  ok: true, status: 200,
  json: async () => ({ 'dist-tags': { latest: version } }),
  headers: { get: () => null },
});
const npmFixture = (version = '0.1.0') => {
  const root = path.join(tmp('hm-npm-'), 'node_modules', 'harness-mix');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'harness-mix', version }));
  return root;
};
const npmRun = (root, { install = { status: 0 } } = {}) => (cmd, args) => {
  if (args[0] === 'root') return { status: 0, stdout: `${path.dirname(root)}\n` };
  if (args[0] === 'config') return { status: 0, stdout: 'https://registry.test/\n' };
  if (args[0] === 'install') return install;
  return { status: 0, stdout: '' };
};

(async () => {
  // --- semver / channel detection ---
  assert.equal(compareVersions('0.2.0', '0.1.1'), 1);
  assert.equal(compareVersions('0.1.1', '0.1.1'), 0);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.1'), 1);

  const gitRoot = tmp('hm-git-');
  fs.mkdirSync(path.join(gitRoot, '.git'));
  assert.equal(detectChannel(gitRoot), 'git');
  assert.equal(detectChannel(npmFixture()), 'npm');
  assert.equal(detectChannel(tmp('hm-plain-')), 'portable');

  // --- state file tolerates corruption; lock lifecycle incl. stale reap ---
  const data = tmp('hm-data-');
  fs.writeFileSync(path.join(data, 'update-state.json'), '{not json');
  assert.equal(readState(data).phase, 'idle');
  const release = acquireLock(data, 'test');
  assert.throws(() => acquireLock(data, 'test'), /更新锁/);
  release();
  acquireLock(data, 'test')();
  fs.writeFileSync(path.join(data, 'update.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() - 31 * 60 * 1000, op: 'stale' }));
  acquireLock(data, 'test')(); // stale locks are reaped even when the pid still lives
  writeState(data, { ...readState(data), appliedVersion: '0.2.0', appliedAt: Date.now() - 1000, attempts: 3 });
  markBootOk(data);
  assert.equal(readState(data).attempts, 0);
  assert.ok(readState(data).lastBootOkAt > 0);

  // --- fetchLatestVersion: etag cache answers 304 from disk ---
  {
    const dir = tmp('hm-etag-');
    const first = await fetchLatestVersion({
      registry: 'https://registry.test/', dataDir: dir,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '9.9.9' } }), headers: { get: name => (name === 'etag' ? '"e1"' : null) } }),
    });
    assert.equal(first, '9.9.9');
    const second = await fetchLatestVersion({
      registry: 'https://registry.test/', dataDir: dir,
      fetchImpl: async () => ({ ok: false, status: 304, headers: { get: () => null } }),
    });
    assert.equal(second, '9.9.9');
  }

  // --- npm: update available -> applied, restart required ---
  {
    const root = npmFixture();
    const dir = tmp('hm-flow-');
    const calls = [];
    const run = (cmd, args) => { calls.push(args.join(' ')); return npmRun(root)(cmd, args); };
    let stopped = 0;
    const outcome = await runUpdateFlow({
      root, dataDir: dir, log: quiet, stopDesktop: async () => { stopped += 1; }, mode: 'apply',
      deps: { run, fetchImpl: fetchVersion('0.2.0'), delay, env: {} },
    });
    assert.equal(outcome.updated, true);
    assert.equal(outcome.to, '0.2.0');
    assert.equal(outcome.restartRequired, true);
    assert.equal(stopped, 1);
    assert.ok(calls.some(call => call.startsWith('install -g harness-mix@0.2.0')));
    const state = readState(dir);
    assert.equal(state.appliedVersion, '0.2.0');
    assert.equal(state.prevVersion, '0.1.0');
    assert.equal(state.phase, 'idle');
  }

  // --- npm: install failure -> pending for the next launch, never blocks ---
  {
    const root = npmFixture();
    const dir = tmp('hm-flow-');
    const outcome = await runUpdateFlow({
      root, dataDir: dir, log: quiet, stopDesktop: async () => {}, mode: 'apply',
      deps: { run: npmRun(root, { install: { status: 1, stderr: 'EBUSY: file locked' } }), fetchImpl: fetchVersion('0.2.0'), delay, env: {} },
    });
    assert.equal(outcome.updated, false);
    assert.equal(outcome.pending, '0.2.0');
    assert.equal(outcome.restartRequired, undefined);
    assert.equal(readState(dir).pendingVersion, '0.2.0');
  }

  // --- npm: registry offline -> failed, launch continues ---
  {
    const root = npmFixture();
    const dir = tmp('hm-flow-');
    const outcome = await runUpdateFlow({
      root, dataDir: dir, log: quiet, stopDesktop: async () => {}, mode: 'apply',
      deps: { run: npmRun(root), fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, delay, env: {} },
    });
    assert.equal(outcome.failed, true);
    assert.equal(outcome.restartRequired, undefined);
  }

  // --- update lock held elsewhere -> skip without touching the desktop ---
  {
    const root = npmFixture();
    const dir = tmp('hm-flow-');
    fs.writeFileSync(path.join(dir, 'update.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), op: 'other' }));
    let stopped = 0;
    const outcome = await runUpdateFlow({
      root, dataDir: dir, log: quiet, stopDesktop: async () => { stopped += 1; }, mode: 'apply',
      deps: { run: npmRun(root), fetchImpl: fetchVersion('0.2.0'), delay, env: {} },
    });
    assert.equal(outcome.failed, true);
    assert.equal(outcome.reason, 'lock');
    assert.equal(stopped, 0);
  }

  // --- crash loop: second failed boot rolls back to prevVersion ---
  {
    const root = npmFixture('0.2.0'); // the installed tree currently runs 0.2.0
    const dir = tmp('hm-flow-');
    writeState(dir, { ...readState(dir), channel: 'npm', appliedVersion: '0.2.0', prevVersion: '0.1.0', appliedAt: Date.now() - 1000, lastBootOkAt: 0, attempts: 1 });
    const calls = [];
    const run = (cmd, args) => { calls.push(args.join(' ')); return npmRun(root)(cmd, args); };
    const outcome = await runUpdateFlow({
      root, dataDir: dir, log: quiet, stopDesktop: async () => {}, mode: 'apply',
      deps: { run, fetchImpl: async () => { throw new Error('offline'); }, delay, env: {} },
    });
    assert.equal(outcome.rolledBack, true);
    assert.equal(outcome.restartRequired, true);
    assert.ok(calls.some(call => call.startsWith('install -g harness-mix@0.1.0')));
    const state = readState(dir);
    assert.equal(state.appliedVersion, null);
    assert.equal(state.prevVersion, null);
    assert.equal(state.attempts, 0);
  }

  // --- git: fast-forward applies and asks for a restart ---
  {
    const root = tmp('hm-git-flow-');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'harness-mix', version: '0.1.1' }));
    const dir = tmp('hm-flow-');
    const script = {
      'rev-parse HEAD': 'aaa111\n',
      'rev-parse --abbrev-ref': 'origin/main\n',
      fetch: '',
      'rev-parse origin/main': 'bbb222\n',
      'merge-base': 'aaa111\n',
      status: '',
      'diff --name-only': 'docs/x.md\n',
      'merge --ff-only': '',
    };
    const calls = [];
    const exec = (cmd, args) => {
      const key = args.join(' ');
      calls.push(key);
      for (const [prefix, stdout] of Object.entries(script)) if (key.startsWith(prefix)) return { status: 0, stdout, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const outcome = await runUpdateFlow({
      root, dataDir: dir, log: quiet, stopDesktop: async () => {}, mode: 'apply',
      deps: { gitExec: exec, delay, env: {} },
    });
    assert.equal(outcome.updated, true);
    assert.equal(outcome.restartRequired, true);
    assert.ok(calls.some(call => call.startsWith('merge --ff-only')));
    assert.equal(readState(dir).appliedVersion, 'bbb222');
    assert.equal(readState(dir).prevVersion, 'aaa111');
  }

  // --- git: interrupted apply is repaired from preUpdateHead ---
  {
    const root = tmp('hm-git-repair-');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'harness-mix', version: '0.1.1' }));
    const dir = tmp('hm-flow-');
    writeState(dir, { ...readState(dir), channel: 'git', phase: 'applying', preUpdateHead: 'aaa111', appliedVersion: 'bbb222' });
    const calls = [];
    const exec = (cmd, args) => { calls.push(args.join(' ')); return { status: 0, stdout: '', stderr: '' }; };
    const outcome = await runUpdateFlow({
      root, dataDir: dir, log: quiet, stopDesktop: async () => {}, mode: 'apply',
      deps: { gitExec: exec, delay, env: {} },
    });
    assert.equal(outcome.repaired, true);
    assert.equal(outcome.restartRequired, true);
    assert.ok(calls.some(call => call.startsWith('reset --hard aaa111')));
    assert.equal(readState(dir).phase, 'idle');
  }

  console.log('native-update-apply: semver/channel/state/lock/etag/npm-apply/pending/offline/lock-skip/crash-loop-rollback/git-ff/git-repair all covered');
})().catch(error => { console.error(error); process.exitCode = 1; });
