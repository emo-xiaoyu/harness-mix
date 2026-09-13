// Update bookkeeping for updater.js: channel detection, version compare,
// the update state file and its lock. Pure Node built-ins; `dataDir` is
// injected so tests can use temp directories.
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'update-state.json';
const LOCK_FILE = 'update.lock';
const LOCK_STALE_MS = 30 * 60 * 1000;

function defaultState() {
  return {
    schema: 1,
    channel: null,
    phase: 'idle',
    appliedVersion: null,
    prevVersion: null,
    appliedAt: 0,
    attempts: 0,
    lastBootOkAt: 0,
    pendingVersion: null,
    lastCheckAt: 0,
    preUpdateHead: null,
    rolledBackAt: 0,
  };
}

function readState(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8'));
    return { ...defaultState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return defaultState(); // missing or corrupt: rebuild, never block launch
  }
}

function writeState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, STATE_FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return state;
}

function updateState(dataDir, patch) {
  return writeState(dataDir, { ...readState(dataDir), ...patch });
}

// Called by the launcher once the desktop is up and the controller survived long
// enough to count as a healthy boot of the freshly applied version.
function markBootOk(dataDir) {
  const state = readState(dataDir);
  return writeState(dataDir, { ...state, lastBootOkAt: Date.now(), attempts: 0 });
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Mutating update operations (apply / rollback / repair) take this lock so two
// launchers cannot fight over the same install. Stale locks are reaped.
function acquireLock(dataDir, op) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_FILE);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no lock yet */ }
  if (existing && pidAlive(existing.pid) && Date.now() - Number(existing.ts || 0) < LOCK_STALE_MS) {
    throw new Error(`更新锁被进程 ${existing.pid} 持有（${existing.op || 'update'}）`);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now(), op }));
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.pid === process.pid) fs.unlinkSync(file);
    } catch { /* already gone */ }
  };
}

function compareVersions(a, b) {
  const parse = value => String(value || '0').split('-')[0].split('.').map(part => parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  const preA = String(a || '').includes('-');
  const preB = String(b || '').includes('-');
  if (preA !== preB) return preA ? -1 : 1; // release beats prerelease
  if (String(a) === String(b)) return 0;
  return String(a) > String(b) ? 1 : -1; // prerelease ordering is lexical (good enough)
}

function detectChannel(root) {
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (path.basename(path.dirname(path.resolve(root))) === 'node_modules') return 'npm';
  return 'portable';
}

module.exports = {
  STATE_FILE, LOCK_FILE, LOCK_STALE_MS,
  defaultState, readState, writeState, updateState, markBootOk,
  acquireLock, pidAlive, compareVersions, detectChannel,
};
