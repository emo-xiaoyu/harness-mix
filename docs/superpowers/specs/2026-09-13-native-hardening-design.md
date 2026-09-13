# Harness Mix 原生加固设计：自更新 / 进程监管 / 安全存储

- 日期：2026-09-13
- 状态：设计已评审通过（用户确认），待实现
- 约束：Windows 优先；保持零外部 crate（GNU 工具链可构建）、零新增 npm 依赖

## 1. 背景与现状

### 1.1 自更新（`src/main/native/updater.js`）

现状：每次 `npm start` 前检查 `origin` 上游；可快进且工作区干净时 `merge --ff-only`，按需
`npm install` 与 `npm run build:native`；dirty / ahead / diverged 跳过；失败仅打印、不阻塞启动。

问题：

1. npm 安装形态（包根无 `.git`）无法自动更新，每次启动还会打印"检查失败"。
2. 无锁、无校验、无回滚；`install` / `build` 失败会留下半更新状态。
3. 无 pending / 重试机制；桌面进程或文件占用时无处置。
4. `scripts/native-updater-test.cjs` 只覆盖决策矩阵，没有应用与回滚路径。

### 1.2 进程监管

现状（链路：Codex Desktop → `harness-mix-shim.exe` → `node scripts/native-host.cjs` →
HostRuntime → 各家 CLI / pwsh 终端）：

- 优雅关闭：`host.js` 在 stdin close / SIGTERM / SIGINT 时 `runtime.close()` → 各
  `adapter.close()` → 官方 app-server `stdin.end()` + 2s 后 `kill()`。
- 问题：
  1. 强杀（任务管理器、OOM、shim 超时）时后代进程不在同一终止语义内。Windows 上
     `child.kill()` 只杀单进程，harness CLI 会成为孤儿继续执行（仍可能修改工作区文件）。
  2. 适配器终止方式不统一：`dsh-web-host` / `openclaw-gateway` / `opencode-server` /
     `terminal` 用 `taskkill /T /F`；`antigravity` / `jsonl` 等用裸 `child.kill()`。
  3. 无心跳、无启动清扫、无单实例保护、无崩溃报告与恢复标记。

### 1.3 安全存储

现状：设计上不落盘凭据（`harness-mix-settings.json` 只存可执行文件路径；协作密钥、
Antigravity question token 均为内存生成、按需注入子进程环境）。

风险：

1. 明文落盘的敏感数据：会话存储（`mix-core`）、`host-traffic.jsonl`（含 prompt /
   工具参数摘要，单字段最长 1500 字符）、`shim-invocations.log`（argv + stderr 尾巴）。
2. 没有平台级保险箱可承接未来的凭据（私有 registry token、直连模型密钥等）。

## 2. 目标与非目标

目标：

- 自更新：双通道（git / npm）可靠更新——锁、重试、挂起、校验（npm integrity）、
  崩溃自动回滚；任何失败不阻塞启动。
- 进程监管：系统级级联清理（Job Object）+ 心跳 / 启动清扫 / 恢复标记 / 崩溃报告。
- 安全存储：平台保险箱 primitive + 日志脱敏与轮转。

非目标：

- Windows 安装包、代码签名、CI 发布流水线（属 `NEXT-STEPS.md` P3 后续）。
- portable（解压即用）通道的自替换器——待该分发形态出现再做；本设计不手写
  tarball 下载 / 原子换位。
- Linux / macOS 原生实现（保持 Windows 优先）。
- 会话库加密、凭据迁移（当前没有需要迁移的凭据）。

## 3. 总体设计

三块遵循同一原则：

- **Rust 只做 OS 边界能力**：Job Object（shim 增量）、DPAPI（新 secret crate）。
  零外部 crate，`x86_64-pc-windows-gnu` 干净工具链可构建。
- **编排与状态机在 JS**：更新状态机、心跳、清扫、脱敏。
- **失败一律不阻塞**：任何加固失败只降级 / 告警，不影响启动与协议链路。
- 新增 Rust 产物：`harness-mix-secret.exe`；shim 增加 Job Object 与日志轮转，
  不新增 crate 依赖。

## 4. 自更新 v2

### 4.1 通道识别

`detectChannel(root)`：

- `root/.git` 存在 → `git`；
- 否则 `basename(dirname(root)) === 'node_modules'` → `npm`；
- 否则 → `portable`（本设计不做，打印"暂不支持自动更新"）。

### 4.2 锁与状态

- 锁：`<data>/update.lock`（内容 `{pid, ts, op}`），互斥所有变更操作
  （apply / rollback / repair）。stale 判定：pid 不存在，或 ts 超过 30 分钟。
  只读检查不取锁。
- 状态：`<data>/update-state.json`：

```json
{
  "schema": 1,
  "channel": "git|npm",
  "phase": "idle|applying",
  "appliedVersion": "0.2.0",
  "prevVersion": "0.1.1",
  "appliedAt": 0,
  "attempts": 0,
  "lastBootOkAt": 0,
  "pendingVersion": null,
  "lastCheckAt": 0,
  "preUpdateHead": "<sha>"
}
```

`<data>` = `CODEXHOST_DATA_DIR`（默认 `%APPDATA%\harness-mix\codexhost`）。

### 4.3 git 通道

保留现有决策矩阵（current / ahead / diverged / dirty / available），新增：

1. `merge --ff-only` 前记录 `preUpdateHead`，置 `phase:"applying"`。
2. `install` / `build` 失败 → `git reset --hard <preUpdateHead>`，恢复
   `phase:"idle"`，打印原因，继续启动。
3. 全程持锁；完成或回滚后释放。

### 4.4 npm 通道

- 安装范围检测：仅当包根位于 npm 全局目录（`npm root -g`）时才自动应用；
  本地依赖 / `npm link` 形态只打印提示 `npm install -g harness-mix@latest`。
- 发现：读当前 `package.json.version` → `GET {registry}/harness-mix`
  （`Accept: application/vnd.npm.install-v1+json`，5s 超时，ETag 缓存于
  `<data>/update-etag.json`）→ 比较 `dist-tags.latest`（预发布版本需
  `HARNESS_MIX_UPDATE_PRERELEASE=1`）。
- registry 解析顺序：`HARNESS_MIX_UPDATE_REGISTRY` → `npm_config_registry` →
  `npm config get registry`（结果缓存）→ `https://registry.npmjs.org/`。
- 应用（先落盘 `phase:"applying"`）：
  1. 先停止桌面（复用 launcher 现有的按 ExePath 精确 `Stop-Process` 逻辑）并等待 3s；
  2. `npm install -g harness-mix@<version> --no-audit --no-fund`
     （`windowsHide`，超时 180s）；失败重试 ≤3 次，间隔 2s；
  3. 仍失败 → 写 `pendingVersion`，恢复 `phase:"idle"`，继续用旧版启动；
  4. 成功 → 记录 `prevVersion` 与 `appliedAt`，re-exec 同一 bin
     （`process.execPath scripts/launch-codex.cjs` + 原参数），env 带
     `HARNESS_MIX_UPDATED=1`（防循环）。
- 校验：由 npm 自身的 integrity（sha512）承担；本设计不手写下载 / 解包。
- 启动时若存在 `pendingVersion`，按 4.5 先尝试应用；失败则继续旧版并保留 pending。

### 4.5 回滚状态机

launcher 入口（持锁）：

1. **中断修复**：`phase:"applying"` 残留 → 上次应用中断，按通道修复
   （npm：重装 `appliedVersion || prevVersion`；git：`reset --hard preUpdateHead`）。
2. **崩溃循环回滚**：若 `appliedVersion` 存在且 `attempts ≥ 2` 且
   `lastBootOkAt < appliedAt` → 自动回滚：npm 重装 `prevVersion`、git
   `reset --hard preUpdateHead` + 重建；记录并横幅告警。没有 `prevVersion`
   时只告警不回滚。
3. **计数**：每次启动，当 `appliedVersion` 存在且尚未记录 boot-ok 时
   `attempts += 1`；启动成功（桌面激活 + controller 存活 ≥20s）写
   `lastBootOkAt = now`、`attempts = 0`。
4. **外部版本变化**：`package.json.version` 与 `appliedVersion` / `prevVersion`
   都不一致（用户手动升级）→ 重置状态为 idle，不触发回滚。

### 4.6 launcher 顺序变化

现状：`autoUpdate` → inspect → 停桌面 → 激活。

改为：

1. 只读检查（含 pending）；
2. 有更新 / 待应用时：**停桌面 → 应用（持锁）→ re-exec**；
3. （新进程）inspect → 兼容检查 → 激活。

`--update`（`npm run update`）语义更新为"立即检查并应用（必要时停一次桌面），
不启动"。`--no-update` / `HARNESS_MIX_AUTO_UPDATE=0` 保持不变。

### 4.7 错误与降级矩阵

| 场景 | 行为 |
| --- | --- |
| 离线 / registry 超时 | 打印原因，跳过本次，继续启动 |
| 无权限 / 文件占用 | 重试 3 次 → 写 pending → 继续旧版启动 |
| npm 不存在 | 提示手动命令，本次弃用 npm 通道 |
| 应用中断（进程被杀） | 下次启动 repair（4.5-1） |
| 连续 2 次启动失败 | 回滚到 prevVersion（4.5-2） |
| 状态文件损坏 | 视为 idle 重建，不阻塞 |

### 4.8 测试

- 扩展 `scripts/native-updater-test.cjs`（mock）：通道识别、semver 比较、
  锁 stale 判定、状态机（attempts / 回滚 / repair / 外部版本变化）。
- 新增 `scripts/native-update-apply-test.cjs`（离线）：
  1. `npm pack` 造 fixture tarball，本地 http server 冒充 registry 元数据；
  2. `npm install --prefix <tmp> harness-mix@file:<tarball>` 造临时安装；
  3. 覆盖：应用到新版本、挂起（模拟占用失败）、回滚、`phase:"applying"` 修复。
- git 通道回退：本地 bare 仓 fixture 造 build 失败 → 断言 reset 回旧 HEAD。

## 5. 进程监管 v2

### 5.1 Job Object（shim，Rust 零依赖 FFI）

- `run()` 启动即执行：
  1. `CreateJobObjectW(null, null)`；
  2. `SetInformationJobObject(hJob, JobObjectExtendedLimitInformation,
     LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)`；
  3. `AssignProcessToJobObject(hJob, GetCurrentProcess())`。
- 效果：node 宿主、官方 app-server、各家 CLI、pwsh 终端全部随 spawn 自动继承
  job；**shim 无论以何种方式消亡（强杀 / 崩溃），句柄关闭即触发系统级联杀死
  全部成员**。
- 失败降级：任一步失败 → stderr 告警，继续运行，不阻塞 CLI。
- 兼容性：Win8+ 支持嵌套 job（桌面自身若在 job 中不受影响）；绝不把 Codex
  Desktop 本体放入 job。
- 测试钩子：新增 `HARNESS_MIX_HOST_SCRIPT` env（server 模式下覆盖默认
  `scripts/native-host.cjs` 路径，仅测试用；默认行为不变）。
- shim 日志：`shim-invocations.log` 增加 5MB × 3 轮转。

### 5.2 心跳与崩溃报告（`host.js`）

- `<data>/runtime/instance.json`：`{pid, version, startedAt, beatAt, mode}`，
  每 5s 更新；正常关闭时删除。
- `uncaughtException` / `unhandledRejection` / `SIGBREAK` → 写
  `<data>/runtime/crash-<ts>.json`（error / stack / pid / version）→ 尝试
  `close()` → 退出码 1。既有 SIGTERM / SIGINT 处理保持不变。

### 5.3 启动清扫（`launcher.js`）

停桌面之后、激活之前：

1. 读 `instance.json`：心跳新鲜且 pid 存活 → 记录"另一实例仍在运行"（更新锁同理），
   继续现有流程（桌面重启会令旧宿主自行退出）。
2. 清扫：PowerShell CIM 查询匹配（本项目 `output/native-build` 下的
   `harness-mix-shim.exe`、命令行含 `native-host.cjs` 或 `desktop-controller.mjs`
   的 node 进程），排除当前进程链后 `taskkill /T /F`；记录数量与耗时至启动日志。
3. 心跳陈旧（>30s）或 pid 已死 → 必定清扫（含实例记录 pid）。

### 5.4 进程树终止统一

- 新增 `src/main/native/process-utils.js`：`terminateTree(pid)`（win32：
  `taskkill /PID <pid> /T /F` 等待完成；其他平台 `process.kill(-pid)` 兜底）。
- 替换调用点：`antigravity.js`、`jsonl.js`、`host.js`（official 的 2s 超时
  kill），以及已用 taskkill 的 `dsh-web-host.js`、`openclaw-gateway.js`、
  `opencode-server.js`、`workspace/terminal.js` 统一走该函数（行为不变、实现单点）。

### 5.5 启动恢复

- `HostRuntime` 加载存储时，把 `working` 状态的线程 / 轮次统一标记为
  `interrupted`（附"宿主异常退出"说明），与 `collaboration` 现有
  `interrupted` 语义一致（`src/main/host/collaboration.js` 已实现，线程侧补齐）。

### 5.6 测试

- `scripts/native-job-object-test.cjs`（e2e，需要已构建 shim）：
  1. fixture 假宿主（spawn 一个长命孙进程并写 pid 文件），shim 以 server 模式 +
     `HARNESS_MIX_HOST_SCRIPT` 启动；
  2. `taskkill /F` 强杀 shim；
  3. 断言宿主与孙进程 3s 内消失（`process.kill(pid, 0)` 抛 ESRCH）。
- 心跳 / 清扫 / 锁：mock exec 单测；清扫命令的真实语法用 `--check` 冒烟验证
  （不杀真实进程）。

## 6. 安全存储 v2（保险箱 + 落盘治理）

### 6.1 `harness-mix-secret`（新 Rust bin，零依赖）

- FFI：`crypt32.CryptProtectData` / `CryptUnprotectData`
  （`CRYPTPROTECT_UI_FORBIDDEN`，当前用户范围）。
- CLI：`set <name>`（值从 stdin）｜ `get <name>`（stdout；缺失退出码 2）｜
  `delete <name>` ｜ `list`（仅名称）。名称规则 `[A-Za-z0-9._-]{1,64}`。
- 存储：`<data>/secrets.dat`，格式
  `{"version":1,"entries":{"name":"<base64 dpapi blob>"}}`，
  写临时文件 + 原子替换。
- 构建：加入现有 workspace 与 `build-native.cjs` 拷贝列表；
  `package.json` 的 `files` 增加该 exe。

### 6.2 `src/main/native/secure-store.js`

- `getSecret / setSecret / deleteSecret / listSecrets`，execFile 调 exe；
  helper 缺失 → 抛"运行 npm run build:native"的可操作错误。
- 本阶段无消费者（当前没有需要持久化的凭据）；为后续私有 registry token、
  直连模型密钥预留。

### 6.3 日志脱敏与轮转

- 脱敏器（`src/main/native/redact.js`）规则：
  - `Bearer <token>`、`sk-*`、`ghp_*`、`xox*-*` 等模式 → `[redacted]`；
  - 对象键匹配 `/(token|secret|password|passwd|apikey|api_key|authorization|credential)/i`
    → `[redacted]`。
- 应用点：`host.js` 的 `slim()`（traffic 日志写盘前）；诊断导出复用同一脱敏器。
- 轮转：`host-traffic.jsonl` 与 `shim-invocations.log` 均为 5MB × 3。

### 6.4 测试

- 脱敏单测：真实模式样例 + 误伤样例（普通文本中的 `sk-` 前缀等）。
- `scripts/native-secret-test.cjs`：真 exe round-trip（set / get / delete /
  list）、缺名报错、helper 缺失路径（临时改名模拟）。

## 7. 交付阶段

- **Phase 1**：自更新 v2（§4）+ 监管核心（§5.1 / 5.2 / 5.3 / 5.5）。
  验收：现有测试全绿；新增单测 / 集成测试全绿；手工场景（离线、文件占用、
  崩溃循环回滚、强杀级联）通过。
- **Phase 2**：终止统一（§5.4）+ 崩溃报告细化 + `npm run diagnostics`
  （打包版本、兼容矩阵、脱敏日志、崩溃报告，tar 打包）。
- **Phase 3**：保险箱与落盘治理（§6）+ 文档更新（`docs/native-codex.md`
  增补安全存储、进程监管、更新机制三节）。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `npm install -g` 自身文件占用 | 先停桌面 + 重试 + pending + 回滚；最坏给出手动命令 |
| 嵌套 Job 兼容性 | 仅 Win8+；失败仅告警，功能退回现状（不劣化） |
| 崩溃循环误判 | 阈值 2 次且必须有 `prevVersion`；回滚目标为上次成功版本 |
| boot-ok 判据（controller 存活 20s）为启发式 | 先上线，后续按需收紧 |
| `--update` 现在会停桌面 | 行为变化，写入文档与 `--check` 帮助输出 |

## 9. 文件清单（预告）

新增：

- `docs/superpowers/specs/2026-09-13-native-hardening-design.md`（本文）
- `src/main/native/process-utils.js`、`src/main/native/redact.js`、
  `src/main/native/secure-store.js`
- `src/main/native/rs/crates/secret/`（新 crate）
- `scripts/native-update-apply-test.cjs`、`scripts/native-job-object-test.cjs`、
  `scripts/native-secret-test.cjs`

修改：

- `src/main/native/updater.js`、`src/main/native/launcher.js`、
  `src/main/native/host.js`、`src/main/native/config.js`（nativePaths 增加 secret）
- `src/main/native/rs/crates/shim/src/main.rs`（Job Object、日志轮转、
  HARNESS_MIX_HOST_SCRIPT）
- `src/main/host/runtime.js`（恢复标记）、各 adapter 的终止调用点
- `scripts/build-native.cjs`、`package.json`（files / 测试脚本）
- `docs/native-codex.md`
