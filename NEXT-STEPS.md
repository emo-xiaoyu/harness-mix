# Harness Mix 下一步执行清单

更新日期：2026-09-08

## 当前基线

- Protocol Core 的 P0/P1 迁移已完成，生产链路为 Adapter → EventNormalizer → ProtocolCore → Renderer。
- Codex、Pi、Claude Code、DeepSeek Harness 均保留原生会话与协议边界。
- Codex 已使用官方 `codex app-server --stdio`；Pi 使用原生 RPC；Claude Code 使用 Agent SDK；DSH 使用 Web Remote。
- 会话恢复、回复级 Fork、原生命令、工具活动、文件变更、审批、模型目录、上下文用量已经进入统一投影。
- 首页和会话外壳已按选定原型调整；Pi、Codex 使用用户提供的品牌 SVG。
- 当前工作区包含一批尚未整理成独立提交的 Core、Adapter、Renderer 和测试改动。

## 下一步优先级

### P0：冻结当前里程碑并完成全量验收

目标：先形成一个可回退、可审查、可交付的稳定基线。

- 审查当前全部差异，移除过期说明和重复实现。
- 执行 `npm run check`、`npm run test:core-all`、`npm run test:workspace`、`npm run test:git`。
- 执行 `npm run smoke`、`npm run smoke:workbench`、`npm run smoke:core`、`npm run smoke:app`。
- 对四个真实 Harness 分别复验创建、发送、取消、恢复、模型目录与用量。
- 对声明支持的原生能力复验 Fork、Compact、审批和文件变更。
- 按 Core/Adapter、Renderer、资源与文档拆分提交，然后推送。

完成标准：全部自动检查通过，四个 Harness 的真实验收报告没有 error、warning 或 parity mismatch，工作区只剩明确保留的本地文件。

### P1：把当前可见但未接通的入口做实

目标：消除“看得到但点了只是提示”的主流程入口。

- 接通附件按钮，支持图片和文件选择、预览、移除，并按 Harness 能力传递。
- 实现真正的命令面板与 `Ctrl+K`，聚合当前 Harness 的原生命令、Compact、Fork、权限和模型动作。
- 让首页四张卡片进入对应真实流程，而不是只聚焦输入框。
- 完成搜索、分享、语音等入口的产品边界；暂不实现的入口应隐藏或明确标为不可用。
- 补齐项目菜单与任务菜单的键盘导航、焦点恢复和加载状态。

完成标准：首页和输入区的主要按钮均有真实结果，延迟加载只出现在被点击的菜单内部。

### P2：补齐四个 Harness 的原生能力矩阵

目标：统一 Host 表达，同时继续由各 Harness 拥有原生能力。

- 为 Codex 补齐更细的审批选项、Review、MCP elicitation 和子任务事件映射。
- 复核 Pi 的 session tree、指定节点 Fork、Compact 与上下文统计。
- 复核 Claude Code 的 resume、permission、hooks、subagent 与 compact 行为。
- 复核 DSH 的 fork、compact、usage、question/approval 和 Web Remote 重连。
- 把能力差异写入 manifest 与自动测试；Renderer 只读取 capability，不按 Harness 名称猜测。

完成标准：每项可见操作都能追溯到 manifest 声明、Adapter 实现和至少一条真实验收证据。

### P3：可靠性与发布

目标：把开发态应用变成可长期使用的 Windows 桌面产品。

- 增加会话数据 schema 版本和迁移测试。
- 增加原生进程监督、异常退出恢复、诊断日志与一键导出。
- 验证应用关闭、重开、休眠唤醒、网络断开与多个并行任务。
- 完成应用图标、版本信息、Windows 安装包、签名和升级策略。
- 建立发布前验收清单，确保输出目录和本地凭据不进入 Git。

完成标准：安装包可在干净 Windows 环境运行，异常中断后能恢复会话，原生 Harness 账号和凭据仍完全由各自程序管理。

## 建议立即执行

先完成 **P0 全量验收与里程碑提交**。当前核心能力和新版界面已经集中在同一工作区，继续叠加附件或命令面板会扩大审查和回退成本。P0 完成后，按 **附件 → 命令面板 → 能力矩阵 → 安装包** 的顺序推进。

