# 多 Agent 协作

## 用法

重新启动 Harness Mix 后，新建或恢复一个 Pi / Oh My Pi / Claude Code / **Codex（协作）** / Grok / OpenCode 任务，输入 `@`，在 **Agents** 页选择目标 Harness；**会话** 页单独提供历史引用。左右键切换分页，上下键选择，Enter/Tab 插入。Codex（协作）通过 Host Adapter 使用原生 app-server；原来的 Codex 入口仍为官方直通。可用目标来自 Host 注册的 Adapter；未就绪的目标不可选。示例：

```text
你负责实现后端。
@claude-code 审查 API 设计，只读，不修改文件。
@pi 为 tests/ 编写测试，不修改 src/。
收齐结果后由你运行验证并总结。
```

也可直接输入 `@pi`、`@claude`、`@dsh`、`@codex` 等已注册 ID/别名。显式 `[名称](harness-mix://agent/pi)` 引用可随草稿复制；代码块、行内代码和邮箱里的 @ 不作为路由元数据。提及本身由主模型结合用户任务理解，Host 不按文字片段盲目拆任务。

## 执行方式

借鉴 Codeg 的 [委派工具](https://github.com/xintaofei/codeg/blob/main/src-tauri/src/acp/delegation/tool_schema.json) 和 [Agent 引用路由](https://github.com/xintaofei/codeg/blob/main/src-tauri/src/acp/agent_mentions.rs)：

1. Host 为主任务提供会话绑定的协作工具。Claude 通过 SDK 的 MCP 配置，Codex Adapter 通过 app-server 的线程 MCP 配置，Pi/OMP 通过原生扩展加载，Grok 通过原生 `session/new` 的 `mcpServers` 槽注入（L1），OpenCode 通过 `OPENCODE_CONFIG_CONTENT` 内联配置注入 `mcp.servers`（L2，运行时最高优先级、不写任何用户配置文件）。
2. 主模型调用 `delegate_to_agent(agent_type, task)`，立即取得 `task_id`，可以继续发起其他任务。
3. Host 创建带 `parentThreadId` 的独立原生会话。任务中需要的上下文由主模型明确传递，不复制其他 Harness 的隐藏状态、账户或权限。
4. `update_agent_plan(steps)` 发布开发、审查、返工和最终验收计划；步骤状态为 pending / in_progress / completed。`get_delegation_status(task_ids, wait_ms)` 收取状态和最终文本；单次等待不超过 60 秒。`message_agent` 在已结束的子会话中继续对话，`cancel_delegation` 取消子任务。
5. 结果作为真正的原生工具结果返回主模型，由主模型验证、整合并继续执行。Host 额外投影原生 `collabAgentToolCall` 协作卡片（真实子任务 ID、Harness 名称、提示词和最终状态），不代替主模型生成总结。

`list_agents` 提供真实可用性。旧 `/delegate` 仍是独立的手动委派入口，其完成结果只回投父任务工具卡片，不自动调用父模型。

## 执行边界

- 同一主任务最多四个同时运行的子任务，每轮最多创建十六个；子任务不注入协作工具，不允许递归委派。
- 模型工具委派默认共享主任务目录，子 Agent 使用独立原生会话。开发完成后再委派审查，审查意见通过 `message_agent` 发回原开发者，修复后复用原审查会话复审。主任务应等待依赖步骤完成并避免同时修改相同文件。主任务负责共享目录整体文件快照。显式 `isolation=worktree`（或 Git 项目中的 `auto`）仍创建隔离分支与工作区，保存主目录当前非忽略文件作为起点，保留用户暂存区；隔离改动不会自动出现在主目录。
- 协作不创建独立面板或第二套 UI。父子关系通过原生 `parentThreadId` 投影，子任务进入 Codex 原生任务体系；委派和跟进显示为原生协作卡片；普通工具及轮询仍显示为 MCP 工具卡片，审批在相应原生子任务中处理，文件变化由原生 Changes 界面展示。
- 主任务可调用 `review_delegation_changes` 在原生工具卡片中审查 worktree patch。只有用户明确要求应用时才可调用 `apply_delegation_changes`，并必须提交刚审查得到的 digest。应用前检查 Git patch 冲突；冲突时保留两个目录，交给用户处理。worktree 保留供检查，不自动删除。隔离子任务有独立审查快照；共享子任务仍由主任务记录整体快照。旧 `/delegate` 手动入口仍为共享目录。
- 同目录的无关任务仍受原有执行互斥约束。父任务结束/取消、Host 关闭会取消尚未完成的子任务；30 分钟未完成的子任务会超时。
- 协作 HTTP 桥仅绑定 loopback，以每个主任务的随机本地能力标识鉴权；工具参数校验，子任务归属检查，外部 Origin 拒绝。该标识不是模型账户令牌。Host 不读取或代理原生账户密钥。
- Claude 的 `canUseTool` 和 Codex MCP elicitation 继续走原生审批。需要确认时，用户在相应任务的审批界面处理；自动验证不会代答。
- 主任务 Fork 会重新绑定自己的协作身份，不复用源任务的子任务访问权。
- task_id、父子会话、任务文本、结果和 worktree 起点在独立串行存储中持久化；重启后在途任务变为 interrupted，不自动重复执行有副作用的操作。点击「继续协作」向原主任务发送续跑请求，主模型用 `list_delegations` / `resume_delegation` 恢复原子会话。原生会话丢失或无法恢复会明确报错。会话鉴权标识不持久化，重启重新签发。

## 支持与验证范围

| 入口 | 状态 |
| --- | --- |
| Pi 主任务 | 原生扩展工具；Pi→Pi、Pi→Claude 两条真实模型链路通过 |
| Claude Code 主任务 | SDK MCP 注入；本机真实运行触发原生工具审批，未代答，尚未完成模型闭环验收 |
| Oh My Pi 主任务 | 同 Pi 家族的扩展接线；本机未安装 OMP，真实验收未完成 |
| Codex（协作）主任务 | 已接入选择器、模型/强度、恢复归属、@ 菜单；桌面使用配套 CLI。真实请求已到原生 MCP 审批，尚未完成需授权的闭环 |
| Grok 主任务 | L1：`session/new`/`session/load` 原生 `mcpServers` 槽注入，恢复会话同样携带；真实模型闭环验收待跑 |
| OpenCode 主任务 | L2：`OPENCODE_CONFIG_CONTENT` 内联配置注入 `mcp.servers`（V2 schema），会话结束即失效；真实模型闭环验收待跑 |
| DSH 主任务 | 调研结论：DSH 自带 `@deepseek-ai/dsh-mcp-client`（stdio 配置：`transport/serverName/command/args/env`），门存在；host.call 会话通道的 MCP 注入点待上游确认，确认前保持 target-only |
| 官方 Codex 桌面直通任务 | 保持官方直通，不展示 Host 的 @ 协作菜单；不要把 Adapter 接线等同于已支持这个入口 |
| 其他 Harness 主任务（含 Antigravity） | Agents 页明确提示需要切换可编排的主 Agent，目标不可选；历史引用仍可用；可使用旧 /delegate |
| 子任务目标 | 所有已注册且本机可用的 Adapter；不代表每一对组合都已实测 |

```powershell
npm run test:collaboration
npm run test:collaboration-recovery
npm run smoke:collaboration-ui
npm run e2e:collaboration -- --lead=pi --worker=claude
npm run check
npm run test:core-all
npm run test:native-protocol
npm run e2e:native
npm run build:native
```

`test:collaboration` 使用真实 MCP stdio 子进程、本地鉴权桥和受控原生会话 Adapter 验证并发、结果、跟进、取消、跨任务访问限制、历史引用提示和共享快照策略。UI smoke 只检查原生输入框内的 Harness/历史会话选择、图标、标识、键盘选取和清理，截图位于 `output/collaboration-ui/mentions.png`。协作过程由 Native Protocol 的原生工具卡片测试覆盖。这不是完整 Codex Desktop 的交互验收；构建过程不会重启当前桌面。

2026-09-10 验证：Pi→Claude 两个真实子任务分别在不同 worktree 运行，结果返回主模型并汇总通过。恢复测试覆盖持久化身份、原子会话续跑、不重复建任务；Git 测试覆盖脏目录起点、暂存区保留、过期预览拒绝、冲突时不部分应用。Native Protocol 覆盖父子任务归属与原生 MCP 工具卡片，Electron 仅覆盖原生输入框中的协作引用增强。

## 统一历史

设置 → 会话导入 → 全部历史，支持按标题、目录和会话 ID 搜索、分页、导入并打开。Pi、Claude、Codex 从本机原生历史发现会话；其余 Harness 当前聚合 Host 已管理的历史，并在来源名称上标为「Host 历史」，尚未接入各自 CLI 的外部会话扫描。

导入只创建投影和原生会话引用，不启动模型；再次发送时原生恢复。重复导入返回同一任务。输入 `@` 可从「会话」页选择一条记录；Host 最多读取三条引用，每条只附加最近十二条用户/助手文本，并明确标记为不可执行的历史数据。引用不会创建、恢复或占用原生会话。原始完整工具、隐藏状态和分支数据仍留在原生存储，因此这不是原生历史的无损迁移。原生运行状态未知时，应先关闭其他客户端的同一会话。

## 2026-09-11 Codeg 协作流程修复

- Agents 与历史会话分栏，修复原生 @ 大菜单与协作菜单同时弹出；提示不可用主 Agent 的能力边界。
- 默认共享目录，使开发与审查读取同一份实际文件；保留显式隔离工作区。多任务等待在任一结果可收取时返回。
- 新增可更新的原生计划，子任务卡片投影真实会话 ID 与 Harness 名称，跟进复用原会话。
- 实测 Pi 主任务 + 两个独立 Pi 原生子会话：开发者写入错误样本 41 → 审查者 REVIEW_FAIL → message_agent 交回原开发者修为 42 → 原审查者 REVIEW_PASS → 主模型完成计划并汇总。测试验证文件实际导出值以及两个会话均收到跟进。日志：`output/collaboration-cycle.log`。
- Pi → Claude 写文件测试到达原生审批，未代答，跨 Harness 写文件闭环尚未通过；不能据此声称全部 Harness 组合已验收。

```powershell
npm run e2e:collaboration -- --lead=pi --worker=pi --cycle
```

桌面实测：Pi 主 Agent 切换、Agents/会话切页、Claude 提及精确插入（无重复 @）、图标标识、Antigravity 未支持主编排的提示和草稿清理通过。截图与报告在 `output/collaboration-ui/desktop-*.png` 和 `desktop-report.json`。专用子任务卡片的协议投影已验证；尚未完成真实桌面卡片点击跳转验收。
