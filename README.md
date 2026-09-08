# Harness Mix

独立的多 Harness 桌面壳（Electron）。借鉴 [codex-host](https://github.com/BytePioneer-AI/codex-host)
的插件化思路，但桌面层完全自研：Codex、Pi、Claude Code、DeepSeek Harness 等的**会话、模型调用、
工具和权限仍由各自原生程序维护**；Harness Mix 只负责三件事——

1. **自研 Desktop**：统一呈现对话（Markdown 排版与各 Harness 返回的图片 / 文件产物）、流式输出、工具状态、审批、模型选择、任务恢复 / Fork、应用内确认对话框；
2. **会话与任务编排**：任务卡片 ↔ 原生会话的映射、惰性恢复（下次发送才拉起原生进程）、
   任务级 Fork（由原生程序分叉出真实新会话）；
3. **事件转换**：把各 Harness 的原生协议事件投影成统一事件模型（见下）。

## 架构

```
Renderer（桌面 UI）            src/renderer/
  └─ IPC（preload 白名单）      src/main/preload.js
Host Runtime（编排/恢复/投影）   src/main/host/runtime.js · store.js · jsonl.js
  └─ Adapter 注册表             src/main/adapters/index.js
       ├─ Codex Adapter         adapters/codex.js  → codex app-server --stdio（官方 JSON-RPC）
       ├─ Pi Adapter            adapters/pi.js     → pi --mode rpc（官方 RPC）
       ├─ DSH Adapter           adapters/dsh.js    → npm run dsh -- web（官方 Web Remote，Typert RPC + WS mux）
       └─ Claude Code Adapter   adapters/claude.js → @anthropic-ai/claude-agent-sdk query()（官方持久会话）
```

**Adapter 插件结构**（借鉴 codex-host 的 Manifest / 工厂 / Adapter / Session 划分）：

```js
module.exports = {
  manifest: { id, name, icon, capabilities: { streaming, thinking, tools, approvals,
              questions, models, resume, fork, usage } },
  create(emit) -> {
    inspect()                       // 原生程序可用性探测
    open({ thread, emit, diagnostic }) -> session   // 启动/恢复原生会话进程
    send(session, text) / cancel(session) / close(session)
    respond(session, requestId, response)           // 审批·提问应答回原生协议
    listModelsFor(session) / setModel(session, model)
    fork(sourceThread) -> { session, nativeSessionId }  // 任务级 Fork（可选能力）
  }
}
```

新增 Harness = 在 `src/main/adapters/` 加一个同形状模块并注册进 `index.js`，
Renderer 与 IPC 协议无需改动。

### 与 codex-host 核心设计的对应关系

这里借鉴的是“原生 Harness → Adapter → Host 事件投影 → UI”的分层；没有直接引入 codex-host 的 `protocol-core` 包。Codex Adapter 直接消费官方 app-server JSON-RPC，自研 UI 消费 Harness Mix 自己的投影结构。

| 参考职责 | 当前实现 | 边界 |
|---|---|---|
| Thread / Turn 路由 | `host/runtime.js` 的线程、原生 session 映射与 send/cancel/resume/fork | Core 有独立 Turn 状态；Codex 保留官方 native thread/turn ID |
| Harness Event → Item | `EventNormalizer` → `ProtocolCore` 持久化 text/reasoning/tool/plan/file-change Items | 原生事件先在所属 Adapter 内转换，未知扩展事件不会假装成通用能力 |
| Tool / Approval / Question | Adapter 事件进入 Runtime；应答经 `respond()` 回原生程序 | Codex Server Request、Pi extension UI、DSH waterfall、Claude canUseTool 均原路应答 |
| Diff | Codex 投影原生 fileChange/patch；Runtime 同时用轮前快照形成可撤回审查 | Pi/Claude/DSH 仍以各自原生事件加快照审查为准 |
| Harness adapter abstraction | `adapters/index.js` 注册 manifest/create/session；Codex app-server、Pi RPC、DSH Web Remote、Claude Agent SDK | UI 品牌排序仍是静态目录，不是可安装插件市场 |

Runtime Diff、独立 Turn 生命周期、NativeRef、Plan、Compaction 与 Interaction 已接入。Harness 专有的完整事件集合仍留在 Adapter 边界，不宣称四家所有高级功能完全等价。

本轮核对源码：[Codex Turn](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts)、[Codex ThreadItem](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts)、[codex-host Harness 契约](https://github.com/BytePioneer-AI/codex-host/blob/main/packages/harness-adapter/src/text-session.ts)、[codex-host UI projector](https://github.com/BytePioneer-AI/codex-host/blob/main/packages/protocol-core/src/codex-ui-projector.ts)。借鉴明确区分正文、推理与工具 Item 的语义，UI 不把正文当作思考一起隐藏。

## 统一事件模型（Adapter → Host 投影）

| kind | 含义 | Codex 来源 | Pi 来源 | DSH(Web Remote) 来源 | Claude Code 来源 |
|---|---|---|---|---|---|
| `text-delta` / `thinking-delta` | 流式正文 / 思考 | `item/agentMessage/delta` / `item/reasoning/*Delta` | `message_update` | `assistant/chunk` 的 text-delta / reasoning-delta | SDK assistant content block |
| `tool` | 工具状态（running/done/error + 摘要） | `item/started` / `item/completed` / output delta | `tool_execution_*` | `tool/call` / `tool/result` | assistant `tool_use` / user `tool_result` |
| `artifact` | 返回的图片 / 文件产物 | `imageGeneration` / `imageView` Item | 工具结果中的 image 块 | 暂无独立 artifact 投影 | SDK 工具结果中的图片 / 文件块 |
| `approval` | 审批 / 提问（select·confirm·input·permission） | JSON-RPC Server Request | `extension_ui_request` | `$events` waterfall `approval/request` / `agent/question` | SDK `canUseTool` |
| `usage` | tokens / 上下文占比 | `thread/tokenUsage/updated` | `message_update.usage` / `get_session_stats` | `assistant/chunk` usage（窗口取自 `request/context`） | SDK result `modelUsage` |
| `status` / `notice` | 重试、压缩、通知等瞬态 | warning / `contextCompaction` Item | `auto_retry_*`、`compaction_*`、`notify` | `agent/compaction`、`plan/update` 等 | SDK system / status / result |
| `completed` / `error` | 回合结束 / 失败 | `turn/completed` / error | `agent_settled` | `turn/end` | SDK result |

应答路径反向走 `approval:respond` → Adapter.respond → Codex JSON-RPC Server Request / Pi
`extension_ui_response` / DSH `$events/result` / Claude `canUseTool`，全程不伪造原生权限决策。

## 能力矩阵（如实声明，不做假的通用开关）

| 能力 | Codex | Pi | DSH | Claude Code |
|---|---|---|---|---|
| 流式回复 / 工具状态 | ✅ app-server Item | ✅ | ✅ | ✅ |
| 思考流 | ✅ reasoning notification | ✅ | ✅ | ✅ |
| 审批 / 提问 | ✅ 原生 Server Request，支持多问题 | ✅ extension UI | ✅ waterfall | ✅ canUseTool / AskUserQuestion |
| 模型选择 | ✅ `model/list` | ✅ 完整目录 | ✅ 会话配置项 | ✅ `supportedModels()` |
| 会话恢复 | ✅ `thread/resume` | ✅ `--session-id` | ✅ `session/follow` | ✅ `resume` |
| 任务 / 回复 Fork | ✅ `thread/fork(lastTurnId)` | ✅ 原生 Pi | ✅ `session/fork(atSeq)` | ✅ SDK `forkSession` |
| 快捷压缩 | ✅ `thread/compact/start` | ✅ 原生 RPC | ✅ 原生 `/compact` | ✅ 原生 `/compact` |
| Usage | ✅ `thread/tokenUsage/updated` | ✅ | ✅ | ✅ result modelUsage |

## 运行与验证

```powershell
cd E:\harness-mix
npm install
npm start        # 启动桌面
npm run check    # 全部源码语法检查
npm run smoke    # 真实 Renderer + 模拟 IPC 的集成检查（不调用模型）
```

环境依赖：`codex.cmd`（`npm i -g @openai/codex`）、`pi.cmd`（`npm i -g @earendil-works/pi-coding-agent`）；
DSH 检出默认 `E:\dsh\deepseek-harness`，可用 `HARNESS_MIX_DSH_ROOT` 覆盖；
Claude Code 通过 `@anthropic-ai/claude-agent-sdk` 接入；各原生 CLI 或 SDK 不存在时，对应 Adapter 会如实标记为不可用。

DSH 走其官方 Web Remote：由本机 `npm run dsh -- web` 拉起（不打开浏览器），以启动 URL 的一次性
token 换会话 cookie，经 HTTP unary + WebSocket `/api/remote.mux` 复用流（Typert RPC）驱动 `session/*` 命名空间；
不嵌入 DSH Web UI，也不读取其账户或密钥。
启动探测会验证目标根目录、`package.json#scripts.dsh` 和 `node_modules`；原生会话创建/恢复、
模型与 reasoning 配置、工具输入输出、审批与提问（waterfall）、用量、计划、检查点 fork 和压缩均从官方事件流投影。
可运行 `npm run test:dsh-adapter` 做离线协议回放，`npm run e2e:dsh` 做真实最小模型调用。

账号、密钥、模型调用、工具执行、权限与会话持久化仍属于各原生 Harness；
Harness Mix 不读取或保存任何凭据。

## 边界

### 右侧工作区（审查 / 终端 / 文件 / Git）

- 右上角侧栏按钮打开工作区，或使用 `Ctrl+Shift+G` 审查、Ctrl + 反引号打开终端、`Ctrl+P` 文件。
- 拖动右侧面板左边缘调整宽度，双击恢复默认；聚焦分隔条后用左右方向键每次调整 20px，Home 恢复默认。宽度记忆到本机，窗口缩小时自动约束范围。
- 执行中和结束后保留正文与进度说明，连续思考/工具记录收进就地摘要组，点击摘要展开，再点击单个工具查看输入输出；展开状态与过程滚动位置在流式更新中保留。工具摘要统计调用次数，文件数量以独立差异记录为准。顶部整轮耗时使用统一秒/分钟格式与向下取整规则，结束后由保存的开始/结束时间固定。未携带独立结论事件的 Harness 使用末尾文本段，旧聚合文本不强行拆分。顶部不再显示“新对话”草稿标签，侧栏新建入口保留。
- 执行中可点击“已更改文件”查看右侧实时差异。Runtime 每 2 秒检查一次并推送 `turn/diff/updated`，Renderer 不再定时发起扫描请求；打开面板与逐文件展开仍按需读取。输入筛选条件时暂停面板重绘。监测请求不重叠，完成、取消和关闭时停止，迟到的扫描结果不覆盖结算结果。预览不会覆盖本轮基线，执行中禁止撤回。
- 每轮发送前对工作目录建立文本基线，结束后产生独立审查记录。差异基于本轮前后文件，不基于 Git HEAD，因此不会把开始前已有的改动算成本轮改动。同期外部编辑无法区分归属，审查区明确提示这一点。
- 审查支持轮次选择、逐行增删、当前文件预览，以及二次确认后的逐文件撤回。撤回校验当前内容与本轮结束版本一致，否则拒绝覆盖。新增文件撤回会移除该文件；删除文件撤回会恢复原文；修改前后两版都保存在用户数据目录的 `harness-mix/reviews`，不修改 Git 暂存区或提交。
- 快照只涵盖 UTF-8 文本（单文件最多 1 MB、总文本最多 24 MB、目录项最多 15,000）；跳过链接、依赖/构建目录、常见凭据路径、二进制与超限文件。超限或快照失败会显示提示，不提供虚假的撤回。旧任务无基线，不能补建撤回。
- 文件面板只读浏览项目目录与代码，不加载项目外路径或符号链接。当前树每层最多显示 1,500 项。
- 终端是真实 PowerShell 7 命令执行器，支持流式输出、退出码、停止进程树、关闭面板后恢复输出。它不是 PTY，不支持交互式 TUI/stdin；每次命令从项目目录启动，不保留 shell 状态，输出仅在本次应用运行内保留（每个命令最多最后 200k 字符）。不会把 Harness 的工具输出自动执行到这里。
- 同一项目的手动终端和 Harness 任务不能同时启动；运行任务期间不能撤回。文件撤回与原生会话回退是不同操作，不会改写 Harness 对话历史。

参考：Codex 的 [TurnDiffTracker](https://github.com/openai/codex/blob/main/codex-rs/core/src/turn_diff_tracker.rs) 维护回合基线与净差异；[codex-host](https://github.com/BytePioneer-AI/codex-host) 将文件变化投影到 `item/fileChange/patchUpdated` / `turn/diff/updated`。这里独立实现工作区服务与侧栏，不复用 Codex Desktop 私有 UI；目前 Pi/DSH 没有统一的精确写入事务，因此使用有边界的文件快照，不声称拥有原生逐补丁归因能力。

验证：`npm run test:workspace`（差异、脏文件基线、冲突/路径校验、撤回、真实终端）和 `npm run smoke:workbench`（真实 Electron + 临时项目 + 真实文件/终端 IPC）。测试只改临时夹，不撤回用户项目。

### 内置 Git

Git 标签使用本机 Git for Windows，支持仓库初始化、分支名、工作区/暂存区状态、文本差异、逐文件暂存/取消暂存、提交已暂存内容和最近 15 条提交。提交前展示确认框，不自动暂存全部文件；未暂存的新文件可从文件标签预览，暂存后查看 Git diff。任务或终端执行期间禁止 Git 写操作。

请将仓库根目录作为项目打开。这里不内置 Git 二进制，不读取账户凭据；尚未接入 fetch/pull/push、分支切换与冲突编辑器。Git 使用独立 argv 调用，路径使用 literal pathspec；错误会显示原始 Git 提示。`npm run test:git` 覆盖真实临时仓库的中文/空格路径、差异、暂存、取消暂存、首次提交和重命名；`smoke:workbench` 额外验证真实鼠标拖拽及 Git IPC 操作。

### 会话时间线与用量

实际 Desktop 会话区读取 Protocol Core 的 Turn 与 Items（agent_message / reasoning / tool_call），
思考和工具默认折叠，展开可查看原生内容、输入和结果；流式刷新保留展开状态。
历史聚合记录仍可阅读，但没有原始顺序的工具单列为“历史工具记录”，不推测插入位置。
工具按回合与原生 toolCallId 区分；中断不标为成功。Pi 结果预览最多 24,000 字符。

用量弹层的 Pi 会话 Token / 缓存 / 费用来自 `get_session_stats`，上下文来自
同一返回的 `contextUsage`；最近缓存命中率来自 `message_end`，按
`cacheRead / (input + cacheRead + cacheWrite)` 计算，与 codex-host 的 Pi 统计口径一致。
DSH 上下文使用 Web Remote `request/context` 的原生窗口与 usage chunk 合计。百分比最多一位小数，缺失字段显示 `—`。
不虚构推理 Token、5 小时 / 7 天额度。文件审查/撤回的实现边界见上节。
可运行 `npm run test:core-all` 验证协议、顺序、并发工具、取消、持久化、原生回放及文件变更。
`npm run test:transcript` 保留独立旧投影对照与用量口径测试。

### Protocol Core 迁移

当前生产路径已统一为 Adapter → EventNormalizer → ProtocolCore → projected Thread / Turn / Items → Renderer。
Turn 在调用原生 Harness 前建立，状态由 TurnManager 维护；最终回复使用 Core `phase=final` 语义。
InteractionRouter 统一审批和问题，能力来自 Adapter Manifest；native/snapshot/git 差异使用 FileChange Item。
Legacy 实时投影已移到测试支持目录，旧数据在加载时迁移，默认 `npm start` 使用 Core。
完整完成清单、测试证据和能力边界见 [CORE-MIGRATION-STATUS.md](CORE-MIGRATION-STATUS.md)。
`npm run smoke:app` 验证真实应用启动、历史迁移、刷新及退出保存；`npm run e2e:core-files` 会在临时目录调用原生 Harness 并验证编辑与撤回。Codex 使用 `npm run e2e:codex` 验证 app-server 流式回复、Usage、回复 Fork、冷恢复和压缩。

第一版 Host Runtime，不承诺跨 Harness 完全功能等价；界面只为已声明能力渲染入口。

### 项目、按需菜单与回复分支（2026-09-08）

- 模型和权限目录只在点击菜单时读取；按 Harness 缓存、合并并发请求。切换对话或关闭菜单后，迟到结果不会重新打开旧菜单，加载提示留在菜单内部。
- 项目行用关闭/打开文件夹图标表示折叠状态，悬停或键盘聚焦时显示新建对话和操作菜单。菜单支持新建对话、置顶、编辑显示名称、在资源管理器打开、移除；名称和置顶顺序保存在本机。
- 用户气泡按内容宽度显示。上下文占用与会话累计 Token 分开展示；未知值、压缩后的待更新值会清空旧百分比。点击用量可按 Adapter 能力查询原生最新统计；DSH 使用 Web Remote 事件值。
- 支持该能力的 Harness 可在回复下方“分支到新聊天”，原生会话和桌面历史都截断到所选回复。新回复保存原生 checkpoint；旧回复仅在原生历史可唯一定位时允许分支，不能定位则明确报错。原任务不受影响。
- `session.forkFromMessage` 独立声明回复级分支能力。四家均已接入；Codex 使用官方 `thread/fork({ lastTurnId })`，Pi 截断原生会话到所选回复，Claude 使用官方 SDK `forkSession({ upToMessageId })`，DSH 使用 `session/fork` 的 `atSeq` 检查点。

语义参考 [Codex ThreadForkParams 的 lastTurnId](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkParams.ts)，上下文统计对照 [codex-host Pi Usage](https://github.com/BytePioneer-AI/codex-host/blob/main/packages/adapters/pi/src/pi-usage.ts)。实际调用本机 Pi 的原生 RPC，不修改其会话文件。

验证：`smoke` 覆盖延迟菜单、请求去重、项目操作、气泡和回复分支 IPC；`smoke:app` 覆盖项目重命名/置顶后刷新恢复；`e2e:core-fork` 实际验证原生分支不含后续轮次，并逐项比对上下文 Token 与原生统计。

输入框的上下文占用左侧新增指令按钮（用户提供的 `commands.svg`）。仅点击后读取当前 Harness 指令：Codex、Pi、Claude 和 DSH 都提供各自原生压缩入口。压缩要求已有会话且回复和文件结算已完成，错误直接显示原生返回原因。

`npm run e2e:commands-claude` 验证指定回复分支、再次分支、排除后续消息、压缩及后续回忆；`npm run e2e:commands-pi` 验证原生压缩及回忆。测试使用临时项目，Pi 的较小压缩保留窗口仅写入测试项目设置，不修改用户全局配置。运行报告在 `output/verification/commands-{claude,pi}.json`。
