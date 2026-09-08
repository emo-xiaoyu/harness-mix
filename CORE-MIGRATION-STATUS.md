# Core migration acceptance — 2026-09-07

## 最终状态

执行清单中的 P0、P1 迁移已完成。生产运行路径为 Adapter → EventNormalizer → ProtocolCore → projected Thread/Turn/Items → Renderer。现有 UI 布局保留，未更换 Electron、数据库或前端框架。

接手检查时，代码已先于这份文档进入 Core 单一路径，但 Runtime/Workspace 回归尚未收口。本轮修复并完成最终验收，不能用下方旧的“80%”阶段记录判断当前状态。

| 范围 | 完成内容 | 证据 |
|---|---|---|
| P0-01 / 02 | shared-contracts、CoreEvent、NativeRef | contracts |
| P0-03 / 04 / 06 | TurnManager、确定性 Projector、Sequence/Event ID 去重 | turn、projector、sequence、determinism |
| P0-05 | 已完成 Shadow 阶段；独立旧投影保留为测试 oracle | shadow、真实 E2E ParityObserver |
| P0-07 / 08 | 三套 Harness 五种必需场景，17 份原始 JSONL | core-replay 32 项检查 |
| P0-09 / 10 | 能力驱动 Adapter 契约和架构守卫 | adapters、architecture |
| P1-01 | Renderer 读取 Core Items；顶部状态读取独立 currentTurn | smoke、smoke:core |
| P1-02 / 03 | 统一 InteractionRouter，等待、回答、失败和并发提交保护 | runtime、services、smoke:core |
| P1-04 | native/snapshot/git FileChange；实时预览、筛选、详情及撤回 | native-files、workspace、git、smoke:workbench、e2e:core-files |
| P1-05 / 06 / 07 | CapabilityManager、Usage、Plan Item | services、replay、Renderer smoke |
| P1-08 | Runtime 编排；CoreSession 管执行，Workspace 管审查，Adapter 管原生协议 | architecture、runtime |
| P1-09 | 生产 Legacy Transcript/Shadow 双轨删除 | architecture、三套真实恢复及文件 E2E |

### 本轮补齐

- 两处过期测试已切到 Core Items，并等待独立的文件结算；保留同项目结算锁。
- 连续原生编辑合并为整轮 before/after；完整原生补丁优先，遗漏后续 shell 修改时由完整快照补全；保留 nativeRef。
- 修复异步旧快照覆盖新原生 Diff 的竞争，加入文件版本校验和可控延迟回归。
- 统一 Windows 子目录路径，避免 native/snapshot 重复项及撤回查找失败。
- 终态后的原生文件/计划/消息事件在执行边界忽略；文件结算仍可更新 Core。
- 应用退出等待 Runtime 保存及原生会话关闭。真实 main.js 启动测试覆盖旧历史迁移、刷新和关闭。
- 架构守卫禁止生产代码引用 legacy 测试 oracle，并禁止 Runtime/执行视图按 Harness 名称分支。

### 验收记录

- `output/verification/final-checks.log`：check、core-all、workspace、git、transcript、smoke、smoke:workbench、smoke:core、smoke:app。
- `output/verification/core-resume-{pi,claude,dsh}.json`：真实请求、退出重开、原生历史口令回忆；新旧对照无 mismatch。
- `output/verification/core-files-{pi,claude,dsh}.json`：实际创建临时文件、FileChange、Diff、撤回、验证文件已移除；无 mismatch。
- `output/verification/core-fork-pi.json`：原生模型目录、Fork 身份、继承历史、后续事件路由与源任务隔离。
- `output/playwright/core-{pi,claude,dsh}.png`、`core-services.png`：真实 Electron 渲染；1440/1040 宽度及折叠、取消、刷新验证。

### 保留边界

- Legacy 只在 `scripts/support/` 做独立验收对照，不参与生产。`host/history-import.js` 是旧数据迁移器，保留无顺序历史和缺失 final 语义的事实，不伪造历史最终答案。
- 原 `PROTOCOL_CORE_SHADOW` / `PROTOCOL_CORE_RENDERER` 回退环境变量已移除；默认 `npm start` 即 Core 单一路径。
- Adapter 保留现有命名：`open()` 对应创建/恢复，`respond()` 对应回答交互，由统一契约检查；未为改名重写 Adapter。
- Claude 当前原生接入不声明桌面审批/问题能力。DSH Plan 及 ACP native diff 映射经过原始事件/构造协议事件与 Electron 测试；本轮真实 DSH 文件运行使用 snapshot，不声称模型必定生成 Plan 或 native diff。Claude 本轮实际验证 native 来源。
- Git 面板的工作区/暂存区 Diff 返回共享 FileChange Item，保留 workspace scope，不伪造其属于某个模型 Turn。
- 既有快照大小/文件类型边界及撤回冲突校验保留；模型/权限配置未做所有组合穷举。
- 所有改动保留在当前工作区，包含接手时已有未提交重构；未自动提交、推送或发布。`output/` 测试产物不提交。

---

## 历史阶段记录（以下不代表当前运行方式，旧回退命令已失效）

## 最新一轮增量与验收

- InteractionRouter 从 Core Item 查询当前 Turn 待办，统一转交原生 respond；防并发重复提交、跨线程回答、失败误清理以及提交途中 Turn 已结束的竞争条件。Renderer 优先读取 Core interactions，原生权限决定保持不变。
- CapabilityManager 接收 Manifest 归一化能力，任务及 Adapter snapshot 提供分组能力；模型、思考、权限模式、Fork UI 使用统一能力。旧 snapshot 保留兼容。
- FileChange Projector 接受 native/snapshot/git 来源，按路径合并，完整 native 优先于 snapshot；不完整 native 不覆盖已有完整快照。删除/撤回变更同步到 Core。
- Workspace Review 实际快照、实时更新、详情 IPC 和撤回后的呈现已使用 FileChange Item，保留现有工作区边界、冲突检查和撤回机制。原生 diff/git 的生产采集尚未接入，本轮只验证其 Core 事件及优先规则。
- DSH 原生 plan 事件保留 entries 并投影为独立 Plan Item，使用现有折叠视觉组件显示；这条映射由离线事件及 Electron 测试验证，不宣称本轮实际模型主动产出了 Plan。
- Runtime 的 Legacy 消息构建移到 `host/legacy-projection.js`，审查结算、实时监控与撤回移到 `workspace/review-controller.js`。这是职责迁出，双轨仍在运行，尚未删除 Legacy。
- 修复 Pi Fork 原生会话 ID 未保存、后续原生事件持续被丢弃的问题；真实模型目录读取、Fork 身份、继承口令、后续事件路由和源任务隔离均通过。
- 新增 `test:services`、`e2e:core-fork`；扩展 Runtime 测试实际写文件、读取 Core diff、撤回及 Core undone 同步。
- 扩展真实 Electron 测试：故意污染 Legacy 审批列表，仍显示 Core 问题；实际点击提交并经过 IPC 返回原生适配器；检查 Plan、FileChange IPC、取消与重载。
- 最新检查：77 个脚本语法通过；core-all、workspace、git、smoke、smoke:workbench、smoke:core 全通过。workbench 仍有已记录的临时非 Git 目录诊断，不影响断言通过。
- 本轮重新执行 Pi/Claude/DSH 真实请求、关闭重开、口令回忆，三套 reports 的 errors/warnings/mismatches 均为 0。
- 报告：`output/verification/core-resume-{pi,claude,dsh}.json`、`output/verification/core-fork-pi.json`；新界面截图 `output/playwright/core-services.png`。

以下为上一轮基础阶段记录。

## 已落地

- 三套 Harness 均有 simple-message、reasoning、tool-call、file-edit、cancel 原始事件。Pi/DSH 另有 usage，共 17 份 JSONL。
- 本次真实采集了三套 file-edit 和 Claude reasoning；文件操作仅在临时工作区进行，实际核对文件内容，采集报告与 fixture 同目录。
- 回放测试强制要求五个场景齐全、流已结算、声明的 reasoning/tool/usage 确实出现；不再把缺场景或未覆盖当成功。
- Projector 使用事件时间和稳定的派生 ID；从空 Core 两次回放同一事件序列，完整快照相等。原生 Turn ID 不再在隐式创建时丢失。
- 默认 Core 拒绝 sequence 回退并记录警告；终态 Item 不接受迟到重写。
- Shadow 对比 Usage 实际值、开始时间和结束时间，保留原来的回答、Reasoning、工具与终态检查。
- Claude 原生 thinking 开始投影；适配器与 Normalizer 保留可获得的 session/message/tool/interaction 原生引用。
- 发送前创建独立 Core Turn；approval/question 等待、多请求逐个回答、失败、取消和准备文件快照时取消均有回归测试。
- Core 模式先记录取消，再等待原生确认；终态后的迟到执行消息不会创建新的悬挂回复。
- Renderer 从保存的 projected Core Turn/Items 读取状态、计时、Reasoning、工具和 `phase=final` 回复，Usage 从 Core 读取。保持原有布局、折叠组件和 Workspace Review。
- `core/thread-updated` 通过现有 IPC 通知刷新 projected snapshot，Renderer 不执行 Projector。
- 终态 Core 视图随现有会话文件保存；重启后继续显示。旧历史仍走兼容路径，中断时不会显示过期的 Core running 状态。
- 修复真正恢复会话时遗漏 restore 标记，以及 DSH resume 响应不重复携带 sessionId 导致下一次 prompt 报 Invalid params 的问题。

## 实际验证

| 检查 | 结果 |
|---|---|
| `npm run check` | 69 个脚本语法通过 |
| `npm run test:core-all` | contracts、projector、turn、sequence、shadow、architecture、adapter、replay、determinism、runtime 全通过 |
| `npm run test:core-replay` | 15 项场景完整性检查 + 17 份原始事件回放通过 |
| `npm run test:workspace` / `npm run test:git` | 通过 |
| `npm run smoke` / `npm run smoke:workbench` | 通过；workbench 临时非 Git 目录会产生一条 git:status 错误日志，脚本断言和退出状态均通过 |
| `npm run smoke:core` | 三套真实原始事件经 HostRuntime/Core 进入实际 Electron Renderer；展开、刷新保留、等待、取消、重载、1440/1040 宽度通过 |
| `npm run e2e:shadow-pi` / `-claude` / `-dsh` | 三套真实调用通过，errors/warnings/mismatches 均为 0 |
| `npm run e2e:core-pi` / `-claude` / `-dsh` | 三套均实际完成首次请求、关闭、重开、原生历史口令回忆；两轮 Core final 正确，Shadow 零差异 |

Core Renderer 测试故意将 Legacy 内容替换为错误文本，确认默认模式仍显示 Core；切回 Legacy 后显示兼容内容。也验证了完全关闭 Shadow 后原有发送链路可运行。

真实恢复报告：`output/verification/core-resume-{pi,claude,dsh}.json`。
实际窗口截图：`output/playwright/core-{pi,claude,dsh}.png`。这些输出不应提交 Git。

## 运行和回退

默认 `npm start` 使用 Core 执行视图，同时继续 Legacy 投影与 Shadow 对照。

只回退 Renderer，保留后台 Shadow：

```powershell
$env:PROTOCOL_CORE_RENDERER = 'false'
npm.cmd start
```

完全关闭 Core，使用 Legacy：

```powershell
$env:PROTOCOL_CORE_SHADOW = 'false'
npm.cmd start
```

恢复默认前删除上述当前终端中的环境变量，并完整重启应用。所有命令在 PowerShell 7 中执行。

## 基础阶段保留范围（最新状态以上文为准）

- Approval/Question 已推进 Core 等待状态，但统一 Interaction Router 与组件数据源全面替换属于 PR 8。
- Diff/FileChange、Capability Manager、Plan、Runtime 职责迁出和删除 Legacy 属于后续阶段，未宣称完成。
- Adapter contract 测试仍区分结构检查与真实行为；本次增加的真实行为验收是三套发送/关闭/恢复，不宣称对每种模型切换、Fork 和权限组合穷尽测试。
- 新 Core 的运行中实体仍在内存；保存的是会话附带的 projected 视图，没有新增数据库或重放工具副作用。
- 改动保留在当前工作区，包含此前已有的未提交重构文件；未自动创建提交或发布。
