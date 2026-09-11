# 项目记忆 — Harness Mix

## 这是什么
本地内核，把多个原生 Coding Harness（Pi / OMP / Claude Code / DeepSeek Harness / Antigravity / Codex / OpenCode / Grok / OpenClaw / Hermes）接进**官方 Codex Desktop 原生 UI**。会话生命周期、模型调用、审批、文件差异都由本仓 `HostRuntime + ProtocolCore + Adapter` 管理；凭据与权限决定永远归各原生 Harness。Apache-2.0，仅 Windows。

## 调用链（原生模式 = 唯一模式）
`Codex Desktop 原生输入框 → harness-mix-shim.exe (Rust) → src/main/native/host.js → src/main/host/runtime.js + protocol-core → src/main/adapters/*.js → src/main/native/protocol.js 投影 → Desktop 原生流式/工具/审批/Diff 组件`

## 关键目录
- `src/main/adapters/` — 每 Harness 一个适配器，`index.js` 的 `REGISTRY` 是唯一注册点（Manifest + 工厂 + Session 形态）。Pi/OMP 共用 `pi-family.js`；OpenCode 走原生 HTTP/SSE；Grok 独立映射 stdio + `_x.ai/*`；OpenClaw 走本机 Gateway loopback WS；Hermes/Grok 之外的 ACP 家族共用工厂。
- `src/main/host/` — `runtime.js`（733 行，编排/恢复/投影）、`core-session.js`、`collaboration.js`（多 Agent 协作）、`store.js`/`jsonl.js` 持久化。
- `src/main/protocol-core/` — Thread/Turn/Item 统一语义、Projector、Sequence 校验、InteractionRouter、CapabilityManager。
- `src/main/native/` — Launcher、Shim 入口、`protocol.js`、`updater.js`、`rs/`（Rust workspace，零外部 crate）。
- `src/native-ui/` — 注入 Codex Desktop 的 TypeScript 扩展：`renderer-extension/`（50+ 个 renderer-*.ts）、`desktop-control/`（CDP 控制器）、`shared-contracts/`。
- `scripts/` — 全部是 `.cjs` 验证脚本，**无单元测试框架**。

## 硬约定
- 纯 CommonJS，2 空格缩进、单引号、`require/module.exports`；无 TypeScript/打包器/linter，`npm run check`（`node --check` 全量）是强制门槛。
- 能力只写在 Adapter 的 `manifest.capabilities` 里，界面读 capability，**禁止按 Harness 名称猜功能**；未接线未验证的能力不得声明。
- 架构守卫（`architecture-test.cjs`）禁止生产代码引用 legacy 测试 oracle，禁止 Runtime/执行视图按 Harness 名分支。
- 验证分层：`check` → `test:core-all` → `e2e:native` / `e2e:<harness>`。改动 adapter/runtime 必须加 e2e。产物写 `output/`，不提交。
- 提交规范：Conventional Commits，`feat(adapter): ...` / `fix(native): ...`。
- 运行时：Node 22.19+；Host 数据目录 `%APPDATA%\harness-mix\codexhost`（可被 `CODEXHOST_DATA_DIR` 覆盖）；只写非凭据配置 `harness-mix-settings.json`。

## 当前状态（2026-09-10）
- 最新提交 `f840206 fix(native): align thread projection with the upstream external-thread contract`。
- **工作区有 89 处未提交改动 + 一批未跟踪文件**（新增 openclaw/grok/hermes/omp 适配器与测试、`docs/multi-agent-collaboration.md`、若干图标）。注意 AGENTS.md 里"无 git 历史"的说法已过期。
- `NEXT-STEPS.md` 的 P0/P1 均已标注完成；下一步建议是先做 P0 全量验收再拆分提交，避免继续叠加让人更难回退。
- 有一批过程文档：`CORE-MIGRATION-STATUS.md`（Core 迁移验收）、`design-qa.md`（首页设计比对，结论 passed）、`docs/native-codex.md`。
- 已知边界：DSH 原生 diff 不投影（Web 协议只有 hunk 级）；桌面完整重启后的 UI 交互尚未正式验收（协议 E2E ≠ 桌面 UI 验收）。
