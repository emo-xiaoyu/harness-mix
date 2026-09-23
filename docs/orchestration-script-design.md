# Agent Team 编排脚本设计

状态:**已实现**。`run_team_script` 协作工具、受限 DSL 解释器([team-script.js](../src/main/host/team-script.js))、driver/journal/重放([collaboration.js](../src/main/host/collaboration.js))已落地并通过 `test:collaboration` / `test:collaboration-recovery` 覆盖。本文保留三个核心决策与边界,实现细节与本文有出入处以本文「实现注记」为准。

## 1. 问题与定位

今天 Lead 用工具保姆式编排:`delegate_to_agent` 取 task_id,`get_delegation_status`(单次等待 ≤60s)轮询收取。成员任务动辄数分钟,Lead 的等待、分支、重试全部以模型回合计价:烧 token、挤占上下文(加速 compaction)、中断恢复时只能从任务状态重建意图。

编排脚本把「编排」从模型的运行时行为变成模型的**输出物**:Lead 一次生成一段小脚本,声明任务、依赖与结果驱动的分支;Host 确定性执行,执行期**零模型调用**。定位是现有协作工具面之上的**执行驱动层**——不是替代,简单委派仍走 `delegate_to_agent` 直呼。

**非目标**:不绕过任何既有安全边界。成员授权仍来自用户本轮 `#` 提及(脚本引用的成员必须在既有 Team roster 内);审批仍走各原生 Harness;成员仍只有 `get_team_state`/`update_team_task`/`send_team_message` 能力,不得创建团队或递归委派;Host 不代答、不碰凭据。

## 2. 决策一:脚本编译进持久任务图(不另立执行体系)

脚本中的任务声明**编译为共享任务图节点**(`task()` 即 `assign_team_task` + 派发),控制流(等待、条件分支)留在 Host 侧的 driver 里,在任务完成事件之间推进。任务图是唯一的副作用账本与事实源——看板、邮箱、依赖解锁(blocked→pending)、`retry` 自动重派、中断握手 handoff、`继续协作` 恢复,全部原样生效。

- 入口:`run_team_script(team_id, script)`。Team 仍由 Lead 显式 `create_agent_team` 创建(授权门不变);脚本只引用既有成员名(静态字符串字面量)。
- driver 独立于 Lead 回合存活(MCP 客户端 70s 超时,工具立即返回);`run()` 对脚本拥有的作业放宽「Lead 回合结束即取消」的监督,脚本任务照常结算;Lead 回合结束后派发的子任务回落成员独立成回合路径。
- 子任务 30 分钟超时与任务级 `retry` 预算沿用现有结算路径;并发 ≤6、同成员互斥由 driver 排队。
- **实现注记**:声明即执行——`task()` 调用即建图任务并启动派发(依赖未就绪则在图内等待);脚本 `return` 后 driver 显式 join 全部未决任务才落终态。task 句柄在 DSL 内以不透明值贯穿,`Promise.all([...])` 汇合、属性取值(`.status`/`.result`/`.handoff`)解引用。

## 3. 决策二:执行前验证门(烧掉任何子任务 token 之前拦住拓扑错误)

脚本在任何派发发生前过四道门,全部失败以结构化错误回给 Lead 修正:

1. **解析门**:`team-script.js` 的词法/语法分析,错误带行号。
2. **绑定门**:`task({...})` 的 `member` 必须是**字符串字面量**且能解析到 Team 既有成员(错误列出可用成员);**静态作用域检查**保证引用的变量在派发前已声明(带行号)——脚本先声明任务再写错变量时,不至于烧掉前几个任务的 token 才发现。
3. **拓扑/预算门**:任务声明总数 ≤16;脚本 ≤8000 字符、AST ≤3000 节点;循环只允许 `for-of` 有界数组(≤64 项)——`while`/`for(;;)` 在语法上不存在,死循环不可能;求值器每语句 `tick()`,步数预算 20000。

**实现注记**:依赖成环在构造上不可能(依赖只能引用已存在的句柄/结果);并发峰值与同成员互斥由 driver 运行时排队兜底。

## 4. 决策三:journal 重放(恢复是崩溃恢复,不是重新验证)

driver 每个编排原语(`task`/`phase`)以单调 seq 记入 journal,随 teams.json 持久化。**任务图记录副作用,journal 只记录控制流**:

- **中断**(原生停止 / 「中断团队」):级联取消 + 收尾握手照常,driver 落 `interrupted`,journal 保留。
- **恢复**(「继续协作」/Host 重启):driver 从 seq=0 重放——journal 命中的原语带 spec 哈希校验后直接落定(零副作用、零模型调用),第一个未覆盖的原语活跑;已 completed 的图任务**绝不重新派发**;中断残留的同名任务被采纳并以 `resume` 语义复用原会话与工作区(附成员 handoff)。哈希不一致即「重放发散」,结构化报错要求改脚本重跑。
- **Lead 唤醒规则**:脚本正常结束(带逐任务汇总)或致命失败时,等 Lead 空闲注入一次唤醒回合(约 60s 内重试);分支条件只允许引用 Host 侧数据(任务状态/结果/handoff),执行期不需要 Lead 决策。「继续协作」恢复的是 driver,不是 Lead 回合。

## 5. DSL 边界(形态)

TypeScript 风格极小子集:`const` 声明、`if/else`、`for-of`(仅数组)、`return`、`phase("...")`/`task({...})`/`state()`/`Promise.all([...])`;字面量(含对象/数组)、成员与索引访问、`!`/`await`、比较与 `+` 拼接、逻辑短路、三元;数组方法白名单 `push/concat/includes/indexOf/slice/join`(静态按名放行、运行时校验基对象)。**不含**:赋值、while、函数定义、任意方法/属性调用、fs/网络。全部副作用只能经三个原语发生。

## 6. 与直接工具委派的并存

- driver 运行中,该团队对 Lead 的直接 `delegate_to_agent` 与再次 `run_team_script` 独占拒绝;`send_team_message` 与用户看板操作不受限。
- 工具描述中给出选择指引:多阶段、多成员汇合、结果驱动分支 → 脚本;一次性问答 → 直呼。
- `get_delegation_state` 投影含 `script_id` 与 `handoff`;teamView/inspect 暴露 `driver` 摘要(状态/阶段/错误/结果/脚本任务列)。

## 7. 验收状态

- [x] 四道验证门落地(含静态作用域检查),结构化错误可被 Lead 一轮修复(语法行号、成员清单提示);
- [x] 执行期零模型调用(`test:collaboration` 断言:执行期 Lead 仅收到一次终态唤醒);
- [x] 中断→恢复:journal 重放不重派已完成任务,handoff 进入恢复提示词;
- [x] 看板/邮箱/retry/超时/收尾握手在脚本驱动下行为与直呼路径一致(同一套结算断言);
- [x] 脚本与直呼工具的独占/并存边界有测试覆盖;
- [x] 运行时错误落 `driver.error` 并以结构化失败唤醒 Lead(Phase 6 E 场景);
- [x] Workbench 阶段条:driver 存在时显示「编排状态 · 当前阶段 · 脚本任务进度」,失败染红并 hover 展示错误;紧凑面板 eyebrow 标记编排阶段;`script_*` 事件以中文入时间轴(UI 冒烟断言);
- [x] 用例并入 `test:core-all`(`test:collaboration` Phase 6 + `test:collaboration-recovery` 重启语义)。

后续增量(未实现):DSL 语法糖(spread、模板字符串)。
