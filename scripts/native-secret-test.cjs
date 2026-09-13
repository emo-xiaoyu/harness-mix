// Secret store coverage: log redaction rules, the DPAPI vault round-trip (real
// helper when built) and the missing-helper error path. Offline; no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { redact, redactText } = require('../src/main/native/redact');

const root = path.resolve(__dirname, '..');
const helper = [
  path.join(root, 'output/native-build/harness-mix-secret.exe'),
  path.join(root, 'src/main/native/rs/target/release/harness-mix-secret.exe'),
].find(candidate => fs.existsSync(candidate));

(async () => {
  // --- redaction rules (run regardless of the Rust helper) ---
  assert.equal(redactText('Authorization: Bearer abcdefgh12345678'), 'Authorization: [redacted]');
  assert.equal(redactText('key sk-abcdefghijklmnop1234 end'), 'key [redacted] end');
  assert.equal(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), '[redacted]');
  assert.equal(redactText('skeleton key'), 'skeleton key'); // no false positive on prose
  assert.deepEqual(
    redact({ token: 'x', name: 'ok', nested: { api_key: 'y', list: ['Bearer zzzzzzzzzzzz'] } }),
    { token: '[redacted]', name: 'ok', nested: { api_key: '[redacted]', list: ['[redacted]'] } },
  );

  if (!helper) {
    console.log('SKIP native-secret vault round-trip: helper not built (run npm run build:native)');
    return;
  }

  // --- real helper: DPAPI vault round-trip on a temp data dir ---
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-secret-'));
  const env = { ...process.env, CODEXHOST_DATA_DIR: data };
  const call = (args, input) => execFileSync(helper, args, { encoding: 'utf8', windowsHide: true, env, input });
  call(['set', 'demo.token'], 'super-secret-value');
  assert.equal(call(['get', 'demo.token']), 'super-secret-value');
  assert.deepEqual(call(['list']).trim().split(/\r?\n/), ['demo.token']);
  const blob = fs.readFileSync(path.join(data, 'secrets.dat'));
  assert.ok(!blob.includes(Buffer.from('super-secret-value')), 'vault must not contain plaintext');
  call(['delete', 'demo.token']);
  let missingCode = null;
  try { call(['get', 'demo.token']); } catch (error) { missingCode = error.status; }
  assert.equal(missingCode, 2, 'deleted entry must exit with code 2');

  // --- JS wrapper: round-trip plus the actionable missing-helper error ---
  const store = require('../src/main/native/secure-store');
  process.env.HARNESS_MIX_SECRET_EXE = helper;
  await store.setSecret('wrapper.check', 'v');
  assert.equal((await store.getSecret('wrapper.check')).toString('utf8'), 'v');
  assert.ok((await store.listSecrets()).includes('wrapper.check'));
  process.env.HARNESS_MIX_SECRET_EXE = path.join(data, 'does-not-exist.exe');
  await assert.rejects(store.getSecret('x'), store.SecureStoreUnavailableError);
  delete process.env.HARNESS_MIX_SECRET_EXE;

  console.log('native-secret: redaction + DPAPI round-trip + no-plaintext-on-disk + missing-helper error all covered');
})().catch(error => { console.error(error); process.exitCode = 1; });
