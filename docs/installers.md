# 安装器构建（Windows / macOS）

除了 npm 分发（`npm install -g @harness-mix/cli`），Harness Mix 也可以在 GitHub
Release 挂载双击安装包：`harness-mix-<版本>-windows-x64.exe`、
`harness-mix-<版本>-macos-arm64.dmg` 等，按平台 × 架构各出一份。安装包面向
不想接触 Node/npm 的用户；两种分发形态的运行时行为完全一致。

## 安装包里是什么

安装器不打包任何 GUI——Harness Mix 的界面本来就寄宿在官方 Codex Desktop
里。安装内容与 npm 包同构：

- 包源码（`src/`、`scripts/`、`config/`、`docs/`、`licenses/` 等），布局与
  npm 包根一致，launcher 的相对路径解析不受影响；
- `output/native-build/` 下 freshly 构建的原生二进制与 esbuild 产物
  （Shim、AppX 激活器、DPAPI vault、renderer extension、desktop controller）；
- 生产依赖 `node_modules`（仅 dependencies / optionalDependencies）；
- 捆绑的官方 Node.js 运行时（v24 系列，下载时校验 SHASUMS256），因此用户
  机器不需要预装 Node。

安装形态对应更新通道里的 `portable`：launcher 检测到非 git、非 npm 全局目录
时跳过自动更新，只打一行日志（见 `src/main/native/updater.js`）。安装版升级
= 重新运行新版安装器覆盖安装；升级前请先退出正在运行的 Harness Mix /
Codex Desktop，避免运行中的 node.exe 锁住文件。

## Windows（Inno Setup）

- 脚本：`scripts/release/windows/Installer.iss` + `scripts/release/windows/package.cjs`
- 本地构建：`npm run build:native && npm run dist:windows -- --arch x64|arm64`
- 需要 Inno Setup 6.3+（`winget install JRSoftware.InnoSetup` 或
  `choco install innosetup`；找不到 ISCC 时可用 `HARNESS_MIX_ISCC` 指定路径）
- per-user 安装到 `%LOCALAPPDATA%\Programs\Harness Mix`，不需要管理员权限；
  开始菜单快捷方式（可选桌面快捷方式）直接指向
  `runtime\node.exe scripts\launch-codex.cjs`
- 未做代码签名：首次运行会有 SmartScreen 提示，选择“仍要运行”即可

## macOS（.app + dmg）

- 脚本：`scripts/release/macos/package.sh`
- 本地构建：`npm run build:native && npm run dist:macos`（或传
  `arm64` / `x64` 参数；脚本会拒绝在异架构宿主上交叉打包）
- 产物是一个最小 `Harness Mix.app`（`LSUIElement`，无 Dock 常驻图标），
  入口脚本 exec 捆绑 Node 运行时执行 launcher；图标由
  `src/assets/brand-harness-mix.png` 经 `sips` + `iconutil` 现场生成
- 二进制与 bundle 做 ad-hoc 签名（`codesign --sign -`）；dmg 优先用
  `create-dmg`（带 Applications 拖拽链接），缺失时回退 `hdiutil`
- 未公证：首次打开需右键 → 打开，或在“系统设置 → 隐私与安全性”里放行

## CI

`.github/workflows/installers.yml` 在推送 `v*` 标签（或手动触发）时构建
四份安装包并挂载到对应 Release：

| 目标 | Runner |
| --- | --- |
| windows-x64 | `windows-latest` |
| windows-arm64 | `windows-11-arm` |
| macos-arm64 | `macos-latest` |
| macos-x64 | `macos-15-intel` |

发布顺序：先由 `publish:native` 流程发布 npm 与各平台原生包，再推标签触发
安装器构建——payload 的 `npm install` 需要能解析到同版本的
`@harness-mix/native-*` 可选依赖（缺失时仅告警跳过，二进制以
`build:native` 现场产物为准）。

## 调试

- 只组装 payload 不编译安装器：`npm run dist:prepare -- --platform win32 --arch x64`
- `--skip-deps` / `--skip-runtime` 可在离线环境快速验证组装逻辑；
  Node 归档缓存在 `output/installer-cache/node/`
- 产物统一输出到 `output/installers/`（不入库）

Windows 快捷方式图标 `scripts/release/brand/harness-mix.ico` 由
`src/assets/brand-harness-mix.png` 预生成（16–256 共六档尺寸），换品牌图时
用任意 ICO 工具从该 PNG 重新导出并覆盖提交。
