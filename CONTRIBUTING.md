# 贡献指南

感谢关注 Harness Mix！欢迎通过 issue 反馈问题、通过 PR 贡献代码。

## 快速上手

```bash
git clone https://github.com/emo-xiaoyu/harness-mix.git
cd harness-mix
npm install
npm start          # 启动 native 模式（需要本机已安装并登录对应 Harness 的原生 CLI）
```

开发环境需要 Windows、macOS 或 Linux、近期 Node.js LTS 和 npm；执行 `npm run build:native` 还需要 Rust 工具链。平台前提与真机验收范围见[跨平台指南](docs/cross-platform.md)。

## 提交前请自验

改动任何代码后，至少跑通：

```bash
npm run check          # 语法检查，必须通过
npm run test:core-all  # 内核测试套件（contracts / projector / adapters / runtime 等）
```

涉及 adapter 或 runtime 的改动，请追加一轮 `npm run e2e:native`（必要时加 `:pi` / `:dsh` / `:claude`）真机验证。

## Issue 与 PR 约定

- Bug 报告与功能建议请走 issue 模板（`.github/ISSUE_TEMPLATE/`），使用咨询请到 [Discussions](https://github.com/emo-xiaoyu/harness-mix/discussions)。
- 提交信息使用 Conventional Commits：`feat(adapter): add fork capability to pi`、`fix(host): ...`、`refactor: ...`。
- PR 描述请说明影响的层次（renderer 扩展 / desktop 控制 / runtime / adapter），诚实声明能力变化；UI 改动请附冒烟日志或截图。
- 官方 Codex 是受保护的原生通路：默认官方 Codex 线程必须走 Codex Desktop 自带的 app-server，不得被 Shim / Host / 适配层接管。

## 安全边界

Harness Mix 不读取、不保存任何凭据——账户、密钥与权限始终归各原生 Harness 所有。请不要在 PR 中引入代理或持久化 token 的逻辑，也不要在适配层伪造权限决定。

仓库结构与模块划分的完整说明见 [AGENTS.md](AGENTS.md)。
