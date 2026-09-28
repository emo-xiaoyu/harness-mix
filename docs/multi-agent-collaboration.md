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
5. 结果作为真正的原生工具结果返回主模型，由主模型验证、整合并继续执行。Host 额外投影原生 `collabAgentToolCall` 协作卡片（真实子任务 ID、Harness 名称、提示词、最终状态、Worktree 补丁与改动摘要），原生桌面渲染扩展支持点击直接跳转定位到子会话、内联展开语法高亮 Diff 查看改动、以及一键合并回主项目。「创建智能体」（spawnAgent）在子会话就绪后立即结算，执行期状态由独立的 sendInput 卡片承载，桌面不会在整个执行期间停留在「创建中」。同目录并发/Agent Team 场景下，各回合的文件审查卡片只展示可归因到本会话（及其协作子会话）的改动：其他会话 Harness 上报过路径的编辑会被正向剔除，不污染本回合的 Diff 与撤回列表。

`list_agents` 提供真实可用性。旧的手动 `/delegate` 入口已下线：单发委派统一走 `#` 选择器、协作工具（`delegate_to_agent`）或 CLI `delegate`。

Harness 自己创建的子代理不经过上述 Harness Mix 委派控制面。ZCode 通过原生 `session/subagents` 和 `session/messages` 获取真实子会话；Codex（协作）通过自己独立 app-server 的 `collabAgentToolCall.receiverThreadIds` 和 `thread/read` 获取子线程；OpenCode 通过 `session.created` 的 `parentID`、会话目录和 `/session/{id}/message` 获取子会话；Claude Code 通过官方 Agent SDK 的 `SubagentStart/Stop` 钩子获取 `agent_id`，再用 `getSubagentMessages` 读取原生 transcript。Pi/OMP 若装有 `pi-subagents` 扩展，则通过其 RPC `subagent-async` 状态 widget 和 `/subagents-inspect-rpc` 读取后台子代理记录；前台从 `subagent` 工具的结构化进度事件显示运行中入口，并在完成事件中补齐 transcript。OpenClaw 通过 Gateway 的 `tasks.list` 识别 `runtime: subagent` 的直接子任务，再读 `chat.history`（当前最多最近 200 条消息）；它再启动的 `runtime: acp` 外部任务不属于这个投影。DSH 普通 Web Remote 任务通过 `subagents/list` 的持久子会话目录、`session/follow` 快照及 `session/page` 历史页投影，协作 Lead 的 ACP 路径尚未获得同等子会话目录。Host 将这些原生记录投影成父任务中的协作卡片和可打开的只读子线程。默认官方 Codex 的 stock app-server 路径不参与此投影。Kiro、TraeCode CLI 尚未接入同等可靠的原生子会话记录读取；它们通过 Harness Mix 协作控制面创建的子代理仍按既有方式显示。不要从模型最终回复中的 agent ID 推测会话或伪造可点击入口。DSH 和 OpenClaw 的新增路径已有模拟协议测试，仍需真实子代理样本和重启后的 Desktop 交互验收。

### 其余原生子代理的映射调查（更新至 2026-09-28）

这里的“待接入”只表示 Harness Mix 尚未投影 Harness **自己创建**的子代理，不否认该 Harness 的子代理能力，也不等同于 Harness Mix 的 `delegate_to_agent`/Agent Team。进入 Codex 可点击只读线程至少需要原生子 ID、可验证的父子归属、可读取的子记录；状态不能仅由父代理最终回复推断。

| Harness | 已核实的原生线索 | 下一步与限制 |
| --- | --- | --- |
| Qoder | 本机 `~/.qoder/projects/<project>/<parent-session>/subagents/agent-*.jsonl` 实际样本含 `sessionId`、`agentId`、`isSidechain`、`parent_tool_use_id`；消息是 Claude 风格 `message.role/content`，末条 assistant 的 `stop_reason: end_turn` 可确认这份样本已结束 | 已按父 session 和 agent ID 接入只读 JSONL；仍需真实运行中与重启后的 Desktop 验收 |
| Cursor | 本机 `~/.cursor/projects/<project>/agent-transcripts/<parent-session>/subagents/<child>.jsonl` 实际样本含独立 user/assistant 消息；[官方子代理文档](https://cursor.com/docs/subagents)覆盖 CLI | 已按父目录映射子 ID；原生 JSONL 没有终态字段，当前在父回合正常结束时结束本轮发现的子记录，需真实 CLI 样本验证该边界 |
| Grok | [xAI 官方会话文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)说明父会话 `subagents/` 下有元数据，子会话在普通 sessions 树，`updates.jsonl` 是权威记录；[源码中的 `SubagentMeta`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/subagent/mod.rs)直接存 `parent_session_id`、`child_session_id`、`description`、`status`；父会话还有持久化的 `SubagentSpawned/Finished` 扩展通知 | 已按元数据和原生 updates 接入只读扫描；本机没有真实 spawn 样本，需确认运行中通知和 Desktop 展示 |
| Hermes | [原生源码](https://github.com/NousResearch/hermes-agent/blob/8863b36fd663c50d3b794c48a6505ff6c7c3c91b/tools/delegate_tool.py)为 child 建独立 session、`parent_session_id`、`_delegate_from` 与 transcript；[SessionDB](https://github.com/NousResearch/hermes-agent/blob/8863b36fd663c50d3b794c48a6505ff6c7c3c91b/hermes_state_messages.py)按消息 ID 读取 | 已通过 Node 原生 SQLite 以只读方式查询 `state.db`，只接受 `_delegate_from` 与父 ID 一致的子会话；合成 DB 测试通过，本机没有真实 child 样本 |
| Cline | [CLI ACP](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/cli/src/acp/acpAgent.ts)使用 `@cline/core`；[子会话持久化](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/session/team/team-child-session-manager.ts)写 `isSubagent`、`parentSessionId`、状态和 `messagesPath` | 已读取 `sessions.index.json`，仅接受父 ID 一致且 `sessionHistoryOrigin.mode=subagent` 的行，终态才导入完整消息快照；本机未装 CLI，需真实样本验收 |
| Kiro | [官方 ACP 文档](https://kiro.dev/docs/cli/acp/)记载 `~/.kiro/sessions/cli/<id>.json`/`.jsonl` 及子会话 `_session/terminate`；[官方子代理文档](https://kiro.dev/docs/custom-agents/subagents/)确认 CLI 子代理 | 有会话记录基础，但本机未装 Kiro CLI，尚未核实父子 ID 如何落盘或在 ACP 中发布，不能直接投影 |
| CodeBuddy | [官方 npm 发布包 v2.159.0](https://www.npmjs.com/package/@tencent-ai/codebuddy-code)自带子代理文档，明确写出 `~/.codebuddy/projects/<project>/<parentSessionId>/subagents/agent-{agentId}.jsonl`；类型声明中的 `SubagentLifecycleSnapshot` 含 child/parent ID、状态和工具调用 ID | 已按父会话目录和父 JSONL 的 cwd/session 身份接入只读子记录，显式生命周期可更新终态；本机没有真实 child 样本，需验证实际 JSONL 字段和 Desktop 点击 |
| Antigravity | CLI `step_type: subagent` 含 child `conversation_id`；[官方 CLI 更新记录](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)记载 `subagent_info` 的 `conversation_id`/`log_uri`；本机父会话 `.system_generated/subagents/<child>.json` 与子会话 `.system_generated/logs/transcript_full.jsonl` 能互相对应 | 已按原生父目录、child ID 和完整 JSONL 接入只读子线程；本机历史两条子记录分别映射 172 条消息；原生 ALIVE 仅表示会话存活，保守显示运行中，KILLED 显示失败；仍需新建真实子代理及重启后的 Desktop 点击验收 |
| TraeCode CLI | [官方文档](https://docs.trae.cn/cli_agent)确认能调用自定义智能体，[ACP 文档](https://docs.trae.cn/cli_acp)确认 `traecli acp serve`；`bytedance/trae-agent` 是另一个开源项目，不能拿它的存储格式代替 TraeCode CLI | 本机未配置 TraeCode CLI 可执行文件，尚无子 ID、父子关系和 transcript 样本；需先做真实 ACP/落盘探测 |

映射接入点已经存在：Adapter 发送 `native-subagent`（稳定原生子 ID、父任务、状态、消息），Host 在 `src/main/host/runtime.js` 创建 `nativeReadOnly` 子线程和父任务中的协作卡片。Qoder、Cursor、Cline 的只读文件读取器在 `src/main/adapters/native-file-subagents.js`，Grok 在 `grok-subagents.js`，Hermes 在 `hermes-subagents.js`，Antigravity 在 `antigravity-subagents.js`，CodeBuddy 在 `codebuddy-subagents.js`。它们在会话打开时扫描，运行中轮询，恢复时重放持久记录；只关联当前原生父 session，不完整 JSONL 行等待下次刷新，记录为空时不创建子线程。Cursor 的终态由父回合完成或失败推导，Cline 运行中仅显示稳定的任务输入，待终态才导入完整快照，避免重写文件造成重复或截断。Grok 的增量文本块保持独立消息行以维持 Host 的追加索引。Hermes 的只读 SQLite 依赖 Node 22.19+ `node:sqlite`，若不可用则跳过投影，不影响原生 Harness。CodeBuddy 若没有可验证的原生生命周期，会保守保持运行状态，不根据父回复猜测完成。`native-file-subagents-test.cjs` 验证父卡片链接及只读子线程，本机历史 Qoder/Cursor 样本也能经读取器映射出 36/4 条消息；所有新增路径尚未通过新建真实子代理和重启后 Desktop 点击验收。

后续接入需先补齐 Kiro 的子会话父子归属与真实样本，以及 TraeCode CLI 的子 ID、父子关系和完整 transcript 入口。所有桥只投影原生数据，子代理的模型、工具、权限及凭据继续由原 Harness 持有。

## CLI 前端（任意 Harness 当 Lead）

上述工具面之外，协作控制面还提供第二个前端：`src/main/host/collaboration-cli.cjs`。它和 MCP 桥（`collaboration-mcp.cjs`）一样，只是控制面 HTTP（loopback + 每线程 Bearer key）的客户端，因此**任何能执行 shell 命令的 Harness 都能当 Lead 与团队成员**——ZCode、grok、cursor、cline 等未接入 MCP 的 Harness 不再受「主代理协作工具」门槛限制。

- **发现**：CLI 按自身 cwd 查平台数据目录下的 `collab-registry/` 实例注册表（Windows `%APPDATA%\harnessmix\collab-registry`；`HARNESS_MIX_COLLAB_REGISTRY_DIR` / `HARNESSMIX_DATA_DIR` 可覆盖；Host 随控制面启停维护，崩溃残留 7 天清扫），目录内唯一 lead 会话自动选用，多候选需 `--thread <id>`；`HARNESS_MIX_COLLAB_URL/KEY` 环境变量优先。Lead 协调指令与团队信封都内嵌了带绝对路径与线程号的完整命令行，模型不需要自行发现。
- **命令面**：`whoami / agents / templates / delegate / status / followup / cancel / review / apply / resume / delegations / plan / team create|assign|state|update|message|script`，与 MCP 工具一一对应（`templates` → `list_team_templates` 按调用线程 cwd 合并 项目 > 用户 > 内置 模板；`run_team_script` 保持异步启动 + 完成唤醒一次的语义，CLI 同样不轮询）。长文本（任务、消息、描述、结果、脚本、计划、成员表）一律走 stdin，规避 Windows argv 引号与长度问题；`--format compact` 输出单行摘要。
- **退出码**：0 命令成功（不代表子任务成功）；1 服务端拒绝；2 发现失败（无注册/歧义/坏 key）；3 用法错误。错误统一 `{"error":{code,message}}` 进 stderr。
- **服务端强制不变**：白名单（仅本轮 `#` 显式选择的 Harness 可被委派）、Lead 回合存活检查、并发与每回合配额、隔离决策全部在控制面 `call()` 生效，CLI 不携带任何特权。
- **受管技能**：Host 启动时把 `harness-mix-collaboration`（CLI 用法指南）与 `agentteam`（Agent Team 组队向导，与 # 模板展开并行的对话式入口：whoami 自检 → templates 列模板 → 按用户点名授权组队）按版本 + digest 原子播种到 `~/.agents/skills/` 与 `~/.claude/skills/`；用户改过的副本视为 conflict，不覆盖不引用。
- **安全边界**：注册表含每线程 key，最坏暴露面是「冒充该 lead 线程调协作操作」，白名单与配额照常兜底。官方 Codex 线程不经 Host、不注入、不注册——CLI 是 Harness Mix 自有工具，任何会话主动运行它不构成官方线程被接管。设计全文见 [cli-collaboration-design.md](cli-collaboration-design.md)。

设计文档：[cli-collaboration-design.md](cli-collaboration-design.md)。

## Agent Team（不是并行 SubAgent）

Agent Team 复用同一套原生 Harness Session，但把 `Team`、`Member`、`Task`、`Message` 提升为 Host Runtime 的持久化一级对象：

1. Lead 调用 `create_agent_team` 创建团队、共同目标、具名成员与角色；成员必须来自用户本轮显式选择的 Harness。
2. `assign_team_task` 建立共享任务图，任务有固定 assignee 和 `depends_on` 依赖。依赖未完成时任务为 blocked，依赖完成后自动转为 pending。
3. Lead 使用带 `team_id` / `member_id` / `team_task_id` 的 `delegate_to_agent` 启动或复用该成员的原生 Session。Team member 是持续身份，不是完成即销毁的一次性 SubAgent。
4. Team member 可调用 `get_team_state`、`update_team_task` 和 `send_team_message`。成员只能更新分配给自己的任务；消息可定向或广播，先写入持久邮箱，目标成员空闲时会直接投递到其原生 Session。
5. Codex 对话顶部显示紧凑团队驾驶舱；点击「展开详情」后仍在原生内容流内展开 Team Workbench，不覆盖侧栏、对话或输入框。工作台用唯一 Lead 和最多六名成员的真实 Harness 图标呈现职责编队，每名成员拥有自己的职责、状态、任务列和进度，并显示团队通信与可回放事件时间轴。点击有原生 Session 的成员可直接进入其 Codex 子任务，点击「收起详情」或按 `Esc` 收起。
6. Workbench 通过 `harnessmix/thread/team/inspect` 直接查询 Host 持久化状态并实时刷新，不依赖工具卡片初次输出的旧快照；只有 Team Lead 和该团队成员线程可以读取。每次团队状态变化保留最近 200 个回放快照。
7. 「中断团队」与原生停止按钮按可恢复中断处理：级联取消成员回合后，Host 向每个在跑成员的原生会话发起一次**有界收尾握手**——成员以纯文本自述「已完成 / 进行中 / 阻塞 / 下一步」，交接落在作业、团队任务与 lead 邮箱（`kind=handoff`，以成员身份呈现），`member_handoff` 进入回放时间轴。「继续协作」的 Lead 指令与 `resume_delegation` 的恢复提示词都会携带这些交接（标注为成员自述、以文件系统为准）。握手默认上限 90 秒（`handshakeTimeoutMs` 可调）；成员不回复或会话已删则静默放弃，不改变中断语义。任务卡上的「取消」与宿主关机不握手：前者语义是放弃，后者必须立即退出。握手期间 `resume_delegation` 会提示稍候。

团队模板支持项目作用域：`<工作目录>/.harness-mix/teams/*.md`（Markdown + YAML frontmatter，声明 `name`、`description` 与 `members` 的 `name/role/agent`，成员必须显式指定 Harness，1-6 人）。解析顺序为**项目 > 用户 > 内置**——同名时文件版就近覆盖存储版，编成随仓库走、可进 PR 评审。文件按 mtime 即时热加载，坏文件跳过并记录告警，不影响其余模板与 # 菜单。会话内编曲器的 # 菜单按当前会话目录合并项目模板（条目标「项目」），设置 → 协作 仍管理用户与内置模板。协议面 `harnessmix/collaboration/team-template/list` 接受可选 `threadId` 以指定项目作用域。

除 # 菜单的模板展开外，受管技能 `agentteam` 提供第二条组队入口：lead 会话中对话式执行 `whoami` 自检 → `templates` 列模板（项目 > 用户 > 内置）→ 按用户点名授权后经 CLI `team create` 建队。两条入口汇合到同一控制面与同一套 Team/Member/Task 持久化；授权仍由白名单在服务端强制（本轮 # 选择或明确点名的 Harness），技能本身不携带授权，非 Harness Mix 会话中 CLI 发现失败（退出码 2）即礼貌终止。

设置 → 协作 的模板编辑器置于模板列表上方，可为每位成员选择 Harness、原生模型与该模型支持的思考强度。项目文件模板的成员也可写 `model`、`provider`、`thinking`；未填写时沿用原生默认。模板选择会把这些配置绑定到本轮创建的 Team，成员首次启动与后续恢复都使用该配置。Agent Team 的 Lead 和成员须使用对应 Harness 实际支持的免询问或完全访问模式；没有已验证模式的 Harness 会在团队创建前被拒绝。Pi 内置工具在 RPC 模式下默认直接执行，因此可作为团队成员；其 `no-approve` 只控制项目资源加载，不是 YOLO 开关。动态 ACP 模式在原生会话握手后确认，若目录没有完全访问档或应用失败则拒绝派发；原生策略或 Pi 扩展若仍发起审批，成员回合会停止并报告原因，不替用户回答审批。普通一次性协作委派同样要求免询问档位，无法满足时拒绝派发。

这与普通委派的区别是：普通委派仍是 Lead → worker → Lead；Agent Team 允许 teammate 围绕同一任务图直接交接、反馈和解锁依赖，同时每个 Harness 继续独立持有自己的模型、工具、权限、账户和原生历史。

编排脚本是 Agent Team 的执行驱动层：Lead 调用 `run_team_script(team_id, script)` 一次生成一段受限 DSL 脚本（`task({...})` 声明任务、`dependsOn` 传句柄排依赖、`Promise.all` 汇合并行、对 `.status`/`.result`/`.handoff` 分支、`phase("...")` 标记阶段），Host 编译进持久任务图后确定性执行，**执行期零模型调用**——脚本独立于 Lead 回合存活，完成或失败时以一次汇总回合唤醒 Lead。执行前四道验证门（解析带行号、成员静态绑定、任务数 ≤16、步数预算）在任何派发前拦截坏脚本；中断保留 journal，「继续协作」按 seq 重放：已结算任务零成本落定、绝不重派，中断任务采纳残留图任务并复用原会话与成员 handoff。driver 运行中该团队对直接 `delegate_to_agent` 独占。设计与三个核心决策见 [orchestration-script-design.md](orchestration-script-design.md)。

## 执行边界

- Git、Worktree 与最终 Diff 是 Host Workspace 统一能力，不依赖 Adapter 是否提供原生 Git/Diff。所有已注册 Harness 都声明 `workspace.git/worktree/finalDiff=true`；`nativeDiff/nativePatch` 仍按各原生协议诚实声明。显式 Worktree 创建失败时任务直接失败，绝不静默落回共享目录。每轮最终 Diff 由 Host 文件快照补齐原生事件遗漏；只有同目录并发时，才以原生 Patch 限定本轮文件归属。
- 一个 Agent Team 由一个 Lead 和最多六个具名成员组成；同一主任务最多六个同时运行的子任务，每轮最多创建十六个。普通子任务不注入协作工具。Agent Team member 只获得团队状态、任务更新和邮箱能力，仍不能创建团队、分配任务或递归委派。
- 模型工具委派默认共享主任务目录，子 Agent 使用独立原生会话。开发完成后再委派审查，审查意见通过 `message_agent` 发回原开发者，修复后复用原审查会话复审。主任务应等待依赖步骤完成并避免同时修改相同文件。主任务负责共享目录整体文件快照。显式 `isolation=worktree`（或 Git 项目中的 `auto`）仍创建隔离分支与工作区，保存主目录当前非忽略文件作为起点，保留用户暂存区；隔离改动不会自动出现在主目录。
- 协作不创建第二个应用或复制原生侧栏。Team Workbench 内嵌在当前 Codex Renderer 的会话内容区；父子关系仍通过原生 `parentThreadId` 投影，子任务仍进入 Codex 原生任务体系，审批与文件变化仍由对应 Harness 和原生 Changes 界面处理。
- 主任务可调用 `review_delegation_changes` 在原生工具卡片中审查 worktree patch。只有用户明确要求应用时才可调用 `apply_delegation_changes`，并必须提交刚审查得到的 digest。应用前检查 Git patch 冲突；冲突时结构化输出冲突文件清单及处置指引（工作区手动解决、推送到远程分支开 PR、或一键丢弃）。系统提供 `harnessmix/thread/workspace/discard` 一键安全清除 worktree 与删除临时分支，以及 `harnessmix/thread/workspace/push` 提交快照并直接推送到 Git 远程分支。worktree 默认保留供检查，不自动删除。隔离子任务有独立审查快照；共享子任务仍由主任务记录整体快照。
- 同目录的无关任务仍受原有执行互斥约束。父任务结束/取消、Host 关闭会取消尚未完成的子任务；30 分钟未完成的子任务会超时。
- 协作 HTTP 桥仅绑定 loopback，以每个主任务的随机本地能力标识鉴权；工具参数校验，子任务归属检查，外部 Origin 拒绝。该标识不是模型账户令牌。Host 不读取或代理原生账户密钥。
- Claude 的 `canUseTool` 和 Codex MCP elicitation 继续走原生审批。需要确认时，用户在相应任务的审批界面处理；自动验证不会代答。
- 主任务 Fork 会重新绑定自己的协作身份，不复用源任务的子任务访问权。
- task_id、父子会话、任务文本、结果、worktree 起点以及 Team/Member/Task/Message 在独立串行存储中持久化；重启后在途 Job、Team Task 和 Member 一起变为 interrupted，不会继续显示为“工作中”，也不自动重复执行有副作用的操作。点击「继续协作」向原主任务发送续跑请求，主模型用 `list_delegations` / `resume_delegation` 恢复原子会话，并把同一 Team Task/Member 原子地切回进行中。原生会话丢失或无法恢复会明确报错。会话鉴权标识不持久化，重启重新签发。
- 团队看板是可操作的（principal 是用户，授权在 Host 的 `collaboration.userAction` 统一裁决）：任务卡可「取消」进行中任务、「重试/改派」失败或中断任务；成员卡可「追问」以 lead 身份发团队消息。Workbench 头部可「中断团队」并保留可恢复的委派，或「新增任务」直接向持久任务图加入标题、描述、既有成员及已有任务依赖。原生停止按钮也按可恢复中断处理。「继续协作」会让空闲 Lead 检查中断委派和待派发任务，并通过原生协作工具恢复或派发；已完成的操作需先检查，不能重复执行。协议面为 `harnessmix/thread/team/interrupt`、`team/task/insert`、`team/task/cancel`、`team/task/reassign`、`team/message/send`、`harnessmix/thread/collaboration/continue`。
- 任务失败必达 lead 邮箱：失败结算时以 `system` 伪参与者（不进 roster、不投递）写入一条带原因的通知，lead 无需轮询也能从 `get_team_state` 看到失败。`assign_team_task` 可声明 `retry {max 1..3}`：失败时 Host 在同一 lead 回合内自动重派给原成员（复用其会话与工作区，提示词附上次失败原因与“不要重放已完成副作用”），预算耗尽才落 failed；未声明则失败即落定。用户主动取消不是失败：不通知、不重试。

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
| 其他 Harness 主任务 | Agents 页明确提示需要切换可编排的主 Agent，目标不可选；历史引用仍可用；可经 CLI（`harness-mix-collaboration` 技能指引）担任 Lead 与团队成员 |
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

`test:collaboration` 使用真实 MCP stdio 子进程、本地鉴权桥和受控原生会话 Adapter 验证并发、结果、跟进、取消、跨任务访问限制、Agent Team 身份/任务依赖/成员邮箱、时间轴持久化和共享快照策略，并覆盖看板用户操作（取消/改派/重试/追问/继续协作，含 lead 回合空闲约束与协议透传）、任务失败的 lead 邮箱 system 通知与 `retry` 自动重派、忙碌收件人排队投递与未读计数清零、中断收尾握手（交接三处落档、继续协作/恢复提示词携带交接、任务卡取消不握手、超时静默放弃），以及编排脚本（验证门含静态作用域检查的六类结构化错误、Lead 回合结束后独立存活、执行期零模型调用断言、结果驱动分支、中断→握手→继续协作 journal 重放不重派已完成任务并复用原会话、driver 独占、运行时错误结构化失败唤醒）。`team-template-test` 覆盖模板 CRUD/内置墓碑/# 提及展开与项目作用域文件模板（`.harness-mix/teams/*.md` 的解析边界、同名优先级、热加载、坏文件容错与协议 threadId 合并）；`test:collaboration-recovery` 覆盖 driver 重启语义（running → interrupted、journal 保留、游标重置）。UI 冒烟断言 Workbench 编排阶段条（状态/阶段/脚本任务进度）与紧凑面板的编排阶段标记。`test:collaboration` 与 `test:collaboration-recovery` 已并入 `test:core-all`。UI smoke 检查摘要入口、内嵌工作台、Lead/成员职责、真实 Harness 图标、成员会话跳转、成员任务列、通信流、时间轴、看板操作按钮（失败/中断任务的重试/改派/恢复、进行中任务的取消）、lead 忙碌时「继续协作」的禁用态与成员未读徽标，截图位于 `output/collaboration-ui/team-inline-expanded.png`。这不是完整 Codex Desktop 的真实模型交互验收；构建过程不会重启当前桌面。

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
