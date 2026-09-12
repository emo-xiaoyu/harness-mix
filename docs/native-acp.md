# CodeBuddy、Kiro CLI、Cursor CLI 与其他原生 ACP 接入

CodeBuddy、Kiro CLI、Cursor CLI 和 Qoder 使用原生 ACP stdio，并在 `native-acp.js`、
`acp-interactions.js` 中处理厂商差异。ZCode、Trae 也复用此引擎，但当前只有显式
ACP 程序配置入口，尚未验证可用桥接程序，不能称为已完成官方原生接入。
不替换原生账号、不代理模型供应商、不自动批准工具请求。

## 安装与旧名称兼容

| Harness ID | 原生启动 | 可选路径变量 | 安装入口 |
| --- | --- | --- | --- |
| `codebuddy` | `codebuddy --acp` | `HARNESS_MIX_CODEBUDDY_EXECUTABLE` | [CodeBuddy CLI](https://www.codebuddy.ai/docs/cli/overview) |
| `kiro-cli` | `kiro-cli acp --agent-engine v3 --auth-method cli` | `HARNESS_MIX_KIRO_EXECUTABLE` | [Kiro CLI](https://kiro.dev/docs/cli/) |
| `cursor-cli` | `cursor-agent acp` | `HARNESS_MIX_CURSOR_EXECUTABLE` | [Cursor CLI](https://cursor.com/docs/cli/installation) |
| `qoder` | `qodercli --acp` / `qoder --acp` | `HARNESS_MIX_QODER_EXECUTABLE` | [Qoder 官方 ACP 文档](https://docs.qoder.com/cli/acp) |
| `zcode` | 显式指定 ACP 桥接程序，无附加参数 | `HARNESS_MIX_ZCODE_ACP_EXECUTABLE` | [ZCode](https://zcode.z.ai/)；本机原生 CLI 仅确认 app-server |
| `trae` | 显式指定兼容 ACP 程序，无附加参数 | `HARNESS_MIX_TRAE_EXECUTABLE` | [官方 trae-agent](https://github.com/bytedance/trae-agent)；未确认 ACP 支持 |

Qoder 在 Windows 上识别 npm 包并直接启动官方 JavaScript bundle。ZCode 的
`app-server --stdio` 使用厂商协议，不能直接填入 ACP 程序路径。旧的 `zcode acp`、
`traecli acp serve` 缺少官方依据，已移除；未配置桥接时明确显示不可用。
Trae 官方开源项目的命令名是 `trae-cli`，不代表它具备 ACP 服务模式。
本项目不自动安装第三方桥接器，也不复制其凭据同步或默认 yolo 策略。

CodeBuddy 优先使用明确指定的路径，再搜索 PATH 和 WorkBuddy 桌面自带的
CodeBuddy CLI。旧变量 `HARNESS_MIX_WORKBUDDY_EXECUTABLE` 继续有效，新变量优先。
`workbuddy` 是兼容别名；只注册一个 CodeBuddy 适配器。启动时迁移 Host 任务和
Harness 切换历史中的旧 ID，保留原生会话 ID、文件位置和对话内容。
Renderer 读取旧默认模型和分组偏好时同步迁移旧名称。

Cursor 在 Windows 上识别官方版本目录并直接运行其 Node bundle。
不使用含义不明确的 `agent` 命令，因为它也可能属于 Grok。
显式路径无效会报错，不能静默转向其他安装。

## 专用适配

| 能力 | CodeBuddy | Kiro CLI | Cursor CLI |
| --- | --- | --- | --- |
| 模型/配置 | 原生 model、thought_level、mode；等待确认 | 原生 model、effortLevel；auto 不显示独立 effort | 保留完整模型变体及原生执行模式 |
| 审批 | 保留原生 optionId 与单次/持久范围 | 原生选项；consent 携带会话/工作区及资源元数据 | 原生 optionId 与作用范围 |
| 提问 | AskUserQuestion → resolveInterruption；旧 question 回调；失败可重试 | `_kiro/userInput` 文字/选项 | `cursor/ask_question` 单选/多选 |
| 计划 | ACP plan 投影 | ACP plan 投影 | `cursor/create_plan` 接受/拒绝/取消 |
| 取消 | 等待取消完成，再关闭、重连、load 同一会话并恢复确认过的配置 | 原生 cancel；超时关闭并报故障 | 原生 cancel；超时关闭并报故障 |
| 恢复 | session/load；加载期间不重复输出历史 | session/load | session/load |
| 压缩/fork | 不支持 | 仅调用握手声明的 compact/fork；不伪造检查点 | 不支持 |
| 用量 | 按原生 model request ID 去重 Token/Credits；标准 ACP 上下文 | 原生上下文百分比、usage 元数据 Credits 去重 | 不声明用量 |
| 原生历史导入 | JSONL 当前 parent 链，校验 cwd/session/path/大小/环 | 仅现有 Host 历史与原生恢复 | 仅现有 Host 历史与原生恢复 |

共享处理包括：每会话独立进程、会话级 MCP 注入、拒绝并发提交和忙时改配置、
30 秒启动/配置/取消超时、忽略其他会话和旧连接事件、工具终态去重、仅在工具
成功后投影原生完整 Diff。已知 Cursor 损坏的 diff header 回退保持为工具输出，
不猜测文件内容。Credits 保持独立字段，不换算为美元。

多选问题目前通过输入 JSON 字符串数组表达；选项会展示在问题中，提交时按原生
选项 ID 校验。CodeBuddy 允许原生提问支持的自定义回答。

## 能力边界

- 这是针对本项目接口实现的适配，不是完整移植 codex-host 的插件系统。
- 原生子 Agent 的独立卡片、后台生命周期与子会话历史浏览尚未实现。
  CodeBuddy 带 parentToolCallId 的子 Agent 内容不会混入父回答。
- Kiro fork 只读取并校验原生 session.json/messages.jsonl 的最新完整 turn_end，
  将真实 messageId 传入原生 fork；压缩、tombstone 或缺失边界明确拒绝。
- Kiro 原生历史导入、Cursor 的内部 SQLite 历史导入未实现；恢复已有 Host
  任务使用原生 session/load，不读写其私有数据库。
- CodeBuddy/Kiro/Cursor/Qoder 的图片以 ACP image block 传递，仅在原生握手声明
  `promptCapabilities.image` 时接受；缺失能力时拒绝，不能静默丢图。2026-09-12
  实机图片回路在 CodeBuddy 通过；Kiro/Cursor 未安装，Qoder 被额度阻断。DSH 和
  OpenClaw 的当前模型明确拒绝图片，属于模型能力限制而非 Host 丢图。
- 精确消息回退、CodeBuddy/Cursor fork、账号配额查询不声明支持。
- Kiro autopilot 不伪装为 Host 权限级别；未知扩展请求明确报不支持。
- 部分 CLI 不提供原生 Diff 或用量，缺失时不从当前文件/估算值补造。
- CodeBuddy/Kiro/Cursor/Qoder/ZCode/Trae 的 ACP 会话可接收每会话 MCP 定义，
  但只有本机安装且握手成功的程序才会开放入口；ZCode、Trae 仍需显式兼容 ACP
  桥接器，不能把其 app-server 或普通 CLI 当成 ACP。
- DSH 协作主任务走官方 `dsh --profile acp`，由同一 ACP 引擎接收 session-scoped
  MCP；普通 DSH 任务继续使用 Web Remote。Runtime 保持 Adapter `open()` 返回
  的会话对象身份，避免原生回调更新到浅拷贝而被活动回合闸门丢弃。

## 验证

```powershell
npm run test:native-acp-depth
npm run test:kiro-cursor
npm run test:core-all
npm run test:native-ui
npm run e2e:native-acp
npm run e2e:native
npm run health:harnesses -- --live
npm run health:harnesses -- --live --image-only --image=<绝对图片路径>
```

深度协议测试使用模拟原生子进程，覆盖取消/重连后继续、配置确认、忙时拒绝、
会话隔离、审批原生 ID、提问失败重试、多选、计划拒绝、Kiro 上下文/fork、
Diff 去重、历史 parent 环和 Credits 去重。这些测试不是模型执行证据。

2026-09-12 实机结果：CodeBuddy 2.132.0 返回 17 个模型和 8 个模式，完成文本
回复后关闭进程，session/load 同一原生会话并再次回复成功。此版本当前模型未
返回独立思考选项，因此未伪造档位。Kiro/Cursor 未在 PATH 和默认目录发现，
真实模型、专用交互以及重启桌面验收待安装登录后完成。日志保存在
`output/native-acp-live/1789182835967/report.json`（本地构建产物，不提交）。

Qoder 1.1.49 实机完成 ACP 初始化、创建会话，返回 1 个模型和 5 个原生模式。
文本请求返回账号 Credits 额度耗尽，因此模型回复、恢复和工具执行尚未通过实机验证。
日志：`output/native-acp-live/1789187177461/report.json`。
新增六种协议配置的模拟进程回归、延迟 ACP 最终事件回归和图片握手拒绝测试；
ZCode/Trae 的模拟测试只验证共享引擎，不能作为其官方 CLI 已接通的证据。

2026-09-12 全 Harness 健康检查（均在独立临时工作目录执行）：文本回路通过
Pi、DSH、Claude Code、Codex、Grok、CodeBuddy；OpenCode 被账户余额阻断，Qoder
被 Credits 额度阻断，OMP、Hermes、Kiro、Cursor 未安装。图片回路通过
Antigravity、Pi、Claude Code、Codex、Grok、CodeBuddy；DSH/OpenClaw 的当前模型
拒绝图片，Qoder/OpenCode 分别被额度/余额阻断。报告：
`output/harness-health/1789191914230/report.json`（文本）和
`output/harness-health/1789191791797/report.json`（图片）。

## 参考与图标

协议字段对照了 [codex-host 7cc4db87](https://github.com/BytePioneer-AI/codex-host/tree/7cc4db87fe5e5aa7f232e592a6ff8f0ff96534c9/packages/adapters)
的 codebuddy、kiro-cli、cursor-cli 实现及接口说明；其测试结果不视为本项目证据。
CodeBuddy 和 Cursor 图标取自该提交的官方品牌资源副本，Kiro 沿用仓库已有
官方 SVG。品牌标志归原所有者所有，不表示厂商背书。
