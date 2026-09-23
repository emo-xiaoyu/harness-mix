// CODEX_CLI_PATH 覆盖策略：Desktop ≥26.917 仅接受裸命令名（路径形态会被其
// app-server CLI 解析器否决并回退到托管 core），此时以 shim 名 + PATH 前缀注入。
const assert = require('node:assert/strict');
const path = require('node:path');
const { codexCliOverride, registryEnvPlan, registryPathPlan, withoutPathDir, adoptLegacyInjection } = require('../src/main/native/launcher');

const shim = 'B:\\leo2www\\harness-mix\\output\\native-build\\harness-mix-shim.exe';
const baseEnv = { PATH: 'C:\\Windows;C:\\Windows\\System32' };

// win32 + ≥26.917 → 裸名 + shim 目录前置到 PATH（win32 语义，POSIX CI 宿主上同样成立）
const bare = codexCliOverride('26.917.8451.0', shim, baseEnv, 'win32');
assert.equal(bare.CODEX_CLI_PATH, 'harness-mix-shim');
assert.ok(bare.PATH.startsWith(path.win32.dirname(shim) + ';'));
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
// 全部使用 win32 语义，任何 CI 宿主上结果一致
const shimDir = path.win32.dirname(shim);

// 计划：裸名 + PATH 首位
const plan = registryEnvPlan(shim, 'C:\\Windows;C:\\Windows\\System32');
assert.equal(plan.CODEX_CLI_PATH, 'harness-mix-shim');
assert.equal(plan.PATH, `${shimDir};C:\\Windows;C:\\Windows\\System32`);

// 幂等：仅当目录已在首位且无重复时才不改动
assert.equal(registryEnvPlan(shim, `${shimDir};C:\\Windows`).PATH, null);
assert.equal(registryEnvPlan(shim, `${shimDir.toUpperCase()};C:\\Windows`).PATH, null);
assert.equal(registryEnvPlan(shim, `${shimDir}\\;C:\\Windows`).PATH, null);

// 目录在 PATH 其它位置 → 移到首位（裸名要求 shim 先于同名可执行文件命中）
assert.equal(registryEnvPlan(shim, `C:\\Windows;${shimDir}`).PATH, `${shimDir};C:\\Windows`);
// 重复出现 → 去重后置首
assert.equal(registryEnvPlan(shim, `${shimDir};C:\\Windows;${shimDir}\\`).PATH, `${shimDir};C:\\Windows`);
// 空 PATH → 只剩 shim 目录
assert.equal(registryEnvPlan(shim, '').PATH, shimDir);

// 移除辅助：去掉某目录的所有出现
assert.equal(withoutPathDir(`${shimDir};C:\\Windows;D:\\tools`, shimDir), 'C:\\Windows;D:\\tools');
assert.equal(withoutPathDir('C:\\Windows;D:\\tools', shimDir), 'C:\\Windows;D:\\tools');
assert.equal(withoutPathDir(`${shimDir.toLowerCase()}\\;C:\\Windows`, shimDir), 'C:\\Windows');

// 迁移接管：旧版注入形态（裸名/绝对路径 + PATH 首位单条目）被认定为本启动器所写
const adopted = adoptLegacyInjection(shim, { PATH: `${shimDir};C:\\Windows`, CODEX_CLI_PATH: 'harness-mix-shim' });
assert.equal(adopted.cliPath.wrote, true);
assert.equal(adopted.cliPath.previous, null);
assert.equal(adopted.path.prepended, true);
assert.equal(adopted.path.presentBefore, false);
// 目录不在首位或多次出现 → 视为用户自有，清理时不得动 PATH
const foreign = adoptLegacyInjection(shim, { PATH: `C:\\Windows;${shimDir}`, CODEX_CLI_PATH: 'other-tool' });
assert.equal(foreign.cliPath.wrote, false);
assert.equal(foreign.path.presentBefore, true);
// 完全无关的注册表 → 无接管
assert.equal(adoptLegacyInjection(shim, { PATH: 'C:\\Windows', CODEX_CLI_PATH: '' }), null);

console.log('PASS: CODEX_CLI_PATH override（≥26.917 裸名 + PATH 前缀，旧版本/平台回退，双向强制开关）+ 注册表环境计划/清理/迁移接管');
