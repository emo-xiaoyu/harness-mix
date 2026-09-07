# Harness Mix

独立的多 Harness 桌面壳（Electron）。借鉴 [codex-host](https://github.com/BytePioneer-AI/codex-host)
的插件化思路，但桌面层完全自研：Pi、Claude Code、DeepSeek Harness 等的**会话、模型调用、
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
       ├─ Pi Adapter            adapters/pi.js     → pi --mode rpc（官方 RPC）
       ├─ DSH Adapter           adapters/dsh.js    → pnpm dsh --profile acp（标准 ACP v1）
       └─ Claude Code Adapter   adapters/claude.js → claude -p --output-format stream-json（脚手架）
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

这里借鉴的是“原生 Harness → Adapter → Host 事件投影 → UI”的分层；没有直接引入 codex-host 的 `protocol-core` 包，也不输出完整 Codex app-server 协议。自研 UI 消费 Harness Mix 自己的投影结构。

| 参考职责 | 当前实现 | 边界 |
|---|---|---|
| Thread / Turn 路由 | `host/runtime.js` 的线程、原生 session 映射与 send/cancel/resume/fork | 一轮暂由 assistant 消息承载，未建立独立 Turn 状态机和 native turn ID 映射 |
| Harness Event → Item | `host/transcript.js` 持久化有序 text/thinking/tool items，保留工具 ID 与输入输出 | 尚无完整的强类型 Item 契约、事件序列校验和 commentary/final phase；最终段仍使用末尾文本判断 |
| Tool / Approval / Question | Adapter 事件进入 Runtime；应答经 `respond()` 回原生程序 | Pi 支持 extension UI 提问，DSH 当前只支持权限审批，Claude 为基础脚手架 |
| Diff | Runtime 管理轮次监测，通过 `turn/diff/updated` 主动推送；主进程 `workspace/review.js` 根据轮前基线计算差异 | 自研事件携带 threadId、turnId（当前消息 ID）及结构化 review，非完整 Codex wire 协议；不具备原生补丁归因 |
| Harness adapter abstraction | `adapters/index.js` 注册 manifest/create/session；Pi RPC、DSH ACP、Claude stream-json | UI 中品牌选择列表仍需登记，不能称为完整动态插件系统 |

Runtime Diff 推送已接入。后续待补独立 Turn 生命周期、完整 threadId/turnId/itemId 事件契约、原生 phase 与 Plan/Compaction 等结构化 Item；这些待实现项不能通过改目录名称声称已经具备。

本轮核对源码：[Codex Turn](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts)、[Codex ThreadItem](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts)、[codex-host Harness 契约](https://github.com/BytePioneer-AI/codex-host/blob/main/packages/harness-adapter/src/text-session.ts)、[codex-host UI projector](https://github.com/BytePioneer-AI/codex-host/blob/main/packages/protocol-core/src/codex-ui-projector.ts)。借鉴明确区分正文、推理与工具 Item 的语义，UI 不把正文当作思考一起隐藏。

## 统一事件模型（Adapter → Host 投影）

| kind | 含义 | Pi 来源 | DSH(ACP) 来源 |
|---|---|---|---|
| `text-delta` / `thinking-delta` | 流式正文 / 思考 | `message_update` | `agent_message_chunk` / `agent_thought_chunk` |
| `tool` | 工具状态（running/done/error + 摘要） | `tool_execution_*` | `tool_call` / `tool_call_update` |
| `artifact` | 返回的图片 / 文件产物 | 工具结果中的 image 块 | `agent_message_chunk`（image / resource_link） |
| `approval` | 审批 / 提问（select·confirm·input·permission） | `extension_ui_request` | `session/request_permission` |
| `usage` | tokens / 上下文占比 | `message_update.usage` | `usage_update` |
| `status` / `notice` | 重试、压缩、通知等瞬态 | `auto_retry_*`、`compaction_*`、`notify` | `plan` 等 |
| `completed` / `error` | 回合结束 / 失败 | `agent_settled` | `session/prompt` 结算 |

应答路径反向走 `approval:respond` → Adapter.respond → Pi `extension_ui_response` /
ACP `session/request_permission` 结果，全程不伪造原生权限决策。

## 能力矩阵（如实声明，不做假的通用开关）

| 能力 | Pi | DSH | Claude Code（脚手架） |
|---|---|---|---|
| 流式回复 / 工具状态 | ✅ | ✅ | ✅（回合级） |
| 思考流 | ✅ | ✅ | — |
| 审批 / 提问 | ✅ extension UI | ✅ 一次性 allow/reject | — |
| 模型选择 | ✅ 完整目录 | ✅ 会话配置项 | — |
| 会话恢复 | ✅ `--session-id` | ✅ `session/resume` | ✅ `--resume` |
| 任务 Fork | ✅ CLI `--fork` | ❌（ACP 未支持） | ❌ |
| Usage | ✅ | ✅ | — |

## 运行与验证

```powershell
cd E:\harness-mix
npm install
npm start        # 启动桌面
npm run check    # 全部源码语法检查
npm run smoke    # 真实 Renderer + 模拟 IPC 的集成检查（不调用模型）
```

环境依赖：`pi.cmd`（`npm i -g @earendil-works/pi-coding-agent`）；
DSH 检出默认 `E:\dsh\deepseek-harness`，可用 `HARNESS_MIX_DSH_ROOT` 覆盖；
Claude Code 为可选脚手架（`claude` CLI 存在即启用基础链路）。

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

实际 Desktop 会话区按接收顺序持久化 `message.items`（text / thinking / tool），
思考和工具默认折叠，展开可查看原生内容、输入和结果；流式刷新保留展开状态。
历史聚合记录仍可阅读，但没有原始顺序的工具单列为“历史工具记录”，不推测插入位置。
工具按回合与原生 toolCallId 区分；中断不标为成功。Pi 结果预览最多 24,000 字符。

用量弹层的 Pi 会话 Token / 缓存 / 费用来自 `get_session_stats`，上下文来自
同一返回的 `contextUsage`；最近缓存命中率来自 `message_end`，按
`cacheRead / (input + cacheRead + cacheWrite)` 计算，与 codex-host 的 Pi 统计口径一致。
DSH 上下文仍使用 ACP `usage_update`。百分比最多一位小数，缺失字段显示 `—`。
不虚构推理 Token、5 小时 / 7 天额度。文件审查/撤回的实现边界见上节。
可运行 `npm run test:transcript` 验证顺序、并发工具、取消、序列化与用量口径。

第一版 Host Runtime，不承诺跨 Harness 完全功能等价。Pi 的 `fork(entryId)` 消息级分叉、
DSH 的 `reasoning_effort` 档位、Claude Code 的 stream-json 控制协议（工具审批）等
会在后续迭代按能力声明逐步接入；界面只为已声明能力渲染入口。
