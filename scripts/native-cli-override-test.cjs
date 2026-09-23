// CODEX_CLI_PATH 覆盖策略：Desktop ≥26.917 仅接受裸命令名（路径形态会被其
// app-server CLI 解析器否决并回退到托管 core），此时以 shim 名 + PATH 前缀注入。
const assert = require('node:assert/strict');
const path = require('node:path');
const { codexCliOverride, registryEnvPlan, registryEnvCleanup, pathIncludesDir } = require('../src/main/native/launcher');

const shim = 'B:\\leo2www\\harness-mix\\output\\native-build\\harness-mix-shim.exe';
const baseEnv = { PATH: 'C:\\Windows;C:\\Windows\\System32' };

// win32 + ≥26.917 → 裸名 + shim 目录前置到 PATH
const bare = codexCliOverride('26.917.8451.0', shim, baseEnv, 'win32');
assert.equal(bare.CODEX_CLI_PATH, 'harness-mix-shim');
assert.ok(bare.PATH.startsWith(path.dirname(shim) + path.delimiter));
assert.ok(bare.PATH.includes(baseEnv.PATH));

// 边界：恰好 26.917
assert.equal(codexCliOverride('26.917', shim, baseEnv, 'win32').CODEX_CLI_PATH, 'harness-mix-shim');

// 已验证的旧版本 → 绝对路径，不注入 PATH
assert.deepEqual(codexCliOverride('26.908.4834.0', shim, baseEnv, 'win32'), { CODEX_CLI_PATH: shim });

// 版本未知 → 保守走绝对路径
assert.deepEqual(codexCliOverride('unknown', shim, baseEnv, 'win32'), { CODEX_CLI_PATH: shim });

// 非 win32 → 无论版本都走绝对路径
assert.deepEqual(codexCliOverride('26.917.8451.0', shim, baseEnv, 'linux'), { CODEX_CLI_PATH: shim });

// 环境变量可双向强制（验证/回退用）
assert.equal(codexCliOverride('26.908.4834.0', shim, { ...baseEnv, HARNESS_MIX_CODEX_CLI_PATH_MODE: 'bare' }, 'win32').CODEX_CLI_PATH, 'harness-mix-shim');
assert.deepEqual(codexCliOverride('26.917.8451.0', shim, { ...baseEnv, HARNESS_MIX_CODEX_CLI_PATH_MODE: 'absolute' }, 'win32'), { CODEX_CLI_PATH: shim });

// shim 无 .exe 后缀时裸名保持不变
assert.equal(codexCliOverride('26.917.0.0', '/opt/hm/harness-mix-shim', baseEnv, 'win32').CODEX_CLI_PATH, 'harness-mix-shim');

// --- 注册表环境通道（Desktop ≥26.917 自重启丢弃激活环境块的兜底） ---
const shimDir = path.dirname(shim);

// 计划：裸名 + PATH 前缀
const plan = registryEnvPlan(shim, 'C:\\Windows;C:\\Windows\\System32');
assert.equal(plan.CODEX_CLI_PATH, 'harness-mix-shim');
assert.equal(plan.PATH, `${shimDir};C:\\Windows;C:\\Windows\\System32`);

// 幂等：目录已在 PATH（含尾部斜杠/大小写差异）→ 不再改动
assert.equal(registryEnvPlan(shim, `C:\\Windows;${shimDir}\\`).PATH, null);
assert.equal(registryEnvPlan(shim, `${shimDir.toUpperCase()};C:\\Windows`).PATH, null);
assert.ok(pathIncludesDir(`C:\\Windows;${shimDir}`, shimDir));
assert.ok(!pathIncludesDir('C:\\Windows', shimDir));

// 空 PATH → 只剩 shim 目录（带分隔符前缀形态正确）
assert.equal(registryEnvPlan(shim, '').PATH, `${shimDir};`);

// 清理：移除本 shim 目录，保留其它条目；未注入时原样返回
assert.equal(registryEnvCleanup(shim, `${shimDir};C:\\Windows;D:\\tools`), 'C:\\Windows;D:\\tools');
assert.equal(registryEnvCleanup(shim, 'C:\\Windows;D:\\tools'), 'C:\\Windows;D:\\tools');
assert.equal(registryEnvCleanup(shim, `${shimDir.toLowerCase()}\\;C:\\Windows`), 'C:\\Windows');

console.log('PASS: CODEX_CLI_PATH override（≥26.917 裸名 + PATH 前缀，旧版本/平台回退，双向强制开关）+ 注册表环境计划/清理');
