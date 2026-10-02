# Renderer 通道韧性设计与路线图

## 背景

渲染层扩展与 Codex Desktop 的集成依赖三类 Desktop 内部结构：

1. **React fiber 内部**（`__reactFiber$`、`memoizedState`、`updateQueue`）——用于发现请求管理器、composer 身份、草稿 id、原生控件。共 6 处。
2. **DOM 结构假设**（`[data-codex-composer-root]`、发送按钮启发式、portal 标记等 20+ 个选择器）。
3. **Desktop 请求管理器的方法补丁**（`sendRequest`/`prewarmThreadStart`/`sendAppServerResponse`/`observeCatalogThreads` 等 5 处）。

2026-09 的故障链（Desktop 26.917 开始在任务运行中重建 composer 子树 + 声明式路由目标失效 + 悬置状态无超时）证明：fiber 发现失败会让整个请求通道（所有权、目录、账号、可用性）断供，composer 卡死在 "Select model"。

## 已落地的分层防御（2026-09-29）

按优先级排序的请求路由：

1. policy 声明的 requestTarget（安装时捕获的 manager）
2. fiber 发现（从 composer editor 爬 hook 链）
3. window 暴露的已补丁 bridge（`__harnessmixRequestBridgeV1`，安装时快照）
4. **直连控制通道**（`__harnessmixSidecarRequestV1`，见下）

外加：路由按 hostId 过滤回退、目录/所有权错误重试阶梯（1s→20s）、悬置状态看门狗（3s 巡检 / 16s 上限重驱动）。

## 久置/睡眠场景的兜底（2026-09-30 实施）

长时间闲置（机器睡眠、Host 崩溃或被系统回收）后曾出现两类永久卡死：新会话模型列表停在
"Loading models..."，旧会话 turn 永不结算（"A prompt is already running for this session"）。
根因是 Host 边车死亡后整条通道永久断供。现已闭环：

- **Host 监督重启**（`local-sidecar.ts`）：controller 对 Host 子进程做有界退避重启
  （0.5s→60s 阶梯，稳定运行 60s 后归零），重启窗口内 `send()` 快速失败，交给渲染层重试阶梯消化。
- **桥接请求超时**（`renderer-draft-prewarm-runtime.ts`）：每个经 `enqueueBridgeRequest`
  发出的请求 60s 无响应即以错误结算，帧静默丢失不再悬挂 Desktop 自己的请求 promise；
  超时只结算孤儿请求，不连坐整个桥。
- **turn 结算合成**（同上）：桥跟踪 `turn/started`/`turn/completed` 通知，通道死亡时对仍在
  跑的桥接 turn 合成 `turn/completed`（status=failed）+ `thread/status/changed`（idle），
  与 Host 的终态投影契约一致，解除 composer 的 "already running" 闩锁。
- **看门狗覆盖 draft**（`renderer-binding-probe.ts`）：悬置扫描从仅 locked 阶段扩展到
  draft（新建任务）composer 的 loading/waitingForAdapter 悬挂——请求被顶替或帧丢失后
  "Loading models..." 不再无人重驱动。

## 直连控制通道（第一阶段，已实施）

sidecar 模式下页面中已存在一条与 Desktop 内部结构无关的 Host 通道：
CDP binding `__harnessmixSidecarSendV1` → desktop-controller → Host stdio；
返回帧经 CDP `Runtime.evaluate` → `__harnessmixSidecarReceiveV1` → 帧处理器。

## 自有 id 空间（第二阶段，2026-10-01 实施）

2026-10-01 实测坐实了第一阶段的结构弱点：Desktop 重建 composer 子树后更换 request
manager，policy 捕获的旧 request client 的 `enqueueRequest` 静默失效——dispatch 永不被
调用、帧永不发出，而 Host 侧对同一请求毫秒级返回 ready（流量日志可见），渲染层却把
catalog/ownership 重试阶梯烧穿，落进 "Models unavailable"/「权限不可用」终态。

现在 `harnessmix/*` 控制面请求（目录、所有权、可用性、账号、thread/list 合并）全部改走
自有 id 空间：`enqueueControlRequest` 自铸 `harnessmix/control-request/<handle>/<n>` id、
直写帧、在 `handleBridgeFrame` 中直接结算 promise，全程不经过 Desktop 的
`enqueueRequest`/`onResult` 注册表。`manager.sendRequest` 也被 patch：`harnessmix/*` 走
同一通道（模型客户端直接调 manager.sendRequest，Desktop 换 manager 后该调用曾直通官方
app-server 永不返回），其余方法原样透传。原生方法（`turn/*`、`thread/*`）继续走 Desktop
注册表——那是它们唯一的传输层，且新 manager 会自行重铸。回归测试覆盖「注册表死亡时
控制通道仍完整往返」与「manager 层 harnessmix/* 路由」。另：模型选择器 error 态现在把
`view.error` 渲染进菜单（此前只有悬停 tooltip），故障可直接从 UI 读出原因。

## 26.928 的 draft memo 契约漂移（2026-10-01 实测）

Desktop 26.928（10-01 上午自动更新）把 draft-settings memo 从 26.908 的 13 槽（id 在
slot 5==6）改成 14 槽（id 在 slot 3/6/7），`findComposerDraftIds` 的精确槽位匹配全部失配
→ draft 身份认不出 → 模型写回失败闭合 → 每个新任务 composer 卡在 "External
configuration could not be applied to the Composer"（即 "Models unavailable" +
「权限不可用」的第三层根因）。修复为布局无关识别：条目内恰好一个一致的
`client-new-thread:` id + 存在 draft-settings 形状对象（`{modelSettings,isManuallyChanged}`
或 `{draftSettings,isNewThreadDraft}`）即认定；只引用 id 而无 settings 对象的大 memo
（243/415 槽）被正确排除。13 槽与 7 槽旧契约保留向后兼容。

## 目录缓存与错误历史（2026-10-01，第二阶段收口）

修复三层之后仍有间歇性抖动（重试齿轮高频空转），为此落地两个不依赖任何 Desktop 内部
结构的页面级设施（`renderer-binding-probe.ts` 模块级，存活于整个页面生命周期）：

- **harness 目录缓存**：每次成功的 `harnessmix/harness/inspect`（status=ready）写入
  `hostId\0harnessId` 键的缓存（24h 上限）。目录刷新遇到传输层异常（超时、通道死亡、
  丢帧）时，若缓存可用则直接用缓存完成配置——composer 保持可用，后台重试阶梯继续刷新；
  Host 返回的真实非 ready 状态（未安装、未登录）仍如实报错，不用缓存掩盖。
- **错误历史**：目录/所有权失败与缓存回退事件记入 60 条滚动记录，通过
  `window.__harnessmixRendererDiagnosticsV1`（`recentErrors()` / `cachedHarnessInspections()`）
  读取——间歇性故障从此带有确切原因与时间戳，可经 CDP 或 DevTools 直接取证。


`installDraftPrewarmPolicyBridge` 现在在 window 上暴露：

```ts
__harnessmixSidecarRequestV1 = {
  hostId: string,
  send(method: "harnessmix/*", params): Promise<unknown>
}
```

实现复用既有的 `enqueueBridgeRequest` 帧机制（id 复用 Desktop 的 enqueueRequest 注册表，响应经 `bridge.onResult` 兑现）。该机制全程持有安装时捕获的对象句柄，**不经过任何 fiber 发现**。

约束：仅承载 `harnessmix/*` 控制面方法（所有权、目录、可用性、账号）。原生方法（`turn/*`、`thread/read` 等）必须继续走 Desktop 管理器——那是它们唯一的传输层。通知订阅（用量推送）在合成 target 上不可用，属可接受的降级。

## 第二阶段候选（部分已实施）

- ~~**自有 id 空间**~~：已于 2026-10-01 实施（见上节）。
- **状态推送 + 渲染层缓存**：Host 在 thread/started / 目录变化时主动推送，渲染层缓存 threadId→所有权、harnessId→目录；composer rebind 优先读缓存、RPC 仅在缓存缺失时发生——线程切换瞬间即达、离线可渲染。
- **重装循环解耦**：production-controller 的重装检测与 fiber 发现目前仍互相纠缠（FIND 回退读 window 暴露），manager 更换后可能在新旧对象间打转；可改为 controller 侧持有 channel 健康哨兵。
- **契约巡检自动化**：contract-audit 的计数器已能检测 DOM/fiber 漂移，可接入启动自检并在漂移时上报而非静默。

## 排队任务派发失败事故（2026-10-01 13:52，已修复）

用户在 turn 执行中把新消息排进队列（⏳ 草稿），turn 结束后派发报错、线程永久停在
"已处理 N 分钟"。取证链：Host 流量日志在 13:52:27 后零 inbound（连周期 usage/team
轮询都停了）而 outbound 增量流到 turn 自然结束；CDP 实测页面的
`__harnessmixSidecarSendV1` binding 调用成功但帧到不了 Host；控制器进程活着、attachment
门 5 秒无响应（串行队列卡在重试阶梯上）。

根因是**agent 目录版本偏斜打死了控制器重装**：renderer bundle 重建时加入了
`kimi-code`（页面 probe 上报 19 个 agent），而 `production-controller` 硬编码的
`enabledAgents` 还是 18 个。页面一次 reload 后 probe 按新 bundle 上报，
`validateBindingStatus` 的**集合全等**校验永远失败 → `ensureInstalled`/`createSession`
每次重装都在 `waitForBinding` 烧 90 秒后失败 → 恢复阶梯 30s→300s 无限空转，页面
binding 每次被失败重装的 `removeBinding` 孤儿化，渲染层→Host 请求通道整体断供。
次生伤害：控制器旧会话已被拆掉，Host 的 turn/completed 无法投递，composer 永远
"已处理"；队列消息经死通道派发失败，出现"重试"按钮。

修复（`renderer-cdp-control-session.ts` / `production-controller.ts`）：

- `validateBindingStatus` 改为**子集校验**：页面可以比控制器多知道 agent（bundle 比
  控制器新是合法滚动部署），只缺控制器期望的 agent 才算偏斜失败，且错误信息点名缺失
  agent（此前的 "invalid status" 无法定位）。
- `production-controller` 的 `enabledAgents` 补上 `kimi-code` 与 renderer 对齐。
- 失败重装不再孤儿化 binding：`installTarget` 失败路径把 `Runtime.addBinding` 还给
  仍存活的前一个连接（`#reinstall` 传入 previous），旧会话的转发能力得以保留。

彻底收口（同日实施）：

- **agent 清单单源化**：canonical 清单移入 `shared-contracts` 的 `RENDERER_AGENTS`
  （`renderer-agents.ts`），renderer 侧 `KNOWN_RENDERER_AGENTS` 与控制器
  `production-controller` 的 `enabledAgents` 都改为引用同一常量——同一次构建内两份
  清单结构上不可能再漂移；`DEFAULT_RENDERER_AGENTS` 仅保留 UI 默认排序，用
  `satisfies readonly RendererAgentId[]` 锁死成员集合。
- **旧 probe 自愈**：`installRendererBindingProbe` 不再无条件复用页面残留 probe——
  覆盖不了所需 agent 集合（bundle 比页面旧的反向偏斜）时 `dispose()` 重建，probe
  无法自述时保持保守复用。两个方向的版本偏斜都不再造成永久失败。
- **恢复失败可观测**：控制器 `recoverSession` 失败时打一行 console.error（含下次
  重试间隔），通道断供不再只能靠 Host 流量日志倒推。

## 验证手段

- 单测：`renderer-draft-prewarm-policy.test.ts`（通道 roundtrip / 非 harnessmix 拒绝 / dispose 清理）、`versioned-renderer-adapter.test.ts`（回退优先级 / 合成 target 稳定性 / sendRequest 转发）。
- 真机：CDP 注入演练——把 `policy.requestTarget` 改为抛错并删除 `__harnessmixRequestBridgeV1`，观察 probe 仍能完成目录/所有权 RPC（流量日志可见 `harness/inspect`、`thread/inspect` 持续）。
