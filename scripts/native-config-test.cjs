const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeEnvironment, nativePaths, saveNativeSettings } = require('../src/main/native/config');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-config-'));
try {
  const source = { CODEXHOST_DATA_DIR: directory, CODEXHOST_PI_COMMAND: 'C:\\Native tools\\pi.cmd', PRIVATE_TEST_VALUE: 'do-not-persist' };
  const env = nativeEnvironment(source);
  assert.equal(source.CODEXHOST_DEFAULT_AGENT, undefined, 'Input environment is not mutated');
  assert.equal(env.CODEXHOST_DEFAULT_AGENT, 'codex');
  saveNativeSettings(env);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'harness-mix-settings.json'), 'utf8'));
  assert.deepEqual(saved, { CODEXHOST_PI_COMMAND: source.CODEXHOST_PI_COMMAND });
  assert.equal(nativeEnvironment({ CODEXHOST_DATA_DIR: directory }).CODEXHOST_PI_COMMAND, source.CODEXHOST_PI_COMMAND,
    'AppX child recovers command settings from the data directory');
  assert.equal(nativeEnvironment({ CODEXHOST_DATA_DIR: directory, CODEXHOST_PI_COMMAND: 'D:\\other\\pi.cmd' }).CODEXHOST_PI_COMMAND,
    'D:\\other\\pi.cmd', 'Explicit environment takes priority');
  for (const file of Object.values(nativePaths())) assert.ok(fs.statSync(file).isFile(), file);
  console.log('Native configuration, AppX environment recovery, credential exclusion and packaged resources passed');
} finally {
  fs.rmSync(path.join(directory, 'harness-mix-settings.json'), { force: true });
  fs.rmdirSync(directory);
}
