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

## 直连控制通道（第一阶段，已实施）

sidecar 模式下页面中已存在一条与 Desktop 内部结构无关的 Host 通道：
CDP binding `__harnessmixSidecarSendV1` → desktop-controller → Host stdio；
返回帧经 CDP `Runtime.evaluate` → `__harnessmixSidecarReceiveV1` → 帧处理器。

`installDraftPrewarmPolicyBridge` 现在在 window 上暴露：

```ts
__harnessmixSidecarRequestV1 = {
  hostId: string,
  send(method: "harnessmix/*", params): Promise<unknown>
}
```

实现复用既有的 `enqueueBridgeRequest` 帧机制（id 复用 Desktop 的 enqueueRequest 注册表，响应经 `bridge.onResult` 兑现）。该机制全程持有安装时捕获的对象句柄，**不经过任何 fiber 发现**。

约束：仅承载 `harnessmix/*` 控制面方法（所有权、目录、可用性、账号）。原生方法（`turn/*`、`thread/read` 等）必须继续走 Desktop 管理器——那是它们唯一的传输层。通知订阅（用量推送）在合成 target 上不可用，属可接受的降级。

## 第二阶段候选（未实施）

- **自有 id 空间**：控制通道改用自己的请求 id + 独立响应分发（不依赖 Desktop bridge 对象的 enqueueRequest/onResult 注册表），彻底覆盖"Desktop 更换 manager 导致旧对象死亡"的场景。当前第一阶段依赖旧对象上的本地注册表仍然可用。
- **状态推送 + 渲染层缓存**：Host 在 thread/started / 目录变化时主动推送，渲染层缓存 threadId→所有权、harnessId→目录；composer rebind 优先读缓存、RPC 仅在缓存缺失时发生——线程切换瞬间即达、离线可渲染。
- **重装循环解耦**：production-controller 的重装检测与 fiber 发现目前仍互相纠缠（FIND 回退读 window 暴露），manager 更换后可能在新旧对象间打转；可改为 controller 侧持有 channel 健康哨兵。
- **契约巡检自动化**：contract-audit 的计数器已能检测 DOM/fiber 漂移，可接入启动自检并在漂移时上报而非静默。

## 验证手段

- 单测：`renderer-draft-prewarm-policy.test.ts`（通道 roundtrip / 非 harnessmix 拒绝 / dispose 清理）、`versioned-renderer-adapter.test.ts`（回退优先级 / 合成 target 稳定性 / sendRequest 转发）。
- 真机：CDP 注入演练——把 `policy.requestTarget` 改为抛错并删除 `__harnessmixRequestBridgeV1`，观察 probe 仍能完成目录/所有权 RPC（流量日志可见 `harness/inspect`、`thread/inspect` 持续）。
