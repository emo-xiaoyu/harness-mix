// PR 5 验收：对注册表中全部 Adapter 执行同一组契约测试（无 Electron、不启动原生进程）。
const { buildAdapters } = require('../src/main/adapters');
const { runAdapterContractTests } = require('../src/main/harness-adapter/contract-test');
const { normalizeCapabilities } = require('../src/main/harness-adapter/manifest');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok', name); }
  catch (error) { failed++; console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

const adapters = buildAdapters(() => {});
if (adapters.length === 0) { console.error('FAIL adapter registry is empty'); process.exit(1); }

for (const adapter of adapters) {
  runAdapterContractTests(adapter, test);
  test(`[${adapter.manifest.id}] Host workspace capabilities are uniform`, () => {
    const workspace = normalizeCapabilities(adapter.manifest.capabilities).workspace;
    if (!workspace.git || !workspace.worktree || !workspace.finalDiff) throw new Error('Host Git/Worktree/finalDiff must be enabled');
    if (workspace.nativeDiff !== (adapter.manifest.capabilities.nativeDiff === true)) throw new Error('Native Diff must remain adapter-owned');
  });
}

console.log(`adapters: ${passed} passed${failed ? `, ${failed} failed` : ''} (${adapters.length} adapters)`);
