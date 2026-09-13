# 原生 Codex UI 接入

`npm start`、`npm run start:codex`、`Start-Codex.cmd` 均启动原生模式（唯一模式）。

## 调用链

```text
Codex Desktop 原生输入框 / Harness 选择器
  → 本地编译的 Harness Mix CLI Shim (harness-mix-shim.exe)
  → Harness Mix 原生 Host 入口 (src/main/native/host.js)
  → Harness Mix 本地 HostRuntime (src/main/host/runtime.js) & ProtocolCore
  → 本地 Harness 适配器（Pi / Claude Code / DeepSeek / Antigravity / Codex / CodeBuddy / Kiro / Cursor / Qoder）
  → Codex app-server 事件投影 (src/main/native/protocol.js)
  → Codex Desktop 原生流式文本、工具、审批和 Diff 组件
```

外部 Thread 支持「调整方向」：会话运行中发送新消息会取消当前 Turn、等待其完全终结（含文件快照结算），再将新输入作为独立新 Turn 启动；超时、目标过期或并发冲突一律失败，绝不自动启动非预期 Turn。

这是完全内化于本项目的自研自建架构：
- **无上游 npm 依赖**：Launcher、Shim、Host Runtime 与 Renderer 扩展源码均维护在本项目（`src/main/native` 与 `src/native-ui`），不依赖任何上游 npm 包。
- **内核 100% 属于 Harness Mix**：由本项目的 `HostRuntime`、`ProtocolCore` 与原生适配器（`src/main/adapters`）直接管理会话生命周期、模型调用、多轮对话、交互审批与文件差异。
- **图标与资源自主集成**：Harness 品牌图标及各厂商模型图标直接从 `src/assets/icons` 提取并在本地编译时嵌入 Renderer 扩展。
- **单内核**：原生模式接入 Codex 原生 UI，会话内核只有 HostRuntime + ProtocolCore 一套。

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

所有变更操作持有更新锁（`%APPDATA%\harness-mix\codexhost\update.lock`），状态记录在 `update-state.json`；应用成功后启动器自行重启加载新代码。任何更新失败（如离线、占用、权限）都不阻塞启动。

- `npm run update`：只检查并应用更新，不启动桌面（应用时会先停一次桌面）。
- `npm start -- --no-update` 或 `HARNESS_MIX_AUTO_UPDATE=0`：跳过本次更新检查。
- `HARNESS_MIX_UPDATE_REGISTRY`：自定义 registry；`HARNESS_MIX_UPDATE_PRERELEASE=1`：允许预发布版本。

## Shim 与原生组件（Rust）

`harness-mix-shim.exe`、`harness-mix-appx.exe` 与 `harness-mix-secret.exe` 由 `src/main/native/rs` 下的 Rust workspace 构建（`npm run build:native`），零外部 crate 依赖：Shim 仅用 std 并给自身挂 kill-on-close Job Object，AppX 手写 COM 声明，Secret 手写 DPAPI/kernel32 声明；任意干净的 Rust 工具链即可构建。Shim 产物经 e2e:native 全链路验证，Job Object 级联清理由 `npm run test:native-job-object` 验证。

## 进程监管

- Shim 启动即把自身加入 Job Object（`KILL_ON_JOB_CLOSE`）：node 宿主、官方 app-server、各家 CLI 与 pwsh 终端全部随 shim 级联清理，强杀或崩溃也不例外。
- 宿主每 5s 写心跳（`%APPDATA%\harness-mix\codexhost\runtime\instance.json`）；`uncaughtException` / `unhandledRejection` / `SIGBREAK` 会写入同目录 `crash-<ts>.json` 并尝试优雅收尾。
- 启动器在重启桌面前清扫本项目残留进程（仅匹配 shim 二进制路径与 `native-host.cjs` / `desktop-controller.mjs` 入口），并把上次异常退出时运行中的任务标记为 interrupted，重新发送即可继续。
- 适配器与终端统一经 `src/main/native/process-utils.js` 的 `terminateTree()`（Windows `taskkill /T /F`）终止进程树。

## 安全存储与诊断

- `harness-mix-secret.exe`（DPAPI，当前用户范围）提供平台保险箱：`set / get / delete / list`，密文落盘 `<data>\secrets.dat`；JS 入口 `src/main/native/secure-store.js`，helper 缺失时明确报错、绝不降级为明文。当前没有默认凭据写入，供后续功能（私有 registry token、直连模型密钥等）使用。
- `host-traffic.jsonl` 与 `shim-invocations.log` 均为 5MB × 3 轮转；写盘前对 Bearer/API key 形态与敏感字段键做脱敏（`src/main/native/redact.js`）。
- `npm run diagnostics`：把版本、桌面兼容状态、更新/实例状态、脱敏日志尾与最近崩溃报告打包为 zip 输出到 `output/`，供问题反馈。

默认 Host 数据目录为 `%APPDATA%\harness-mix\codexhost`，可用 `CODEXHOST_DATA_DIR` 覆盖。

本项目仅保存以下非凭据配置到该目录的 `harness-mix-settings.json`，以适配 Windows AppX 环境传递：

- `HARNESS_MIX_DSH_ROOT`：可选 DSH 源码目录。
- `HARNESS_MIX_CODEBUDDY_EXECUTABLE`、`HARNESS_MIX_KIRO_EXECUTABLE`、`HARNESS_MIX_CURSOR_EXECUTABLE`：可选原生 CLI 路径。CodeBuddy 兼容旧的 `HARNESS_MIX_WORKBUDDY_EXECUTABLE`，新变量优先。接口与验收见 [原生 ACP 深度适配](native-acp.md)。
- `CODEXHOST_PI_COMMAND`、`CODEXHOST_CLAUDE_COMMAND`、`CODEXHOST_DEEPSEEK_HARNESS_COMMAND`、`CODEXHOST_ANTIGRAVITY_COMMAND`：可选原生命令路径。

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
