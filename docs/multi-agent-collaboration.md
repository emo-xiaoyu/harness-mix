# 多 Agent 协作

## 用法

重新启动 Harness Mix 后，新建或恢复一个 Pi / Oh My Pi / Claude Code / **Codex（协作）** / Grok / OpenCode / **Antigravity** 任务，在原生输入框中输入 `#`，在 **Agents** 页选择目标 Harness；**会话** 页单独提供历史引用。已选 Agent 以内联标签显示在输入框顶部，可点击或在光标位于正文开头时按 Backspace 移除。左右键切换分页，上下键选择，Enter/Tab 插入，Escape 关闭。`@` 保留给 Codex 原生功能，不会调出 Harness Mix 协作选择器。Codex（协作）通过 Host Adapter 使用原生 app-server；原来的 Codex 入口仍为官方直通。可用目标来自 Host 注册的 Adapter；未就绪的目标不可选。示例：

```text
你负责实现后端。
#claude-code 审查 API 设计，只读，不修改文件。
#pi 为 tests/ 编写测试，不修改 src/。
收齐结果后由你运行验证并总结。
```

也可直接输入 `#pi`、`#claude`、`#dsh`、`#codex` 等已注册 ID/别名。显式 `[名称](harness-mix://agent/pi)` 引用可随草稿复制；代码块和行内代码中的 `#` 不作为路由元数据。纯文本请求也可在“团队、组队、协作、委派、调度、分工、成员”等明确协作语境中，通过完整 Harness 名称授权，例如“用 Pi 开发、Claude 审查组成 Agent Team”。普通提及“Codex UI”不会启动协作。选择本身由主模型结合用户任务理解，Host 不按文字片段盲目拆任务。

## 执行方式

协作面由委派工具与 Agent 引用路由两部分组成，按以下方式接入：

1. Host 为主任务提供会话绑定的协作工具。Claude 通过 SDK 的 MCP 配置，Codex Adapter 通过 app-server 的线程 MCP 配置，Pi/OMP 通过原生扩展加载，Grok 通过原生 `session/new` 的 `mcpServers` 槽注入（L1），OpenCode 通过 `OPENCODE_CONFIG_CONTENT` 内联配置注入 `mcp["harness-mix"]`（V2 schema，运行时最高优先级、不写任何用户配置文件），DSH 协作主任务通过官方 `dsh --profile acp` 的 session-scoped MCP 注入，Antigravity 协作主任务通过 bridge 目录自动生成的 `.agents/plugins/harness-mix` plugin 及 loopback MCP 配置注入与引导词；DSH 普通任务仍走 Web Remote。
2. 主模型调用 `delegate_to_agent(agent_type, task)`，立即取得 `task_id`，可以继续发起其他任务。
3. Host 创建带 `parentThreadId` 的独立原生会话。任务中需要的上下文由主模型明确传递，不复制其他 Harness 的隐藏状态、账户或权限。
4. `update_agent_plan(steps)` 发布开发、审查、返工和最终验收计划；步骤状态为 pending / in_progress / completed。`get_delegation_status(task_ids, wait_ms)` 收取状态和最终文本；单次等待不超过 60 秒。`message_agent` 在已结束的子会话中继续对话，`cancel_delegation` 取消子任务。
5. 结果作为真正的原生工具结果返回主模型，由主模型验证、整合并继续执行。Host 额外投影原生 `collabAgentToolCall` 协作卡片（真实子任务 ID、Harness 名称、提示词、最终状态、Worktree 补丁与改动摘要），原生桌面渲染扩展支持点击直接跳转定位到子会话、内联展开语法高亮 Diff 查看改动、以及一键合并回主项目。

`list_agents` 提供真实可用性。旧 `/delegate` 仍是独立的手动委派入口，其完成结果只回投父任务工具卡片，不自动调用父模型。

## Agent Team（不是并行 SubAgent）

Agent Team 复用同一套原生 Harness Session，但把 `Team`、`Member`、`Task`、`Message` 提升为 Host Runtime 的持久化一级对象：

1. Lead 调用 `create_agent_team` 创建团队、共同目标、具名成员与角色；成员必须来自用户本轮显式选择的 Harness。
2. `assign_team_task` 建立共享任务图，任务有固定 assignee 和 `depends_on` 依赖。依赖未完成时任务为 blocked，依赖完成后自动转为 pending。
3. Lead 使用带 `team_id` / `member_id` / `team_task_id` 的 `delegate_to_agent` 启动或复用该成员的原生 Session。Team member 是持续身份，不是完成即销毁的一次性 SubAgent。
4. Team member 可调用 `get_team_state`、`update_team_task` 和 `send_team_message`。成员只能更新分配给自己的任务；消息可定向或广播，先写入持久邮箱，目标成员空闲时会直接投递到其原生 Session。
5. Codex 对话顶部显示紧凑团队驾驶舱；点击「展开详情」后仍在原生内容流内展开 Team Workbench，不覆盖侧栏、对话或输入框。工作台用唯一 Lead 和最多六名成员的真实 Harness 图标呈现职责编队，每名成员拥有自己的职责、状态、任务列和进度，并显示团队通信与可回放事件时间轴。点击有原生 Session 的成员可直接进入其 Codex 子任务，点击「收起详情」或按 `Esc` 收起。
6. Workbench 通过 `harnessmix/thread/team/inspect` 直接查询 Host 持久化状态并实时刷新，不依赖工具卡片初次输出的旧快照；只有 Team Lead 和该团队成员线程可以读取。每次团队状态变化保留最近 200 个回放快照。

这与普通委派的区别是：普通委派仍是 Lead → worker → Lead；Agent Team 允许 teammate 围绕同一任务图直接交接、反馈和解锁依赖，同时每个 Harness 继续独立持有自己的模型、工具、权限、账户和原生历史。

## 执行边界

- Git、Worktree 与最终 Diff 是 Host Workspace 统一能力，不依赖 Adapter 是否提供原生 Git/Diff。所有已注册 Harness 都声明 `workspace.git/worktree/finalDiff=true`；`nativeDiff/nativePatch` 仍按各原生协议诚实声明。显式 Worktree 创建失败时任务直接失败，绝不静默落回共享目录。每轮最终 Diff 由 Host 文件快照补齐原生事件遗漏；只有同目录并发时，才以原生 Patch 限定本轮文件归属。
- 一个 Agent Team 由一个 Lead 和最多六个具名成员组成；同一主任务最多六个同时运行的子任务，每轮最多创建十六个。普通子任务不注入协作工具。Agent Team member 只获得团队状态、任务更新和邮箱能力，仍不能创建团队、分配任务或递归委派。
- 模型工具委派默认共享主任务目录，子 Agent 使用独立原生会话。开发完成后再委派审查，审查意见通过 `message_agent` 发回原开发者，修复后复用原审查会话复审。主任务应等待依赖步骤完成并避免同时修改相同文件。主任务负责共享目录整体文件快照。显式 `isolation=worktree`（或 Git 项目中的 `auto`）仍创建隔离分支与工作区，保存主目录当前非忽略文件作为起点，保留用户暂存区；隔离改动不会自动出现在主目录。
- 协作不创建第二个应用或复制原生侧栏。Team Workbench 内嵌在当前 Codex Renderer 的会话内容区；父子关系仍通过原生 `parentThreadId` 投影，子任务仍进入 Codex 原生任务体系，审批与文件变化仍由对应 Harness 和原生 Changes 界面处理。
- 主任务可调用 `review_delegation_changes` 在原生工具卡片中审查 worktree patch。只有用户明确要求应用时才可调用 `apply_delegation_changes`，并必须提交刚审查得到的 digest。应用前检查 Git patch 冲突；冲突时结构化输出冲突文件清单及处置指引（工作区手动解决、推送到远程分支开 PR、或一键丢弃）。系统提供 `harnessmix/thread/workspace/discard` 一键安全清除 worktree 与删除临时分支，以及 `harnessmix/thread/workspace/push` 提交快照并直接推送到 Git 远程分支。worktree 默认保留供检查，不自动删除。隔离子任务有独立审查快照；共享子任务仍由主任务记录整体快照。旧 `/delegate` 手动入口仍为共享目录。
- 同目录的无关任务仍受原有执行互斥约束。父任务结束/取消、Host 关闭会取消尚未完成的子任务；30 分钟未完成的子任务会超时。
- 协作 HTTP 桥仅绑定 loopback，以每个主任务的随机本地能力标识鉴权；工具参数校验，子任务归属检查，外部 Origin 拒绝。该标识不是模型账户令牌。Host 不读取或代理原生账户密钥。
- Claude 的 `canUseTool` 和 Codex MCP elicitation 继续走原生审批。需要确认时，用户在相应任务的审批界面处理；自动验证不会代答。
- 主任务 Fork 会重新绑定自己的协作身份，不复用源任务的子任务访问权。
- task_id、父子会话、任务文本、结果、worktree 起点以及 Team/Member/Task/Message 在独立串行存储中持久化；重启后在途 Job、Team Task 和 Member 一起变为 interrupted，不会继续显示为“工作中”，也不自动重复执行有副作用的操作。点击「继续协作」向原主任务发送续跑请求，主模型用 `list_delegations` / `resume_delegation` 恢复原子会话，并把同一 Team Task/Member 原子地切回进行中。原生会话丢失或无法恢复会明确报错。会话鉴权标识不持久化，重启重新签发。

## 支持与验证范围

| 入口 | 状态 |
| --- | --- |
| Pi 主任务 | 原生扩展工具；Pi→Pi、Pi→Claude 两条真实模型链路通过 |
| Claude Code 主任务 | SDK MCP 注入；本机真实运行触发原生工具审批，未代答，尚未完成模型闭环验收 |
| Oh My Pi 主任务 | 同 Pi 家族的扩展接线；本机未安装 OMP，真实验收未完成 |
| Codex（协作）主任务 | 已接入选择器、模型/强度、恢复归属、# 菜单；桌面使用配套 CLI。真实请求已到原生 MCP 审批，尚未完成需授权的闭环 |
| Grok 主任务 | L1：`session/new`/`session/load` 原生 `mcpServers` 槽注入，恢复会话同样携带；真实模型闭环验收待跑 |
| OpenCode 主任务 | L2：`OPENCODE_CONFIG_CONTENT` 使用 `mcp["harness-mix"]`（V2 schema），会话结束即失效；本机真实请求已到官方 API，但被账户余额阻断 |
| DSH 主任务 | 官方 `dsh --profile acp` 接收 session-scoped `harness-mix` MCP；DSH→CodeBuddy 两个 worktree 子任务和最终 `COLLAB_VERIFIED` 已通过真实模型回路。普通 DSH 任务继续使用 Web Remote |
| Antigravity 主任务 | 支持主编排（通过 `.agents/plugins/harness-mix` MCP 自动挂载及指导词注入）；已接入协同工具与卡片投影 |
| 官方 Codex 桌面直通任务 | 保持官方直通，不展示 Host 的 # 协作菜单；不要把 Adapter 接线等同于已支持这个入口 |
| 其他 Harness 主任务 | Agents 页明确提示需要切换可编排的主 Agent，目标不可选；历史引用仍可用；可使用旧 /delegate |
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

`test:collaboration` 使用真实 MCP stdio 子进程、本地鉴权桥和受控原生会话 Adapter 验证并发、结果、跟进、取消、跨任务访问限制、Agent Team 身份/任务依赖/成员邮箱、时间轴持久化和共享快照策略。UI smoke 检查摘要入口、内嵌工作台、Lead/成员职责、真实 Harness 图标、成员会话跳转、成员任务列、通信流和时间轴，截图位于 `output/collaboration-ui/team-inline-expanded.png`。这不是完整 Codex Desktop 的真实模型交互验收；构建过程不会重启当前桌面。

2026-09-12 验证：Pi→Claude 两个真实子任务分别在不同 worktree 运行，DSH→CodeBuddy 两个真实子任务也在独立 worktree 完成并由 DSH 主会话汇总 `COLLAB_VERIFIED`。恢复测试覆盖持久化身份、原子会话续跑、不重复建任务；Git 测试覆盖脏目录起点、暂存区保留、过期预览拒绝、冲突时不部分应用。Native Protocol 覆盖父子任务归属与原生 MCP 工具卡片，Electron 仅覆盖原生输入框中的协作引用增强。Runtime 保持 Adapter `open()` 返回对象的同一身份，避免原生回调更新到浅拷贝而被活动回合闸门丢弃。
## 统一历史

设置 → 会话导入 → 全部历史，支持按标题、目录和会话 ID 搜索、分页、导入并打开。Pi、Claude、Codex 从本机原生历史发现会话；其余 Harness 当前聚合 Host 已管理的历史，并在来源名称上标为「Host 历史」，尚未接入各自 CLI 的外部会话扫描。

导入只创建投影和原生会话引用，不启动模型；再次发送时原生恢复。重复导入返回同一任务。输入 `#` 可从「会话」页选择一条记录；Host 最多读取三条引用，每条只附加最近十二条用户/助手文本，并明确标记为不可执行的历史数据。引用不会创建、恢复或占用原生会话。原始完整工具、隐藏状态和分支数据仍留在原生存储，因此这不是原生历史的无损迁移。原生运行状态未知时，应先关闭其他客户端的同一会话。

## 2026-09-11 协作流程修复

- Agents 与历史会话分栏，使用 `#` 调出协作菜单，`@` 保留给原生功能；提示不可用主 Agent 的能力边界。
- 默认共享目录，使开发与审查读取同一份实际文件；保留显式隔离工作区。多任务等待在任一结果可收取时返回。
- 新增可更新的原生计划，子任务卡片投影真实会话 ID 与 Harness 名称，跟进复用原会话。
- 实测 Pi 主任务 + 两个独立 Pi 原生子会话：开发者写入错误样本 41 → 审查者 REVIEW_FAIL → message_agent 交回原开发者修为 42 → 原审查者 REVIEW_PASS → 主模型完成计划并汇总。测试验证文件实际导出值以及两个会话均收到跟进。日志：`output/collaboration-cycle.log`。
- Pi → Claude 写文件测试到达原生审批，未代答，跨 Harness 写文件闭环尚未通过；不能据此声称全部 Harness 组合已验收。

```powershell
npm run e2e:collaboration -- --lead=pi --worker=pi --cycle
```

桌面实测与隔离增强：Pi 主 Agent 切换、Agents/会话切页、Claude 选择精确插入、图标标识和草稿清理通过。原生协作卡片已实装「↗ 查看 Agent 会话」跳转子任务 Thread、「🔍 查看产物 Diff」语法高亮展开与「✓ 合并改动到主项目」操作；Worktree 隔离环境已实装补丁冲突结构化指引、`discardWorkspace` 一键丢弃临时分支与 `pushWorkspace` 远程分支推送协议支持。截图与报告在 `output/collaboration-ui/desktop-*.png` 和 `desktop-report.json`。
