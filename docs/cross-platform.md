# macOS / Linux 适配设计与运行

保留 Launcher → Shim → HostRuntime → ProtocolCore → native Harness → 原生 Codex UI。平台差异集中在 `src/main/native/platform.js`，不引入独立桌面 UI，不改变模型、工具、登录和审批的所有权。

## 支持范围

| 层 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 安装元数据 | x64 / arm64 | x64 / arm64 | x64 / arm64 |
| Shim 构建 | Rust + AppX/DPAPI helpers | 本机 Rust Shim | 本机 Rust Shim |
| 桌面发现 | AppX | `/Applications/Codex.app`、`~/Applications/Codex.app` | 显式指定已安装的兼容桌面可执行文件 |
| 启动 | AppX 环境注入 | 直接执行 `.app/Contents/MacOS` | 直接执行 Electron 桌面二进制 |
| 本项目 secret helper | DPAPI | 明确不可用 | 明确不可用 |
| 实际桌面验收 | 见版本兼容性清单 | 待真机验收 | 待兼容桌面和真机验收 |

安装元数据表示允许安装和本机构建，不表示所有 CPU、桌面版本及所有 Harness 已通过验收。macOS/Linux 当前使用源码安装；不要把 Windows 的 `.exe` 或另一 CPU 架构的 Shim 复制过去。现有 npm 全局安装的预编译分发仍以 Windows 为主，尚未提供各系统/架构的独立发布包。

Linux 启动支持有前提：必须自行安装支持 `CODEX_CLI_PATH`、app-server 和 CDP 的兼容 Electron 桌面。本项目没有捆绑 Linux Codex Desktop，也不保证官方 Linux 桌面可用。无兼容桌面时可以构建和运行内核/协议测试，不能启动原生 UI。请使用实际可执行文件路径，不使用 `.desktop` 文件、启动脚本或 AppImage 外层包装器。

## macOS 安装

安装 Node.js 22.19+（22.x）或 24.x、Rust stable、Git 和 Codex Desktop。Apple Silicon 使用 arm64 Node/Rust；Intel 使用 x64。先用各 Harness 自己的命令完成安装和登录。

```sh
git clone https://github.com/emo-xiaoyu/harness-mix.git
cd harness-mix
npm ci
npm run build:native
npm run test:platform
npm run test:shim
npm run check:native
# 完全退出已有 Codex Desktop 后启动
npm start -- --no-update
```

非标准安装目录，在上述检查与启动前设置：

```sh
export HARNESS_MIX_DESKTOP_APP="/absolute/path/Codex.app"
```

启动器读取 Info.plist 的可执行文件名和版本，默认使用 `Contents/Resources/codex`。CLI 布局不同时设置 `HARNESSMIX_STOCK_CODEX_PATH`，必须指向桌面自带的原版 CLI，不能指向 Harness Mix Shim。不改写签名包，不关闭 Gatekeeper。CLI 工具需在启动终端的 PATH 中可用。

## Linux 安装

安装同样的 Node、Rust、Git，以及系统 `ps`（通常由 procps 提供）和 `tar`。桌面启动需要可用的图形会话及该 Electron 应用的系统依赖。

```sh
npm ci
npm run build:native
export HARNESS_MIX_DESKTOP_EXECUTABLE="/absolute/path/to/desktop-binary"
export HARNESSMIX_STOCK_CODEX_PATH="/absolute/path/to/resources/codex"
# 填写真实桌面版本，不是 CLI 版本；未知时省略，兼容性显示 unverified
export HARNESS_MIX_DESKTOP_VERSION="1.2.3"
npm run check:native
npm start -- --no-update
```

## 平台行为

- 数据目录：Windows 延续 `%APPDATA%/harnessmix`；macOS 使用 `~/Library/Application Support/harnessmix`；Linux 使用 `$XDG_DATA_HOME/harnessmix`，默认 `~/.local/share/harnessmix`。`HARNESSMIX_DATA_DIR` 始终优先。历史 Unix 试用数据如在其他目录，需显式设置该变量；不会自动搬迁。
- macOS/Linux 要求先退出已运行的同一个桌面程序，避免 Electron 单实例复用丢失 Shim 环境。不会按程序名批量清理用户进程。
- Unix Shim 使用 `exec` 替换自己，保留 PID、stdio 和信号；正常关闭依赖 Host 的 EOF/SIGTERM 清理。停止 Harness 时按父子关系清理子进程。Unix 不宣称具备 Windows Job Object 在 `SIGKILL` 下的强制整树退出保证；已经脱离父进程的 daemon 不属于该保证。
- Grok、Hermes 的 Unix 默认命令去掉 `.exe`；DSH Web 模式在 Unix 使用 `npm`，必须配置 `HARNESS_MIX_DSH_ROOT`。其他 Harness 仍需其厂商提供相应系统的原生 CLI，不将协议适配等同于厂商跨平台支持。
- Windows 的旧兼容性记录只对 Windows 生效。macOS/Linux 未有同平台 `desktop-e2e` 证据时，`HARNESS_MIX_STRICT_COMPATIBILITY=1` 会拒绝启动。`check:native` 仅检查安装和构建产物，不代表真实 UI 验收。
- 本次覆盖本地桌面启动。继承的 Remote Control 桥接仍含 Windows 描述文件和 PowerShell 启动逻辑，不属于 macOS/Linux 支持范围。
- `npm run diagnostics` 在 Windows 输出 zip，在 macOS/Linux 输出 tar.gz。凭据仍归原生 Harness 管理，无新增凭据存储。

## 验证与发布门槛

CI 增加 Windows/macOS/Linux 的 Node 22/24 内核测试和本机构建，真实 Shim fixture 检查路由、Unicode、带空格参数、环境变量及 EOF；这些不需要账户。配置 CI 不等于已执行 CI。当前 Windows 开发机不能代替 macOS/Linux 真机结果。

在每种目标 OS/CPU 上运行 `npm run check`、`npm run test:core-all`、`npm run build:native`、`npm run test:platform`、`npm run test:shim`、`npm run e2e:native`，再启动真实桌面，逐个验证所需 Harness 的模型列表、Thinking、流式工具输出、原生审批、取消、历史恢复及退出清理。记录 OS、CPU、桌面版本和证据后，才能增加该平台的 `desktop-e2e` 记录。后续发布矩阵需要覆盖 macOS Intel/Apple Silicon、Linux x64/arm64，不能用单个平台的构建文件混发。

## Native npm 包发布

平台包的名字固定为 `@harness-mix/native-<platform>-<arch>`。在目标机器完成构建和 Shim fixture 后，从仓库根目录执行：

```sh
node scripts/publish-native-package.cjs darwin arm64 --publish
node scripts/publish-native-package.cjs darwin x64 --publish
node scripts/publish-native-package.cjs linux x64 --publish
node scripts/publish-native-package.cjs linux arm64 --publish
node scripts/publish-native-package.cjs win32 x64 --publish
node scripts/publish-native-package.cjs win32 arm64 --publish
```

脚本默认检查目标二进制是否存在，再生成带 `os`/`cpu` 限制的包；本次可用 `--source-only` 发布平台元数据占位包，安装时会提示目标机器执行 `npm run build:native`。主包通过 `optionalDependencies` 选择平台包。当前已发布 `@harness-mix/native-win32-x64@0.1.4`，其余目标先发布 source-only `0.1.4`，正式二进制完成后必须升级版本，不能覆盖同一 npm 版本。
