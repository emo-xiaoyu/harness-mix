# 原生 Codex UI 接入

`npm start`、`npm run start:codex`、`Start-Codex.cmd` 均启动原生模式（唯一模式）。

## 调用链

```text
Codex Desktop 原生输入框 / Harness 选择器
  → 本地编译的 Harness Mix CLI Shim (harness-mix-shim.exe)
  → Harness Mix 原生 Host 入口 (src/main/native/host.js)
  → Harness Mix 本地 HostRuntime (src/main/host/runtime.js) & ProtocolCore
  → 本地 Harness 适配器 (Pi / Claude Code / DeepSeek / Antigravity / Codex)
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

每次 `npm start` 会先检查 `origin` 上游：可快进且无本地改动时自动拉取、按需重装依赖并重建原生组件，然后继续启动。分叉、本地领先或工作区有未提交改动时跳过并打印原因；更新失败（如离线）不影响启动。

- `npm run update`：只检查并应用更新，不启动桌面。
- `npm start -- --no-update` 或 `HARNESS_MIX_AUTO_UPDATE=0`：跳过本次更新检查。

## Shim 与激活器（Rust）

`harness-mix-shim.exe` 与 `harness-mix-appx.exe` 由 `src/main/native/rs` 下的 Rust workspace 构建（`npm run build:native`），零外部 crate 依赖：Shim 仅用 std，AppX 手写 COM 声明，任意干净的 Rust 工具链即可构建。产物经 e2e:native 全链路验证。

默认 Host 数据目录为 `%APPDATA%\harness-mix\codexhost`，可用 `CODEXHOST_DATA_DIR` 覆盖。

本项目仅保存以下非凭据配置到该目录的 `harness-mix-settings.json`，以适配 Windows AppX 环境传递：

- `HARNESS_MIX_DSH_ROOT`：可选 DSH 源码目录。
- `CODEXHOST_PI_COMMAND`、`CODEXHOST_CLAUDE_COMMAND`、`CODEXHOST_DEEPSEEK_HARNESS_COMMAND`、`CODEXHOST_ANTIGRAVITY_COMMAND`：可选原生命令路径。

环境变量优先于该文件；删除文件中的对应字段即可恢复默认。账号认证使用各原生程序和上游配置机制，本项目不保存凭据。

DSH 默认使用本项目安装的 `0.1.2-rc.1`，不会修改 `E:\dsh\deepseek-harness`。该源码目录当前 `0.1.2-alpha.5` 不满足上游适配器的版本要求。

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
