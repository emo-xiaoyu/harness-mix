# desktop-control 行为规格（SPEC）

本文件是 `@harnessmix/desktop-control` 包的**行为规格**，独立于实现。运行时契约分三层：

1. **进程契约**：`release-main.ts` 经 esbuild 打包为 `desktop-controller.mjs`，由
   launcher 以 `--renderer-cdp-endpoint <http://127.0.0.1:port> --renderer <绝对路径>
   --default-agent codex|pi --attachment-port <1-65535> --attachment-nonce <32位小写hex>`
   拉起；就绪时向 stdout 写一行 `{"schemaVersion":2,"state":"compatible","issues":[]}`
   （≤512 字节）；SIGINT/SIGTERM 优雅退出。
2. **导出面**：index.ts 的导出集合（测试与包内消费方依赖）。
3. **注入载荷**：见下文「协议载荷」——它们的源文本通过 `.toString()` 序列化后送入
   Codex Desktop 进程执行，**文本即线协议**，按常量对待，不随实现重写。

测试（`test/*.test.ts`，约 3.1k 行）是可执行验收；错误消息与超时/轮询常量是可观测行为。

## 协议载荷（wire payloads —— 文本即行为）

以下函数/表达式在远端进程内执行，必须逐字保持（改动 = 协议变更，需对真实桌面 e2e 验证）：

- `main-process-title-policy.ts` 的 `INSTALL_POLICY_FUNCTION`：注入 Electron 主进程，
  包装 `createAppHost` 与 `threadMetadataGeneration` 服务（所有权标记、
  locked-selection 门控的标题/描述生成、计数器、可逆 dispose）。
- `renderer-draft-prewarm-runtime.ts` 的 `installDraftPrewarmPolicyBridge`：
  注入渲染进程的请求路由桥（harnessmix/ 官方双路由、thread 所有权解析、
  remote-control PowerShell 桥、本地 sidecar 桥、prewarm 路由规则、
  26.917 `sendAppServerResponse`/旧名 `dispatchAppServerResponse` 双兼容）。
- `renderer-draft-prewarm-policy.ts` 的 `FIND_REQUEST_MANAGER_EXPRESSION`
  （React fiber 遍历发现请求管理器）、`INSTALL_RENDERER_POLICY_FUNCTION`。
- `renderer-dom.ts` 的 DOM 遍历表达式；`contract-audit.ts` 的 electron 模块解析
  表达式与只读审计执行器；`renderer-control-session.ts` /
  `main-process-title-policy.ts` 的 electron 模块解析表达式、webContents
  盘点/激活/执行表达式、就绪标记表达式。
- `production-controller.ts` 的 `RENDERER_CSP_BOOTSTRAP` 与
  `__harnessmixProductionConfigV1` 配置注入串。
- 渲染侧全局键名：`__harnessmixRendererBindingProbeV1`、`__harnessmixSidecarSendV1`、
  `__harnessmixSidecarReceiveV1`、`__harnessmixSidecarModeV1`、
  `__harnessmixProductionConfigV1`、`__harnessmixDraftPrewarmPolicyV1`、
  `__harnessmixMainProcessTitlePolicyV1`、`__harnessmixContractAuditV1`。
- Electron IPC 频道 `codex_desktop:connect-app-host`；Symbol 键
  `harnessmix.main-process-title-policy.v1` / `.owner.v1`；
  事件 `harnessmix:draft-prewarm-policy-changed`。

## cdp-client

- 目标/版本发现的 HTTP 端点与 WS URL 都强制回环主机（127.0.0.1/localhost/[::1]）与
  正确协议；目标字段缺失报 `CDP target '<field>' must be non-empty text`。
- `waitForRendererTarget`：轮询 `/json/list`（默认 250ms/30s）找 `type === "page"` 且
  url 以 `app://` 开头的目标。
- `CdpClient.connect`：WS 连接（默认连接超时 10s）、命令自增 id、命令超时（默认 10s）、
  事件订阅（method→listeners，sessionId 透传）、`evaluate`（awaitPromise+returnByValue，
  exceptionDetails → throw，无 value → throw）、关闭时全部 pending 拒绝。
  二进制帧（ArrayBuffer/TypedView）解码为文本。

## local-sidecar

- `createSidecarFrameBuffer(limit=256)`：无监听时缓存帧；满时优先丢弃非 server-request
  帧（`{id,method}` 判定），全是请求帧且新帧也是请求帧时丢弃新帧。
- `startLocalSidecar(node, script, stockCodexPath)`：spawn `node script app-server
  --listen stdio://`，env 带 `HARNESSMIX_STOCK_CODEX_PATH`/`HARNESSMIX_SIDECAR=1`、
  删除 `CODEX_CLI_PATH`；stdout 逐行发布；失败帧 `{harnessmixSidecarFailure}`；
  close 时 stdin.end + 5s 宽限后 kill。

## controller-attachment-server

- 回环 TCP；请求上限 96 字节；5s 空闲销毁；行 `ATTACH <nonce>`（\r 容忍）→
  执行 attach 回调，回写 `ready`/`rejected`/`failed`；端口与 nonce 校验消息固定。

## renderer-dom

- `inspectRendererDom(client)`：执行协议载荷表达式后用 `validateRendererDomInspection`
  校验（totalNodes 非负整数、nodeNameCounts 整数表、shadowRoots open 型、
  editor/sendButton 候选的字符串数组字段）。

## contract-audit

- `DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION = 1`；`validateRendererContractAuditInspection`
  严格键集合校验 + 各分组非负整数 + production 状态枚举/64 字节 reason 上限。
- `inspectDesktopContracts`：并行取浏览器版本与 inspector 目标 → 连接 →
  Runtime.enable → 盘点 webContents → 选主渲染器 → 经 webContents.executeJavaScript
  执行 `window.__harnessmixContractAuditV1` 审计（保存/恢复/清理全局键）→ 校验返回。

## main-process-title-policy（宿主侧）

- `installMainProcessTitlePolicy(inspector, id)`：经 IPC listener → `[[Scopes]]` →
  local scope → `f`（getContextForWebContents）→ `Runtime.callFunctionOn` 安装载荷 →
  awaitPromise → 校验 `{state:'ready',reason:'ready',requiresRendererReload:true}` 恰好三键。
- `markRendererTitlePolicyReady` / `readMainProcessTitlePolicyCounters`：执行对应
  表达式并校验返回形状。

## renderer-draft-prewarm-policy（宿主侧）

- `selectRendererRequestManager`：按 manager 去重；活跃 hostId（非空字符串）超过 1 个
  → null；仅当（无活跃 host 或 hostId 匹配的）候选恰有一个时返回它。
- `rendererRequestManagerFromHook`：接受裸 manager 或 `{manager,status:'ready',hostId}`
  快照（26.908+），校验五个必需方法形状。
- `installRendererDraftPrewarmPolicyDirect(renderer)`：直接在渲染进程执行安装，
  `Renderer request manager is ambiguous` 时以 25ms 轮询重试至 60s。
- `installRendererDraftPrewarmPolicy(inspector, id)`：经主进程载荷安装（webContents
  debugger attach("1.3") → Runtime.enable → evaluate 发现 → getProperties 解构 →
  callFunctionOn 安装，finally 解除自己附加的 debugger）。
- 成功状态恰为 `{state:'ready',reason:'owned-request-bridge'}`。

## renderer-cdp-control-session

- `selectPrimaryRendererTarget`：`type==='page'` 且 url 为 `app://-/index.html`
  （无 search/hash）；优先 preferredTargetId，否则第一个。
- 安装流程：connect → Runtime.enable + Page.enable →（sidecar 存在时）
  `Runtime.removeBinding`(容错)+`addBinding` `__harnessmixSidecarSendV1` +
  `Runtime.bindingCalled` 转发与回推 `__harnessmixSidecarReceiveV1` →
  `Page.addScriptToEvaluateOnNewDocument` + 立即求值 rendererSource →
  安装 prewarm 策略 → 轮询 binding ready。
- binding 校验：version 2、enabledAgents 集合等价（无序）、adapter ready；
  非 installing 的 readiness 错误立即抛出（`RendererAdapterReadinessError`）。
- `ensureInstalled`：目标变化或读 binding 失败 → 整体重装；否则仅补装。
- `activateDesktop`：`Page.bringToFront`，返回 1。

## renderer-control-session

- `selectRendererWebContents`：window+primary+可用+elementCount 非空，按 elementCount
  降序，preferred 优先，要求 elementCount>0。
- `inspectElectronWebContents` / `activateElectronDesktop`：执行协议载荷并校验形状
  （激活要求 ≥1 个存活窗口）。
- 首装流程：waitForRenderer → 安装 title policy → reload → 再 waitForRenderer →
  等 title-policy readiness → activateDesktop → 注入 rendererSource → 安装 prewarm
  → 等 binding ready。
- `ensureInstalled`：已有 binding → 仅校验/补装（readiness 错误时重注入）；
  无 binding → 走完整首装路径（含 reload 语义由 titlePolicyReadiness 等待承载）。

## production-controller

- `parseDesktopControllerArguments`：五个参数各自唯一、格式校验（endpoint 规格化为
  loopback HTTP origin；renderer 必须绝对路径并 normalize；agent 枚举；端口整数；
  nonce 32 位小写 hex），未知参数报错。
- `serializeDesktopControllerReadiness`：恰三键且值固定，≤512 字节。
- `runDesktopController`：env 存在 `HARNESSMIX_SIDECAR_SCRIPT`+
  `HARNESSMIX_STOCK_CODEX_PATH` 时启动本地 sidecar；renderer 源前置 CSP bootstrap +
  配置注入；enabledAgents 全目录；90s 安装超时；瞬时错误
  （Execution context was destroyed / Promise was collected，含 cause 链 ≤4 层）
  重试 3 次（间隔 250ms）；恢复退避 30s 起、×2、上限 300s；附件服务器 attach →
  串行化队列（useSession）内恢复会话并 activateDesktop；监控循环默认 500ms；
  结束时按序关闭附件服务器、排空操作、关闭会话与 sidecar。
- `HARNESSMIX_STARTUP_TRACE=1` 时向 stderr 输出启动跟踪。

## index 门面

- 导出集合与现行 index.ts 一致（含 `packageMetadata`
  `{name:"@harnessmix/desktop-control", contractVersion:WORKSPACE_CONTRACT_VERSION}`）。
