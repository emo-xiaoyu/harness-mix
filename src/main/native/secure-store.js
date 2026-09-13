// Platform secret store backed by harness-mix-secret.exe (DPAPI, current user).
// No plaintext fallback by design: when the helper is missing, callers get an
// actionable error instead of a silent downgrade.
const { execFile } = require('node:child_process');
const { nativePaths } = require('./config');

class SecureStoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecureStoreUnavailableError';
  }
}

function helperPath() {
  return process.env.HARNESS_MIX_SECRET_EXE || nativePaths().secret;
}

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(helperPath(), args, { windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        reject(new SecureStoreUnavailableError('缺少 harness-mix-secret.exe：请运行 npm run build:native'));
        return;
      }
      if (error && error.code === 2) {
        resolve({ missing: true, stdout: Buffer.from(stdout || ''), stderr: String(stderr || '') });
        return;
      }
      if (error) {
        reject(new Error(`secret store: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve({ missing: false, stdout: Buffer.from(stdout || '') });
    });
    if (input !== undefined && child.stdin) child.stdin.end(Buffer.from(input));
  });
}

async function setSecret(name, value) {
  await run(['set', name], value);
}

async function getSecret(name) {
  const result = await run(['get', name]);
  return result.missing ? null : result.stdout;
}

async function deleteSecret(name) {
  const result = await run(['delete', name]);
  return !result.missing;
}

async function listSecrets() {
  const result = await run(['list']);
  return result.stdout.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

module.exports = { setSecret, getSecret, deleteSecret, listSecrets, SecureStoreUnavailableError };
