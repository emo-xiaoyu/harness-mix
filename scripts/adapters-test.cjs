// PR 5 验收：对注册表中全部 Adapter 执行同一组契约测试（无 Electron、不启动原生进程）。
const assert = require('node:assert/strict');
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

// Pi 家族权限目录按成员原生面分开（诚实面）：Pi=项目信任旗标，OMP=--approval-mode 三档。
// 实测依据：pi 0.84.2 `pi --help`（--approve/-a、--no-approve/-na）；
// @oh-my-pi/pi-coding-agent 18.1.19 flag-tables.ts/settings-schema.ts（always-ask|write|yolo）。
{
  const { PI_PERMISSION_MODES, OMP_APPROVAL_MODES, piPermissionLaunchArgs, ompPermissionLaunchArgs } = require('../src/main/adapters/pi-family');
  test('[pi] 权限目录 = 项目信任三档（default/approve/no-approve），不携带 OMP 档', () => {
    assert.deepEqual(PI_PERMISSION_MODES.map((m) => m.id), ['default', 'approve', 'no-approve']);
    assert.deepEqual(piPermissionLaunchArgs('approve'), ['--approve']);
    assert.deepEqual(piPermissionLaunchArgs('no-approve'), ['--no-approve']);
    assert.deepEqual(piPermissionLaunchArgs('yolo'), [], 'Pi 不认 OMP 的档位 id');
  });
  test('[omp] 权限目录 = --approval-mode 三档（always-ask/write/yolo），不携带 Pi 旗标', () => {
    assert.deepEqual(OMP_APPROVAL_MODES.map((m) => m.id), ['always-ask', 'write', 'yolo']);
    for (const mode of ['always-ask', 'write', 'yolo']) assert.deepEqual(ompPermissionLaunchArgs(mode), ['--approval-mode', mode]);
    assert.deepEqual(ompPermissionLaunchArgs('no-approve'), [], 'OMP 无 --no-approve 旗标，不虚构');
  });
  const omp = require('../src/main/adapters/omp');
  const pi = require('../src/main/adapters/pi');
  test('[pi/omp] 工厂注入各自的权限目录（describe 之外也可校验）', () => {
    assert.deepEqual(pi.permissionModes.map((m) => m.id), ['default', 'approve', 'no-approve']);
    assert.deepEqual(omp.permissionModes.map((m) => m.id), ['always-ask', 'write', 'yolo'], 'OMP 不再共用 Pi 的项目信任目录');
  });
}

console.log(`adapters: ${passed} passed${failed ? `, ${failed} failed` : ''} (${adapters.length} adapters)`);
