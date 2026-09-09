// Native auto-updater decision coverage: every remote state and hook trigger path.
const assert = require('node:assert/strict');
const { autoUpdate } = require('../src/main/native/updater');

function fakeGit(script) {
  const calls = [];
  const exec = (cmd, args) => {
    const key = args.join(' ');
    calls.push(key);
    for (const [pattern, response] of Object.entries(script)) {
      if (key.startsWith(pattern)) {
        if (response instanceof Error) return { status: 1, stdout: '', stderr: response.message };
        return { status: 0, stdout: response, stderr: '' };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

const base = {
  'rev-parse HEAD': 'aaa111\n',
  'rev-parse --abbrev-ref': 'origin/main\n',
  'fetch': '',
  'merge-base': 'aaa111\n',
  'status': '',
};

(async () => {
  // 1. Up to date: no merge, no hooks.
  {
    const { exec } = fakeGit({ ...base, 'rev-parse origin/main': 'aaa111\n' });
    const outcome = await autoUpdate({ root: '.', log: () => {}, exec, hooks: { install: () => assert.fail('install'), build: () => assert.fail('build') } });
    assert.deepEqual(outcome, { updated: false, state: 'current' });
  }

  // 2. Local ahead: skip.
  {
    const { exec } = fakeGit({ ...base, 'rev-parse origin/main': 'bbb222\n', 'merge-base': 'bbb222\n' });
    const outcome = await autoUpdate({ root: '.', log: () => {}, exec });
    assert.equal(outcome.updated, false);
    assert.equal(outcome.state, 'ahead');
  }

  // 3. Diverged: skip.
  {
    const { exec } = fakeGit({ ...base, 'rev-parse origin/main': 'bbb222\n', 'merge-base': 'ccc333\n' });
    const outcome = await autoUpdate({ root: '.', log: () => {}, exec });
    assert.equal(outcome.updated, false);
    assert.equal(outcome.state, 'diverged');
  }

  // 4. Dirty tree: skip, merge never attempted.
  {
    const { exec, calls } = fakeGit({ ...base, 'rev-parse origin/main': 'bbb222\n', 'status': ' M src/main/native/protocol.js\n' });
    const outcome = await autoUpdate({ root: '.', log: () => {}, exec });
    assert.equal(outcome.state, 'dirty');
    assert.ok(!calls.some(c => c.startsWith('merge --ff-only')));
  }

  // 5. Fast-forward available with dependency change: merge + install + rebuild.
  {
    const { exec, calls } = fakeGit({
      ...base,
      'rev-parse origin/main': 'bbb222\n',
      'diff --name-only aaa111 bbb222': 'package.json\nsrc/main/native/updater.js\n',
    });
    let installed = 0, rebuilt = 0;
    const outcome = await autoUpdate({ root: '.', log: () => {}, exec, hooks: { install: () => installed++, build: () => rebuilt++ } });
    assert.equal(outcome.updated, true);
    assert.equal(outcome.from, 'aaa111');
    assert.equal(outcome.to, 'bbb222');
    assert.equal(installed, 1);
    assert.equal(rebuilt, 1);
    assert.ok(calls.some(c => c.startsWith('merge --ff-only origin/main')));
  }

  // 6. Fast-forward with docs-only change: no install, no rebuild.
  {
    const { exec } = fakeGit({
      ...base,
      'rev-parse origin/main': 'bbb222\n',
      'diff --name-only aaa111 bbb222': 'docs/native-codex.md\n',
    });
    const outcome = await autoUpdate({ root: '.', log: () => {}, exec, hooks: { install: () => assert.fail('install'), build: () => assert.fail('build') } });
    assert.equal(outcome.updated, true);
    assert.equal(outcome.installed, false);
    assert.equal(outcome.rebuilt, false);
  }

  // 7. Fetch failure (offline): tolerated, never throws.
  {
    const { exec } = fakeGit({ 'fetch': new Error('Could not resolve host') });
    const outcome = await autoUpdate({ root: '.', log: () => {}, exec });
    assert.equal(outcome.updated, false);
    assert.equal(outcome.failed, true);
  }

  console.log('native-updater: current/ahead/diverged/dirty/ff/ff-docs-only/offline all covered');
})().catch(error => { console.error(error); process.exitCode = 1; });
