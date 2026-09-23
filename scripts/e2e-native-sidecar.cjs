const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JsonlProcess } = require('../src/main/host/jsonl');
const { nativePaths, nativeEnvironment } = require('../src/main/native/config');

async function main() {
  const paths = nativePaths();
  const status = execFileSync(process.execPath, [paths.cli, '--check'], { encoding: 'utf8', windowsHide: true });
  assert.match(status, /^codex_mode=official-direct$/m);
  const stock = status.match(/^executable_codex_cli=(.+)$/m)?.[1].trim();
  assert.ok(stock && fs.existsSync(stock));
  const directory = path.resolve('output/native-sidecar', `run-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, 'query-start.json');
  const fakeServer = path.join(directory, 'app-server');
  fs.writeFileSync(fakeServer, `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.env.HARNESSMIX_QUERY_TEST_MARKER, JSON.stringify({ pid: process.pid }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'account/read' ? { account: null } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`);
  const env = nativeEnvironment({ ...process.env, HARNESSMIX_DATA_DIR: path.join(directory, 'data') });
  env.HARNESSMIX_STOCK_CODEX_PATH = stock;
  env.HARNESSMIX_SIDECAR = '1';
  env.HARNESS_MIX_CODEX_EXECUTABLE = process.execPath;
  env.HARNESSMIX_QUERY_TEST_MARKER = marker;
  const diagnostics = [];
  const transport = new JsonlProcess(process.execPath, [paths.wrapper, 'app-server', '--listen', 'stdio://'], { env, cwd: directory }, {
    onEvent: () => {},
    onDiagnostic: line => diagnostics.push(line),
    onRequest: () => { throw new Error('Unexpected Host request'); },
  });
  try {
    const inspection = await transport.request('harness-mix/runtime/inspect', {});
    assert.equal(inspection.codex.mode, 'official-direct');
    const page = await transport.request('harnessmix/thread/list', {});
    assert.deepEqual(page.data, []);
    const plugins = await transport.request('harnessmix/harness/plugins/list', {});
    assert.ok(plugins.plugins.some(plugin => (plugin.id || plugin.manifest?.id) === 'pi'));
    assert.equal(fs.existsSync(marker), false, 'sidecar startup must not spawn a second official app-server');
    const accounts = await transport.request('harnessmix/account/list', {});
    assert.ok(accounts.accounts.some(account => account.accountId === 'official-codex'));
    assert.equal(fs.existsSync(marker), true, 'official account query must start the query app-server on demand');
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try { process.kill(pid, 0); } catch { break; }
    }
    assert.throws(() => process.kill(pid, 0), 'idle query app-server must exit');
    console.log('PASS: independent Host sidecar starts official account query process only on demand and retires it when idle');
  } catch (error) {
    console.error(diagnostics.slice(-8).join('\n'));
    throw error;
  } finally {
    transport.child.stdin.end();
    await new Promise(resolve => {
      if (transport.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { transport.stop(); resolve(); }, 5000);
      transport.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
