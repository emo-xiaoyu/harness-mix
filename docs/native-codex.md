# 原生 Codex UI 接入

`npm start`、`npm run start:codex`、`Start-Codex.cmd` 均启动原生模式（唯一模式）。

## 调用链

```text
官方 Codex：
Codex Desktop → Harness Mix Shim/Host 多路复用器 → 官方 Codex app-server

其他 Harness 与显式的 Codex 协作 Worker：
Codex Desktop → Harness Mix Shim/Host → HostRuntime/ProtocolCore → 原生 Harness
```

选择器中的 `Codex（官方原生）` 使用第一条路径。它的 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`、Fork、压缩、工具、审批、模型和 Usage 请求不进入 HostRuntime，由官方 app-server 处理。Host 只负责把同一连接上的官方消息转发给 Desktop，并在 `thread/list` 首页加入其他 Harness 的任务。

`Codex（Harness Mix 协作）` 是显式的受管 Worker 路由，用于跨 Harness 委派；它通过 Codex Adapter 进入 HostRuntime。两个入口名称和线程所有权分开，避免把协作 Worker 误认为官方 Codex 主路径。

## Codex 多账号

「设置 → 账号」保留官方 Codex Desktop 账号，并允许添加最多 127 个附加账号。每个附加账号使用 `%APPDATA%\harnessmix\codex-accounts\profiles\<account-id>` 作为独立 `CODEX_HOME`；设备码登录、`auth.json`、令牌刷新、额度与原生会话均由该目录对应的 Codex app-server 所有。Harness Mix 的 `accounts.json` 只记录账号档案 ID、显示名、创建时间和默认选择，不读取或复制认证内容。

账号页会从每个账号的原生 `account/read` 与 `account/rateLimits/read` 读取套餐、5 小时/7 天已用或剩余额度及刷新时间。编辑器 Agent 菜单可直接选择账号；官方账号仍走官方直通路径，附加账号的新任务进入同一套 Desktop Thread/Turn/工具/审批/Diff 界面并固定到所选账号。更改默认账号不会迁移或中断已运行任务。

外部 Thread 支持「调整方向」：会话运行中发送新消息会取消当前 Turn、等待其完全终结（含文件快照结算），再将新输入作为独立新 Turn 启动；超时、目标过期或并发冲突一律失败，绝不自动启动非预期 Turn。

Harness Mix 的多 Harness 部分是本项目自研自建架构：
- **无上游 npm 依赖**：Launcher、Shim、Host Runtime 与 Renderer 扩展源码均维护在本项目（`src/main/native` 与 `src/native-ui`），不依赖任何上游 npm 包。
- **官方 Codex 保持官方所有权**：账号、凭据、会话、模型调用、工具、审批和权限由官方 app-server 管理；Harness Mix 不把官方 Codex Thread 导入自己的 HostRuntime。
- **外部 Harness 由本地内核管理**：`HostRuntime`、`ProtocolCore` 与原生适配器管理外部 Harness 的会话映射、事件投影和协作。
- **图标与资源自主集成**：Harness 品牌图标及各厂商模型图标直接从 `src/assets/icons` 提取并在本地编译时嵌入 Renderer 扩展。
- **同一套 UI**：两条执行路径都复用 Codex Desktop 的会话、工具、审批和 Diff 组件。

## 启动与配置

需要 Node.js 22.19+（22 系列）或 Node.js 24、Rust 工具链（rustup，推荐 `x86_64-pc-windows-gnu` 主机以免依赖 Visual Studio）、官方 Codex Desktop，以及已配置的原生 Harness。

```powershell
npm install
npm run check:native  # 只检查安装，不重启桌面
npm start
```

`check:native` 同时输出当前 Codex Desktop 的兼容状态：`verified` 表示该精确版本已完成重启桌面 E2E，`observed` 表示仅通过协议/构建/离屏 smoke，`unverified` 表示版本尚未进入证据矩阵。明确列入阻止名单的版本拒绝启动；设置 `HARNESS_MIX_STRICT_COMPATIBILITY=1` 时，只有 `verified` 版本可以启动。矩阵位于 `config/codex-desktop-compatibility.json`，不得把单元测试或离屏 smoke 记录成完整桌面验收。

**启动器会重启当前 Codex Desktop。** 保存正在进行的工作后再启动，包括当前 Codex 对话所在的桌面。不要同时运行旧版 `launch-codex.cjs` 后台进程。

## 自动更新

启动时自动检查更新，按安装形态走两条通道：

- **git 检出（开发形态）**：可快进且工作区干净时自动拉取、按需重装依赖并重建原生组件；`install` / `build` 失败自动回退到更新前的提交。分叉、本地领先或工作区有未提交改动时跳过并打印原因。
- **npm 全局安装**：从 registry 发现新版本后，先停止桌面，再用 `npm install -g harness-mix@<版本>` 应用（校验由 npm integrity 承担），失败自动重试并挂起至下次启动；连续两次启动未成功会自动回滚到上一版本。

所有变更操作持有更新锁（`%APPDATA%\harnessmix\update.lock`），状态记录在 `update-state.json`；应用成功后启动器自行重启加载新代码。任何更新失败（如离线、占用、权限）都不阻塞启动。

- `npm run update`：只检查并应用更新，不启动桌面（应用时会先停一次桌面）。
- `npm start -- --no-update` 或 `HARNESS_MIX_AUTO_UPDATE=0`：跳过本次更新检查。
- `HARNESS_MIX_UPDATE_REGISTRY`：自定义 registry；`HARNESS_MIX_UPDATE_PRERELEASE=1`：允许预发布版本。

## Shim 与原生组件（Rust）

`harness-mix-shim.exe`、`harness-mix-appx.exe` 与 `harness-mix-secret.exe` 由 `src/main/native/rs` 下的 Rust workspace 构建（`npm run build:native`），零外部 crate 依赖：Shim 仅用 std 并给自身挂 kill-on-close Job Object，AppX 手写 COM 声明，Secret 手写 DPAPI/kernel32 声明；任意干净的 Rust 工具链即可构建。Shim 产物经 e2e:native 全链路验证，Job Object 级联清理由 `npm run test:native-job-object` 验证。

Shim 只接管作为 Desktop 协议端点的普通 `app-server`。`app-server proxy`、`app-server daemon`、普通 Codex 命令、参数值中的同名文本以及未知的新命令形态都直接交给官方 CLI；未知语法默认保持 Codex 可用，不猜测为 Harness Mix 路由。

## CODEX_CLI_PATH 注入（Windows）

- 默认通道：激活时经 `IPackageDebugSettings::EnableDebugging` 注入环境块（`CODEX_CLI_PATH` 指向 shim 绝对路径，另含 `HARNESSMIX_STOCK_CODEX_PATH` 等 5 个变量）。
- Codex Desktop ≥26.917 起有两个新行为：其一，app-server CLI 解析器只接受**裸命令名**形态的 `CODEX_CLI_PATH`（含路径分隔符或盘符的值被否决并回退到桌面托管 core）；其二，桌面启动时会自重启（broker → 主进程）并**丢弃激活环境块**，主进程环境改由注册表重建。
- 因此 ≥26.917 上启动器双通道注入：激活块中传 `CODEX_CLI_PATH=harness-mix-shim` 裸名 + `PATH` 前缀；同时把同名值写入 `HKCU\Environment`，并把 shim 目录移到用户 PATH 首位（裸名要求 shim 先于任何同名可执行文件命中，重复条目会被去重）。写入幂等，PATH 保留原有值类型（`REG_EXPAND_SZ`）；宿主所需的其余变量由 shim 侧车文件（`node-path.txt` / `stock-path.txt`）与 `native-host.cjs` 的 `nativeEnvironment()` 兜底，不依赖注册表。
- 所有权跟踪：写入前把原值记入 `<数据目录>/registry-env-state.json`。`npm start -- --clean-env` 只回退/移除经该记录证明由本启动器写入的值（用户事后改动过的值保持不动）。关闭该通道：`HARNESS_MIX_REGISTRY_ENV=0`；`HARNESS_MIX_CODEX_CLI_PATH_MODE=absolute` 除恢复激活块的绝对路径形态外，也会清理注册表通道中本启动器的值。强制裸名调试：`HARNESS_MIX_CODEX_CLI_PATH_MODE=bare`。

## 进程监管

- Shim 启动即把自身加入 Job Object（`KILL_ON_JOB_CLOSE`）：node 宿主、官方 app-server、各家 CLI 与 pwsh 终端全部随 shim 级联清理，强杀或崩溃也不例外。
- 宿主每 5s 写心跳（`%APPDATA%\harnessmix\runtime\instance.json`）；`uncaughtException` / `unhandledRejection` / `SIGBREAK` 会写入同目录 `crash-<ts>.json` 并尝试优雅收尾。
- 启动器在重启桌面前清扫本项目残留进程（仅匹配 shim 二进制路径与 `native-host.cjs` / `desktop-controller.mjs` 入口），并把上次异常退出时运行中的任务标记为 interrupted，重新发送即可继续。
- 适配器与终端统一经 `src/main/native/process-utils.js` 的 `terminateTree()`（Windows `taskkill /T /F`）终止进程树。

## 安全存储与诊断

- `harness-mix-secret.exe`（DPAPI，当前用户范围）提供平台保险箱：`set / get / delete / list`，密文落盘 `<data>\secrets.dat`；JS 入口 `src/main/native/secure-store.js`，helper 缺失时明确报错、绝不降级为明文。当前没有默认凭据写入，供后续功能（私有 registry token、直连模型密钥等）使用。
- `host-traffic.jsonl` 与 `shim-invocations.log` 均为 5MB × 3 轮转；写盘前对 Bearer/API key 形态与敏感字段键做脱敏（`src/main/native/redact.js`）。
- `npm run diagnostics`：把版本、桌面兼容状态、更新/实例状态、脱敏日志尾与最近崩溃报告打包为 zip 输出到 `output/`，供问题反馈。

默认 Host 数据目录为 `%APPDATA%\harnessmix`，可用 `HARNESSMIX_DATA_DIR` 覆盖。

本项目仅保存以下非凭据配置到该目录的 `harness-mix-settings.json`，以适配 Windows AppX 环境传递：

- `HARNESS_MIX_DSH_ROOT`：可选 DSH 源码目录。
- `HARNESS_MIX_CODEBUDDY_EXECUTABLE`、`HARNESS_MIX_KIRO_EXECUTABLE`、`HARNESS_MIX_CURSOR_EXECUTABLE`：可选原生 CLI 路径。CodeBuddy 兼容旧的 `HARNESS_MIX_WORKBUDDY_EXECUTABLE`，新变量优先。接口与验收见 [原生 ACP 深度适配](native-acp.md)。
- `HARNESSMIX_PI_COMMAND`、`HARNESSMIX_CLAUDE_COMMAND`、`HARNESSMIX_DEEPSEEK_HARNESS_COMMAND`、`HARNESSMIX_ANTIGRAVITY_COMMAND`：可选原生命令路径。

环境变量优先于该文件；删除文件中的对应字段即可恢复默认。账号认证使用各原生程序和上游配置机制，本项目不保存凭据。

DSH Web Remote 与协作 ACP 默认使用 `HARNESS_MIX_DSH_ROOT`（未设置时为
`E:\dsh\deepseek-harness`）中的原生源码；当前本机健康检查版本为
`0.1.5-rc.2`。原生 Host 包装脚本在未设置该变量时才回退到项目安装的
`@deepseek-ai/dsh@0.1.2-rc.1`。两条路径都不修改 DSH 源码或复制账号凭据。

## 验证

```powershell
npm run check
npm run smoke:native-ui
npm run e2e:native
npm run e2e:native:pi
npm run e2e:native:dsh
npm run e2e:native:claude
```

`e2e:native` 启动真实 Shim 与 Host，检查官方协议透传和 Pi、Claude、DSH 的可用目录。三个具名 E2E 会发送简短真实请求，验证原生 `thread/start`、`turn/start`、流式结果和 `turn/completed`。报告写入 `output/native-host/`。它们不重启当前桌面；桌面完整重启后的 UI 仍需单独验收。
