const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeEnvironment, nativePaths, saveNativeSettings } = require('../src/main/native/config');
const { isCodexTaskEnvironment, readLiveHostInstance } = require('../src/main/native/launcher');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-config-'));
try {
  const source = { HARNESSMIX_DATA_DIR: directory, HARNESSMIX_PI_COMMAND: 'C:\\Native tools\\pi.cmd', PRIVATE_TEST_VALUE: 'do-not-persist' };
  const env = nativeEnvironment(source);
  assert.equal(source.HARNESSMIX_DEFAULT_AGENT, undefined, 'Input environment is not mutated');
  assert.equal(env.HARNESSMIX_DEFAULT_AGENT, 'codex');
  saveNativeSettings(env);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'harness-mix-settings.json'), 'utf8'));
  assert.deepEqual(saved, { HARNESSMIX_PI_COMMAND: source.HARNESSMIX_PI_COMMAND });
  assert.equal(nativeEnvironment({ HARNESSMIX_DATA_DIR: directory }).HARNESSMIX_PI_COMMAND, source.HARNESSMIX_PI_COMMAND,
    'AppX child recovers command settings from the data directory');
  assert.equal(nativeEnvironment({ HARNESSMIX_DATA_DIR: directory, HARNESSMIX_PI_COMMAND: 'D:\\other\\pi.cmd' }).HARNESSMIX_PI_COMMAND,
    'D:\\other\\pi.cmd', 'Explicit environment takes priority');
  for (const file of Object.values(nativePaths())) assert.ok(fs.statSync(file).isFile(), file);
  const runtimeDirectory = path.join(directory, 'runtime');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const instanceFile = path.join(runtimeDirectory, 'instance.json');
  fs.writeFileSync(instanceFile, JSON.stringify({
    pid: 4242,
    beatAt: 1_000_000,
    mode: 'native-host',
  }));
  assert.deepEqual(
    readLiveHostInstance(directory, { now: 1_010_000, isPidAlive: pid => pid === 4242 }),
    { pid: 4242, beatAt: 1_000_000, mode: 'native-host' },
    'A live Host makes repeated npm start idempotent',
  );
  assert.equal(
    readLiveHostInstance(directory, { now: 1_020_000, isPidAlive: () => true }),
    null,
    'A stale Host heartbeat does not block a real launch',
  );
  assert.equal(
    readLiveHostInstance(directory, { now: 1_010_000, isPidAlive: () => false }),
    null,
    'A dead Host PID does not block a real launch',
  );
  assert.equal(isCodexTaskEnvironment({ CODEX_THREAD_ID: 'thread-1' }), true);
  assert.equal(isCodexTaskEnvironment({ CODEX_SESSION_ID: 'session-1' }), true);
  assert.equal(
    isCodexTaskEnvironment({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }),
    true,
  );
  assert.equal(isCodexTaskEnvironment({}), false);
  console.log('Native configuration, AppX environment recovery, credential exclusion and packaged resources passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
