# CLI 协作前端设计（Collaboration CLI Frontend）

状态：已实施（见 §10 实施记录）。本文档是唯一实现依据；实现与本文冲突时先改文档再改代码。

## 1. 背景与目标

当前多 Agent 协作（`src/main/host/collaboration.js`）只有一种前端：宿主注入的 MCP 工具桥
（`collaboration-mcp.cjs`，仅 42 行，是控制面 HTTP 的 stdio 客户端）。MCP 注入依赖适配器的
`capabilities.collaborationTools`，导致 ZCode、grok、cursor、cline、trae、qoder 等 harness
只能当被派活的 worker，不能当 lead（`runtime.js` 在 `#send` 里直接报错拦截）。

本设计新增第二种前端：**`harness-mix` CLI**——同一个控制面 HTTP API 的命令行客户端。
lead 模型在会话内跑 shell 命令即可完成全部协作操作。

### 目标

1. 任何能执行 shell 命令的 harness 都能当 lead（含 Agent Team 全部管理操作）。
2. Agent Team 成员资格不再要求 `collaborationTools`：非 MCP 成员通过 CLI 参与邮箱协作。
3. `run_team_script` 保持"异步启动 + 完成后唤醒一次"语义，CLI 与 MCP 等价，无轮询降级。
4. 核心状态机（任务图、邮箱、worktree、审查门、白名单强制）**零改动**；CLI 只复用
   `Collaboration.call()` 分发路径，服务端强制（activeMentions 白名单、turn 存活检查、
   配额、隔离决策）自动继承。
5. 人类与 CI 可直接用 CLI 驱动协作（`/delegate` 之外的全能力通道）。

### 非目标（明确出范围）

- **递归委派**：worker/子任务继续禁止再委派（`call()` 已有 `parent.parentThreadId` 拒绝 +
  `delegateTask` 的"协作子任务暂不支持继续委派"），本轮不改语义。受限 worker key 是未来策略开关。
- **官方 Codex 线程**：不注入、不发现、不路由。见 §8 安全边界。
- **替换 MCP 前端**：MCP 桥保持现状，双前端长期共存、同步演进。
- **harness 进程 env 注入**：本轮不做适配器级 `HARNESS_MIX_*` env 推广（`thread.environment`
  通道仅 native-acp/zcode 已支持）。发现走注册文件 + 指令内嵌 thread id，env 是未来优化。

## 2. 架构总览

```
lead 模型（任意 harness）
 ├─ MCP 路径:  tools/call ──► collaboration-mcp.cjs (stdio) ─┐
 └─ CLI 路径:  shell ──► collaboration-cli.cjs ──────────────┤
                                                             ▼
                        控制面: http://127.0.0.1:<随机端口>/  (collaboration.js:650)
                        Bearer <per-thread key> → Collaboration.call(owner, name, args)
                                                             ▼
                        核心状态机（本设计零改动）
```

关键事实（已核实）：
- 控制面已存在：单端点 `POST /`，Bearer key 反查 owner 线程，body `{name, arguments}`
  上限 64000 字节，拒绝带 `Origin` 头的请求（CSRF 防护，node fetch 不发 Origin，CLI 天然通过）。
- key 按线程随机（`this.keys`，Host 每次运行重新生成）。
- `call()` 前置：协作偏好开启、zod 参数校验、团队工具要求 `execution.isRunning(principal)`
  （lead turn 存活——CLI 在模型 turn 内执行 shell，天然满足）、`Only lead tasks can delegate`。
- `startTeamScript` 异步启动、立即返回 `script_id`，完成时宿主唤醒 lead 一次——CLI 直接等价。

## 3. 控制面扩展（唯一的宿主侧新端点语义）

### 3.1 `session_info` 操作

新增工具名 `session_info`（进 `collaboration-tools.js`，MCP `tools/list` 同步可见，无害）：
入参空，返回：

```json
{ "threadId": "...", "title": "...", "harnessId": "zcode", "cwd": "...",
  "role": "lead" | "worker" | "team-participant", "frontend": "cli" | "mcp",
  "team": { "id": "...", "name": "..." } | null,
  "activeMentions": ["worker"], "collaborationEnabled": false, "agentTeamEnabled": true }
```

实现位置：`call()` 在 turn 存活检查**之前**分发（whoami 类操作任意时刻可用）。
`role` 判定：`thread.parentThreadId == null` → lead；否则 worker；团队参与者的 team 字段
由 `isTeamParticipantThread` 补充。

### 3.2 发现注册表（cwd registry）

**位置**：与 runtime 数据目录同级的 `collab-registry/`（生产 = 平台数据目录，如 Windows `%APPDATA%\harnessmix\collab-registry`；可用 `HARNESS_MIX_COLLAB_REGISTRY_DIR` 或 `HARNESSMIX_DATA_DIR` 覆盖，CLI 与 Host 按同一规则计算）：
`instance-<random>.json`，内容：

```json
{ "pid": 1234, "startedAt": 1760000000000,
  "url": "http://127.0.0.1:54321",
  "cwds": { "<规范化cwd小写>": { "<threadId>": {
      "key": "<per-thread key>", "title": "...", "harnessId": "zcode",
      "kind": "lead" | "worker", "updatedAt": 1760000000000 } } } }
```

**生命周期**（全部在 `Collaboration` 内，新文件 `collab-registry.js`）：
- 服务启动（`connection()` 首次触发 `initialize`）时创建实例文件；Host 退出（`close()`）时删除。
- key 签发/线程创建/线程删除/线程 cwd 变化时增删对应条目并原子重写。
- 只登记**协作候选线程**：无 `parentThreadId` 的 lead 线程（kind=lead）与协作子任务线程
  （kind=worker，供诊断）。登记条件：协作偏好开启。
- Host 启动时清扫：删除 `startedAt` 早于 7 天的遗留实例文件（崩溃残留）。
- 写入失败静默降级（注册表是 best-effort 发现通道，不阻塞协作）。

**CLI 解析规则**：按自身 cwd（`--cwd` 可覆盖）匹配 `cwds` 键；
1. 环境变量 `HARNESS_MIX_COLLAB_URL` + `HARNESS_MIX_COLLAB_KEY`（现有桥同名变量）优先；
2. `--thread <id>` 精确取条目；
3. 唯一 `kind=lead` 条目 → 自动选用；
4. 多个 lead 条目 → 报错并列出候选（附 `--thread` 用法），退出码 2；
5. 无匹配 → 报错，提示让用户在 Harness Mix 会话内触发协作后重试，退出码 2。

## 4. CLI 规范

**文件**：`src/main/host/collaboration-cli.cjs`（CommonJS，可 `require` 供测试，`require.main`
分支跑 main）。无外部依赖（全局 `fetch`，Node ≥ 18）。

**调用形态**：`node <abs>/collaboration-cli.cjs [全局选项] <命令> ...`
注入给模型的指令永远带绝对路径与 `--thread <id>`，不依赖 PATH。

### 4.1 命令树（全部映射到既有 `call()` 操作名）

| CLI | 操作 | 说明 |
|---|---|---|
| `agents` | list_agents | |
| `whoami` | session_info | 新增操作，见 §3.1 |
| `delegate <agent> [task...]` | delegate_to_agent | task 缺省或为 `-` 时读 stdin；`--isolation auto\|worktree\|shared`；团队模式 `--team <id> --member <id> --task-id <tid>` |
| `delegations` | list_delegations | |
| `status <task_id>...` | get_delegation_status | `--wait-ms <n>`（≤60000，默认 0） |
| `followup <task_id> [msg...]` | message_agent | msg 缺省或 `-` 读 stdin |
| `cancel <task_id>` | cancel_delegation | |
| `review <task_id>` | review_delegation_changes | |
| `apply <task_id> --digest <d>` | apply_delegation_changes | |
| `resume <task_id>` | resume_delegation | |
| `plan [file\|-]` | update_agent_plan | stdin/文件给 JSON 数组 `[{text,status}]` |
| `team create --name --goal [--members file\|-]` | create_agent_team | members JSON：`[{name,role,agent_type}]` |
| `team assign <team> --title --desc - --assignee [--depends-on a,b] [--retry n]` | assign_team_task | `--desc -` 读 stdin |
| `team state <team>` | get_team_state | |
| `team update <team> <task> --status <s> [--result -]` | update_team_task | |
| `team message <team> --to <to> [--kind k] [--task <tid>] [msg...]` | send_team_message | msg 缺省读 stdin |
| `team script <team> [--script file\|-]` | run_team_script | 异步：返回 `script_id` + running，宿主完成时唤醒，**不得轮询** |

### 4.2 全局选项与约定

- `--format json\|compact`（默认 json）。compact：每条目一行
  `[task <id 前 8>] <status> <agent> — <result 摘要 80 字>`；review 输出 digest 突出显示；
  错误单行 `ERROR <code>: <message>`。
- `--thread <id>`、`--url <u>`、`--key <k>`、`--cwd <path>`、`--timeout-ms <n>`（HTTP 超时，
  默认 70000，与 MCP 桥一致）。
- **长文本一律支持 stdin**（`-` 或缺省），彻底规避 Windows argv 引号/长度坑；argv 里的短文本
  仍直接可用。
- 退出码：0 成功（仅表示命令成功，不代表子任务成功）；1 服务端拒绝（错误 JSON 进 stderr）；
  2 发现失败（无注册/歧义/无 key）；3 用法错误。
- 错误输出统一 `{"error": {"code": "...", "message": "..."}}`；服务端 400 body 原样透传。

## 5. Lead 门槛与前端感知注入

### 5.1 `runtime.js#send` 门槛切换

现状 `runtime.js:418`：`mentions && !collaborationOf && !parentThreadId && !session.collaborationEnabled`
→ 抛错。**改为不抛错**（协作偏好关闭时维持现有静默路径），`activeMentions` 照常登记。

现状 `runtime.js:450` 注入条件 `session.collaborationEnabled && !thread.parentThreadId`
→ 改为 `!thread.parentThreadId && (session.collaborationEnabled || 协作偏好开启)`，
内部按 `session.collaborationEnabled` 二选一措辞：

- **MCP 措辞**：现有文本不动（硬编码工具名的段落保持）。
- **CLI 措辞**（新函数 `cliLeadInstruction(threadId)`，放 collaboration.js 导出）：
  `[Harness Mix collaboration] You are the lead coordinator. ... You do NOT have
  collaboration MCP tools; drive collaboration by running the Harness Mix CLI:
  node "<cliAbsPath>" --thread <threadId> <command> — start with
  node "<cliAbsPath>" --thread <threadId> --help ...` 附：白名单约束句（沿用 CRITICAL CONSTRAINT）、
  stdin 约定、"collect results with status before finishing"、worktree/review/apply 提示、
  团队模式说明、并发警告与中断恢复段落（与 MCP 措辞共享尾部拼接）。

### 5.2 团队成员 CLI 化

- `create_agent_team`（collaboration.js:688）删除 `collaborationTools` 强制——所有可用
  harness 均可入队。
- `teamEnvelope()` 增加 `childThreadId` 参数并按子会话 `rt.sessions.get(childId)?.collaborationEnabled`
  选择 MCP/CLI 措辞（CLI 措辞内嵌 `--thread <childId>`）。**组装时机移入 `run()` 子线程
  创建之后**（当前在 1030 行先组信封后建线程，拿不到 childId）。
- `messageEnvelope()`（759）同样双措辞：直投非 MCP 成员时给 CLI 指令（内嵌该成员 childId）。
- `dispatch()` 注入文本（865 续跑、922 改派、1678 唤醒汇总）：硬编码工具名改为前端中性
  表述——"调用 delegate_to_agent（或等价 CLI：`node "<cli>" --thread <id> delegate ...`）"，
  用小助手 `frontendHint(threadId)` 生成。

## 6. Skill 播种

新文件 `collaboration-skill.js`（仿 codex-host `delegation-skill.ts` 模式）：

- 技能名 `harness-mix-collaboration`，内容为 CLI 用法指南（命令速查、stdin 约定、
  "以 `--help` 为权威"、结果收集与审查流程、团队成员回信方式）。
- 内联常量 + `SKILL_VERSION`（起步 1）+ 当前 SHA-256 + 历史受管 digest 列表。
- 原子写入 `~/.agents/skills/harness-mix-collaboration/SKILL.md` 与
  `~/.claude/skills/.../SKILL.md` 两处；用户改过（digest 不在受管表）→ conflict，不覆盖不引用。
- Host `initialize()` 时播种；结果记入健康日志。

## 7. 测试计划（分层，全部挂入 `test:core-all`）

| 脚本 | 覆盖 |
|---|---|
| `collaboration-cli-test.cjs`（新） | 起 HostRuntime + 假适配器 + 真控制面：whoami/delegate(stdin)/status/wait/compact/review+apply 摘要/退出码矩阵/坏 key 403/歧义 cwd 报错/注册表发现（含 worker 条目）/JSON 错误透传/team 全命令/script 异步返回 |
| `collaboration-skill-test.cjs`（新） | installed→current→updated→conflict 四态、双目的地一致、digest 稳定、原子性（无残留 tmp） |
| `collaboration-test.cjs`（扩展） | session_info（turn 外可用）；非 MCP lead 不再抛错且收到 CLI 措辞；MCP lead 措辞不变（回归锚点）；成员信封双措辞；dispatch 文本前端中性 |
| 回归 | `npm run check` + `test:core-all` 全链 + `test:collaboration`、`delegation-await-test`、`team-mailbox-test` 不回归 |

## 8. 安全边界（必须写入 AGENTS.md 的声明）

1. **凭据暴露面**：注册表含 per-thread key，落平台数据目录（用户级权限）。同 cwd 的任意
   进程（含官方 Codex 会话里被诱导执行的命令）**技术上能读到的最坏后果** = 冒充该 lead 线程
   调协作操作；`call()` 的白名单（activeMentions）、turn 存活检查、配额与隔离决策照常生效。
   key 不落日志、不进 argv。
2. **官方 Codex 红线不变**：官方 Codex 线程不经 Host、不被注入 env、不写注册表条目。
   CLI 是 Harness Mix 自有工具；任何会话**主动**运行它只构成"以某 harness-mix 线程身份的
   工具调用"，不构成官方线程执行被 Harness Mix 接管。禁止在官方 Codex 路径上宣传或注入
   该 CLI。
3. 注册表仅 loopback URL；控制面维持"拒绝 Origin、64KB 上限、Bearer 反查"三重既有防线。

## 9. 实施顺序（每步后跑 check + 相关测试）

1. `session_info` + 注册表（collab-registry.js）+ 测试锚点。
2. `collaboration-cli.cjs` 全命令 + `collaboration-cli-test.cjs`。
3. Lead 门槛/双措辞注入 + 成员信封/dispatch 改造 + collaboration-test 扩展。
4. Skill 播种 + 测试。
5. 文档：本文件定稿标记、docs/multi-agent-collaboration.md 增 CLI 章、README、AGENTS.md §8 声明。
6. 全量回归：`npm run check && npm run test:core-all`。

## 10. 实施记录（2026-09-25）

按 §9 顺序完成，与设计的偏差如下：

- **发现通道**：未做适配器级 env 推广（按 §1 非目标保持），实现为「注册表 + 指令内嵌 thread id」；`HARNESS_MIX_COLLAB_URL/KEY` 环境变量（与 MCP 桥同名）优先于注册表。注册表目录可用 `HARNESS_MIX_COLLAB_REGISTRY_DIR` 覆盖（测试与 CLI 共用）。
- **run() 重构**：团队信封组装移入 `run()` 子线程创建之后（`envelope` 上下文参数），信封措辞按子会话 `collaborationEnabled` 选形；`job.task` 恒存原始任务文本，信封只在投递时组装。
- **dispatch 文本**：以 `dispatchOps(threadId)` 生成操作短语，五处唤醒文本（继续协作×3、改派、团队任务落定唤醒）与团队模板展开指令全部改为前端感知措辞。
- **共享 recovery 段落**改为双前端表述（"MCP list_delegations, or CLI 'delegations'"）。
- **initialize() 容错**：加载失败的 `this.loading` 不再缓存 rejection，允许下次重试（瞬时 IO 失败不再导致协作永久不可用）。
- **注册表目录派生**：Host 侧从 `runtime.store.directory` 同级派生（`registryDirectoryFor`），CLI 侧按同一平台规则计算（`dataBase` / `HARNESSMIX_DATA_DIR`）——测试的临时数据目录自动隔离注册表，生产统一落平台数据目录。
- **新增文件**：`src/main/host/collab-registry.js`、`collaboration-cli.cjs`、`collaboration-skill.js`；**修改**：`collaboration.js`、`collaboration-tools.js`、`runtime.js`、`native/host.js`、`package.json`（test:core-all 挂入 `collaboration-cli-test` / `collaboration-skill-test`）。
- **测试**：`scripts/collaboration-cli-test.cjs`（真实子进程走完发现→鉴权→call→输出→退出码全链）、`scripts/collaboration-skill-test.cjs`（四态状态机）、`collaboration-test.cjs` 扩展（CLI lead 注入、信封双措辞、成员资格放宽 + 白名单回归）。
