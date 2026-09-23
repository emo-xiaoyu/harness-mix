// CODEX_CLI_PATH 覆盖策略：Desktop ≥26.917 仅接受裸命令名（路径形态会被其
// app-server CLI 解析器否决并回退到托管 core），此时以 shim 名 + PATH 前缀注入。
const assert = require('node:assert/strict');
const path = require('node:path');
const { codexCliOverride } = require('../src/main/native/launcher');

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

console.log('PASS: CODEX_CLI_PATH override（≥26.917 裸名 + PATH 前缀，旧版本/平台回退，双向强制开关）');
