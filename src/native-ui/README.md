# Harness Mix native Desktop boundary

The renderer-extension, desktop-control and shared-contracts source directories
are derived from BytePioneer-AI/codex-host v0.6.1, commit
da97fa7b447d03bd3626bb8f782234d5fa519141 (MIT, see LICENSE).
They are maintained and built in this repository. No upstream Host Runtime,
ProtocolCore, adapter or account store is imported. Upstream wire names are
retained solely for compatibility with this renderer boundary.

Execution is owned by src/main/host/runtime.js and src/main/protocol-core.
Launcher and Shim sources live in src/main/native. Project icons are compiled
directly from src/assets/icons. Generated artifacts live in output/native-build.

## CodeBuddy、Kiro 与 Cursor

默认 Agent 列表与 Host 注册表同步，三者分别保存模型偏好并使用独立插件路由。Workbuddy 已更名为 CodeBuddy，旧模型/分组偏好在读取时兼容迁移。原生协议、安装与验证边界见 [原生 ACP 深度适配](../../docs/native-acp.md)。
