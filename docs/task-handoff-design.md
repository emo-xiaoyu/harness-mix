# 跨 Harness 任务接力设计

## 目标

同一个 Host Thread 可以更换底层原生 Harness，同时保持工作目录、Host 对话、Review 记录和各 Harness 自己的原生 Session。接力不复制凭据、不代理权限决策；目标 Harness 必须自行验证工作区事实。

## 核心不变量

1. 目标 Harness 的原生 Session 连接成功前，不向用户报告切换成功。
2. 一个 Thread 同时只能存在一个待投递检查点，避免 A → B 尚未投递时又切到 C，导致来源血缘被覆盖。
3. 检查点是不可变、脱敏且带摘要哈希的；生命周期状态单独更新。
4. 首轮投递成功后才清除 `pendingHandoff`；失败时保留，以便安全重试或显式取消。
5. 自动回滚和显式取消都只恢复 Harness 路由与原生 Session，不回滚共享工作区里的文件。

## 状态机

```text
checkpoint-created
        |
        v
   connecting -------> rolled-back
        |
        v
      ready ----------> cancelled
        |
        v
   delivering -------> failed --(retry)--> delivering
        |
        v
      active
```

- `connecting`：已保存源 Session 引用，正在打开目标 Harness。
- `ready`：目标 Session 已连接，等待用户下一条真实消息。
- `delivering`：正在发送一次性接力信封和用户消息。
- `active`：目标 Harness 已接受首轮消息，接力完成。
- `failed`：发送失败；检查点和待投递状态保留。
- `rolled-back`：目标连接失败，Host 已自动恢复源 Harness。
- `cancelled`：用户在首轮投递前执行 `/switch cancel`。

## 切换事务

1. 从当前 Thread 创建脱敏检查点。
2. 保存源 Harness 的 `nativeSessionId`、Session 文件、模型和原生选项。
3. 持久化 `pendingHandoff`，阶段设为 `connecting`。
4. 打开目标 Harness 的原生 Session。
5. 成功后进入 `ready`；失败则关闭目标、恢复源引用并重新打开源 Session。
6. 下一条真实消息把检查点摘要作为不可见信封发送；成功进入 `active`，失败进入 `failed`。

## 接力模式语义

- `continue`：从核验后的状态和未完成工作继续。
- `execute-plan`：读取检查点计划，逐项核对工作区后执行。
- `review`：先独立审查，不主动修改文件。
- `reanalyze`：独立重新分析，旧结论仅作证据。

模式会转成明确的首轮行为约束，而不只作为检查点元数据传递。

## 原生 UI 与协议

切换 RPC 返回检查点、源/目标 Harness 和阶段；Thread 投影中的 `pendingHarnessSwitch` 同样包含这些字段。现有原生命令菜单在待投递期间隐藏新的 `/switch` 候选，并提供 `/switch cancel`。不新增独立的协作面板。

## 验证范围

脚本回归覆盖正常切换、原生 Session 恢复、二次切换拦截、显式取消、目标连接失败回滚、发送失败保留检查点、持久化与四种模式约束。真实 Harness 的认证与 Desktop 重启流程仍需单独进行端到端验收。
