# 会话存储与验证门禁设计

状态：已实现第二阶段（2026-09-15）。

## 目标与边界

会话存储必须长期可恢复，且不能通过截断对话或工具证据换取表面上的体积下降。验证门禁负责判断一次任务是否达到用户配置的交付标准，但不改变原生 Harness 的回合、权限或审批结果。

## 会话存储 schema v2

`threads.json` 从无版本数组升级为 `{ schemaVersion, savedAt, threads }`。加载器继续接受旧数组并在首次保存时迁移；覆盖前保存 `threads.json.bak`，写入仍使用临时文件和原子替换。

Core checkpoint 是历史的唯一执行投影。保存时移除可以从 Core 无损重建的 `message.coreTurn`、`message.coreItems`、助手文本、工具列表、Usage 和当前回合视图，启动时由 `CoreSession.sync()` 恢复。这消除了同一回答、Reasoning 和工具输出在 `messages`、`tools` 与 `coreState` 中的重复，不删除用户输入、附件元数据、Review 引用或原生 Session 引用。载入完成后会释放原始 `coreState` 副本，仅在保存快照期间短暂生成，避免常驻内存同时保留 Core 与完整 checkpoint 两份状态。

Host 提供：

- `codexhost/storage/inspect`：返回文件大小、逻辑大小、紧凑后大小以及最大的 20 个任务。
- `codexhost/storage/optimize`：显式重写为当前 schema，并返回优化前后统计。

## 分片存储 schema v3

首次保存 v2 后，Host 会生成 `threads/index.json` 和 `threads/records/<threadId>.json`。旧 `threads.json` 不删除，并额外保留 `threads.json.bak`。索引只包含侧栏所需的标题、Harness、路径、时间、状态、首条预览和记录大小；冷启动只读取索引。`thread/read`、发送、接力或配置等首次真正访问任务的操作才同步载入该任务记录并恢复它的 Core checkpoint。

保存时只重写已经载入的任务记录，未打开任务不会被读取或重写；索引最后原子替换，因此中途失败仍保留上一份可用索引。删除任务时在索引成功保存后删除对应记录文件。

## 任务级验证门禁

策略包含：

- `mode`: `off`、`advisory` 或 `required`。
- `autoRun`: 回合和文件 Review 结算后自动运行。
- 内置检查：回合成功、无待处理交互、无运行中工具、Review 无错误、可选 Git 工作区干净。
- 最多八条用户显式配置的验证命令，每条具有 1 秒至 10 分钟超时。

命令仅在任务工作目录执行，输出各保留末尾 16,000 字符并经统一脱敏器处理；包含疑似明文凭据的命令会被拒绝，应由原生进程环境提供所需认证。报告持久化退出码、超时、耗时和有界 stdout/stderr。`advisory` 仅报告；`required` 的最新报告必须属于当前最后一轮且成功，才能合并或推送隔离工作区。新回合会自然令旧报告失效。

Host 方法：

- `codexhost/thread/verification/get`
- `codexhost/thread/verification/configure`
- `codexhost/thread/verification/run`

原生命令面板提供 `/verify`、`/gate-required`、`/gate-advisory` 和 `/gate-off`。完整配置可以直接输入，例如 `/gate required --auto --clean -- npm run test:ci`；也可以通过 Host 协议写入多条命令。

每次运行还会向对应的终态 Turn 投影一个 `verification_report` Core Item。Desktop 将它显示为 Harness Mix 验证工具卡片；接力检查点会把该报告作为脱敏的 `verification` 证据携带。重复验证更新同一回合的报告，不制造重复卡片。

## 后续阶段

下一阶段应增加设置页中的图形化策略编辑器和报告详情视图，并用真实大体积数据副本记录冷启动 RSS、索引加载耗时、单任务水合耗时与增量保存耗时。只有真实重启后的 Desktop 验收完成，才能宣称 UI 完整交付。
