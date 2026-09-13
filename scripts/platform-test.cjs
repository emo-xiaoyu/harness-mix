const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dataDirectory, executableName, inspectPosix, assertDesktopStopped } = require('../src/main/native/platform');
const { nativePaths } = require('../src/main/native/config');
const { descendantPids, terminateTree } = require('../src/main/native/process-utils');
const { evaluateDesktopCompatibility, enforceDesktopCompatibility } = require('../src/main/native/compatibility');

async function main() {
  const home = path.resolve(os.tmpdir(), 'hm-home');
  assert.equal(dataDirectory({}, 'darwin', home), path.join(home, 'Library/Application Support/harness-mix/codexhost'));
  assert.equal(dataDirectory({}, 'linux', home), path.join(home, '.local/share/harness-mix/codexhost'));
  assert.equal(dataDirectory({ XDG_DATA_HOME: home }, 'linux', '/ignored'), path.join(home, 'harness-mix/codexhost'));
  assert.equal(dataDirectory({ XDG_DATA_HOME: 'relative' }, 'linux', home), dataDirectory({}, 'linux', home));
  assert.equal(dataDirectory({ CODEXHOST_DATA_DIR: home }, 'darwin'), home);
  assert.equal(dataDirectory({ APPDATA: home }, 'win32'), path.join(home, 'harness-mix/codexhost'));
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(path.basename(nativePaths(platform).shim), executableName('harness-mix-shim', platform));
    assert.equal('activation' in nativePaths(platform), platform === 'win32');
    const result = evaluateDesktopCompatibility('26.901.2854.0', undefined, platform);
    assert.equal(result.state, platform === 'win32' ? 'observed' : 'unverified');
    assert.throws(() => enforceDesktopCompatibility(result, { HARNESS_MIX_STRICT_COMPATIBILITY: '1' }));
  }
  assert.equal(evaluateDesktopCompatibility('1.2.3', undefined, 'darwin').state, 'unverified');
  const env = { HARNESS_MIX_DESKTOP_EXECUTABLE: process.execPath, CODEXHOST_STOCK_CODEX_PATH: process.execPath };
  assert.equal(inspectPosix(env, 'linux').version, 'unknown');
  assert.equal(inspectPosix({ ...env, HARNESS_MIX_DESKTOP_VERSION: '1.2.3' }, 'linux').stock, fs.realpathSync(process.execPath));
  assert.throws(() => inspectPosix({}, 'linux'), /Install Codex Desktop/);
  assert.throws(() => inspectPosix({ ...env, HARNESS_MIX_DESKTOP_EXECUTABLE: 'relative' }, 'linux'), /absolute/);
  assert.throws(() => inspectPosix(env, 'freebsd'), /Unsupported/);
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'hm Mac app spaces-'));
  try {
    fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'Contents/Resources'), { recursive: true });
    for (const name of ['Contents/MacOS/Codex', 'Contents/Resources/codex']) fs.writeFileSync(path.join(bundle, name), 'fixture', { mode: 0o755 });
    const installation = inspectPosix({ HARNESS_MIX_DESKTOP_APP: bundle }, 'darwin', (command, args) => {
      assert.equal(command, '/usr/bin/plutil');
      assert.equal(args.at(-1), path.join(bundle, 'Contents/Info.plist'));
      return JSON.stringify({ CFBundleExecutable: 'Codex', CFBundleShortVersionString: '1.2.3' });
    });
    assert.equal(installation.stock, fs.realpathSync(path.join(bundle, 'Contents/Resources/codex')));
    assert.equal(installation.version, '1.2.3');
  } finally { fs.rmSync(bundle, { recursive: true, force: true }); }
  assert.deepEqual(descendantPids('101 100\n102 101\n103 1\n104 100', 100), [102, 101, 104]);
  await terminateTree(-1); // Must never signal the current process group.
  if (process.platform !== 'win32') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    try {
      assert.throws(() => assertDesktopStopped({ executable: fs.realpathSync(process.execPath) }), /Quit Codex Desktop/);
    } finally {
      const closed = new Promise(resolve => child.once('close', resolve));
      await terminateTree(child.pid);
      await closed;
    }
    await assert.rejects(require('../src/main/native/secure-store').getSecret('test'), /unavailable/);
  }
  console.log('PASS: platform paths, executable discovery, compatibility isolation and process lifecycle');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
