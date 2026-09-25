# shared-contracts 行为规格（SPEC）

本文件是 `@harnessmix/shared-contracts` 包的**行为规格**，独立于任何具体实现。
公开 API 面（导出名）、校验语义、错误消息、编码格式在这里钉死；
实现可以更换，违反本规格即视为破坏性变更（需要 bump `WORKSPACE_CONTRACT_VERSION`）。

- 消费方式：renderer-extension 与 desktop-control 仅通过包门面 `@harnessmix/shared-contracts`
  与子路径 `@harnessmix/shared-contracts/version` 导入；模块内部文件名不是公开契约。
- 测试（`test/*.test.ts`）是本规格的可执行验收；错误消息字符串是可观测行为，保持逐字一致。
- TS 配置开启 `exactOptionalPropertyTypes`：可选字段类型必须区分「缺失」与「显式 undefined」，
  需要时用 `Omit<Infer, K> & { [k in K]?: T }` 形状修正 zod 推断。

## 1. version（子路径导出 ./version）

- `WORKSPACE_CONTRACT_VERSION = 1`（字面量常量）。

## 2. ids

五个品牌化（`.brand<T>`）字符串 schema，共享同一条规则：
trim 后非空，refine 消息 `"Identifier must not be empty or whitespace"`。

- `harnessIdSchema: HarnessId`
- `hostThreadIdSchema: HostThreadId`
- `hostTurnIdSchema: HostTurnId`
- `hostItemIdSchema: HostItemId`
- `hostInteractionIdSchema: HostInteractionId`

## 3. json-value

- 递归 JSON 类型：`JsonPrimitive = string|number|boolean|null`、`JsonArray`、`JsonObject`、`JsonValue`。
- `rejectExplicitUndefined(keys)`：superRefine 工厂。对每个 key，
  `Object.hasOwn(value,key) && value[key] === undefined` 时
  `addIssue({code:"custom", path:[key], message:"Explicit undefined is not valid JSON"})`。
- `jsonPrimitiveSchema: z.ZodType<JsonPrimitive>` = string|number|boolean|null 联合。
- 循环引用检测：基于 WeakSet 的迭代 DFS（进入压栈标记、离开出栈清除；任何异常按检出环处理），
  `z.custom` 消息 `"JSON value must not contain circular references"`。
- `jsonValueSchema = 循环检测.pipe(递归联合)`，其中递归联合为
  `lazy(() => primitive | array(自身) | record(string, 自身))`。
- `jsonArraySchema`、`jsonObjectSchema` 同样先过循环检测再分别 pipe array/record。

## 4. json-rpc

- `jsonRpcIdSchema` = `string | number(int)`。
- `jsonRpcErrorSchema`：`{code: int, message: string, data?: JsonValue}`
  catchall JsonValue，superRefine rejectExplicitUndefined(["data"])。
- 每种信封：`jsonrpc` 为 `literal("2.0").optional()`；不允许的字段用 `z.never().optional()`
  哨兵（presence 或显式 undefined 均失败）；对象 catchall JsonValue；
  rejectExplicitUndefined 列出全部可选/禁用字段：
  - `jsonRpcRequestSchema`：必有 `id`、`method(min 1)`；可选 `params`；禁 `result`、`error`。
    reject 列表 `["jsonrpc","params","result","error"]`。
  - `jsonRpcNotificationSchema`：禁 `id`；其余同 request。reject 列表 `["jsonrpc","id","params","result","error"]`。
  - `jsonRpcSuccessResponseSchema`：必有 `id`、`result`；禁 `method`、`params`、`error`。
    reject 列表 `["jsonrpc","method","params","error"]`。
  - `jsonRpcErrorResponseSchema`：必有 `id`、`error`；禁 `method`、`params`、`result`。
    reject 列表 `["jsonrpc","method","params","result"]`。
- `jsonRpcEnvelopeSchema` = 四者 union。

## 5. errors

- `harnessmixErrorSchema`：strictObject `{code: string min1, message: string min1,
  retryable: boolean, diagnostic?: string min1, stage?: string min1,
  durationMs?: int ≥0, stderrTail?: string min1}`，
  superRefine rejectExplicitUndefined(["diagnostic","stage","durationMs","stderrTail"])。
- `HarnessMixError` 类型用 Omit& 形状保持 exactOptionalPropertyTypes 语义。

## 6. native-refs

- 原生 id 基础规则：trim 非空，消息 `"Native identifier must not be empty or whitespace"`。
- `nativeSessionRefV1Schema`：strict `{harnessId, nativeSessionId, locator?: JsonValue,
  formatVersion: literal(1)}`，rejectExplicitUndefined(["locator"])；
  `NativeSessionRefV1` 用 Omit& 修正。`nativeSessionRefSchema`/`NativeSessionRef` 是它的别名。
- `nativeTurnRefV1Schema`：strict `{harnessId, nativeSessionId, nativeTurnKey, formatVersion: 1}`。
  `nativeTurnRefSchema`/`NativeTurnRef` 别名。
- `nativeCheckpointRefV1Schema`：strict `{harnessId, nativeSessionId, checkpointId,
  locator?: JsonValue, formatVersion: 1}`，reject(["locator"])；`NativeCheckpointRefV1` Omit&。
  `nativeCheckpointRefSchema`/`NativeCheckpointRef` 别名。

## 7. reasoning-transcript

- `REASONING_TRANSCRIPT_COMMAND = "thinking"`：Codex Desktop 只为 Command Execution
  lane 渲染文本，Reasoning 投影为携带该哨兵命令的 Command Execution。

## 8. external-thread-fork

- `externalThreadForkParamsSchema`：strict `{threadId: HostThreadId, lastTurnId: HostTurnId}`。
- `externalThreadForkResultSchema`：strict `{threadId: HostThreadId}`。

## 9. thread-usage

数值基元：非负 safe integer；有限非负 number；`[0,100]` 有限数（复用为百分比/窗口用量）。

- `threadUsageSnapshotSchema`：strict，全部可选：
  `inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
  reasoningOutputTokens, totalTokens, contextWindowTokens, contextUsedTokens,
  planSevenDayResetsAtUnix`（safe int）；
  `outputTokensPerSecond, totalCostUsd, totalCredits, contextUsagePercent,
  planFiveHourUsedPercent, planSevenDayUsedPercent`（有限非负数，后两个复用 [0,100]）；
  `planFiveHourResetsAtUnix`（safe int）；
  `cacheHitRatePercent`（[0,100]）。
  superRefine 规则（消息逐字）：
  1. 空对象失败 `"Thread Usage must contain a reliable field"`；
  2. `contextUsedTokens`/`contextWindowTokens` 必须同现，消息
     `"Thread Usage context fields must be provided together"`，path 指向缺失的一侧；
  3. `contextWindowTokens === 0` 失败，消息
     `"Thread Usage contextWindowTokens must be greater than zero"`；
  4. `planFiveHourResetsAtUnix` 出现则 `planFiveHourUsedPercent` 必须出现，消息
     `"Thread Usage planFiveHourResetsAtUnix must be provided with planFiveHourUsedPercent"`；
  5. 七天同理（`planSevenDayResetsAtUnix` / `planSevenDayUsedPercent`）。
- `accountCreditsProductUsageSchema`：strict `{product: string min1, usagePercent: [0,100],
  resetsAt?: string min1}`。
- `accountResetCreditsSchema`：strict `{availableCount: 正 safe int, nextExpiresAt?: string min1,
  expiresAt?: string[] min1 max32}`。
- `accountCreditsSnapshotSchema`：strict `{label?: string min1, usedPercent: [0,100],
  resetsAt?: string min1, periodType: enum("weekly","monthly","five_hour","seven_day","unknown"),
  productUsage?: 上述数组 min1, resetCredits?}`。
- `threadUsageInspectionParamsSchema`：strict `{threadId, refresh?: literal("exact")}`。
- `threadUsageInspectionSchema`：strict `{threadId, usage: snapshot|null,
  accountCredits?}`。

## 10. harness-accounts

- `harnessAccountSnapshotSchema`：strict `{email?: trim min1 max320, label?: trim min1 max256,
  plan?: trim min1 max128, status?: enum("ready","unconfigured","not_installed"),
  configHint?: max512, loginCommand?: max512, credits?: accountCreditsSnapshotSchema}`。
- `harnessAccountListParamsSchema`：strict `{}`。
- `harnessAccountListResultSchema`：strict `{accounts: (snapshot extend
  {harnessId: HarnessId, harnessName: string min1})[] max128}`。

## 11. harness-plugins

常量：`HARNESS_PLUGIN_API_VERSION=1`、`HARNESS_PLUGIN_MANIFEST_MAX_BYTES=32*1024`、
`HARNESS_PLUGIN_ICON_MAX_BYTES=128*1024`、`HARNESS_PLUGIN_LIMIT=128`。

- `harnessPluginIdSchema`：string min1 max128，regex `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`，
  refine 排除 `"codex"`（消息 `"The official Codex identity is reserved"`），pipe 到 harnessId 品牌。
- 相对资源路径规则：min1 max512，不含 `\`、NUL、`:`、`#`、`?`，不以 `/` 开头，
  路径段不得为 `..` 或空；消息 `"Plugin resources must be relative paths inside the plugin"`。
- 文档链接：`z.url()` 且 `^https:\/\/[^/?#@]+(?:[/?#]|$)`（无凭据 HTTPS），
  消息 `"Plugin documentation links must be credential-free HTTPS URLs"`。
- `harnessPluginManifestSchema`：strict `{manifestVersion: literal(1),
  id: pluginId, name: trim min1 max128, version: min1 max128,
  links?: strict{documentation?, installation?}, adapterApiVersion: 正 int,
  entry: 相对路径, icon?: 相对路径}`。
- `harnessPluginIconSchema`：max `ceil(ICON_MAX/3)*4 + 64`，
  regex `^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$`。
- `harnessPluginDescriptorSchema`：strict `{id, name, version, links?, icon?}`（无 entry）。
- `harnessPluginListParamsSchema`：strict `{}`；
  `harnessPluginListResultSchema`：strict `{plugins: descriptor[] max LIMIT}`。
- `harnessPluginConfigurationSchema`：strict `{version: literal(1),
  enabled: pluginId[] max LIMIT}` + 唯一性 refine
  （消息 `"Enabled plugin IDs must be unique"`，path ["enabled"]）。

## 12. harness-route

- `HARNESS_PLUGIN_ROUTE_PREFIX = "harnessmix/plugin-v1@"`；路由最大长度 4096。
- `harnessPluginRouteSchema`：strict `{harnessId: pluginId, model?: modelRef,
  thinkingOptionId?, permissionModeId?}`。
- `encodeHarnessPluginRoute(route)`：先 parse 校验；把 `JSON.stringify(parsed)` 的每个字符
  编为两位小写十六进制，前缀拼接返回。
- `decodeHarnessPluginRoute(value)`：非字符串或不带前缀 → `null`（null 表示「别的协议」）；
  超长或 payload 不满足 `^(?:[a-f0-9]{2})+$` → throw `"Invalid Harness plugin route"`；
  解码 JSON 后 parse 校验，再重编码比对（规范化检查）；
  任何失败最终都 throw `"Invalid Harness plugin route"`（非规范化路径的内部
  `"Noncanonical Harness plugin route"` 也被吞掉转为该消息）。

## 13. harness-commands

- 命令 id：trim min1 max128，regex `^[A-Za-z0-9._:-]+$`，brand `HarnessCommandId`。
- `harnessCommandDescriptorSchema`：strict `{id, invocation: min1 max128,
  label: trim min1 max128, description?: trim min1 max512, argumentMode: enum("none","text")}`。
- `harnessCommandCatalogSchema`：strict `{commands: descriptor[]}` + id 唯一性
  superRefine（消息 `"Harness command IDs must be unique"`，path ["commands", i, "id"]）。
- `harnessCommandsInspectParamsSchema`：strict `{harnessId}`；
  `threadCommandsInspectParamsSchema`：strict `{threadId}`。
- `threadCommandExecuteParamsSchema`：strict `{threadId, commandId, turnId?, arguments?: JsonObject}`。
- `threadCommandExecuteResultSchema`：strict `{accepted: literal(true), turnId}`。

## 14. thread-delegate

- 任务文本：trim min1 max8000。
- `threadDelegateParamsSchema`：strict `{threadId, harnessId, task}`。
- `threadMessageParamsSchema`：strict `{threadId, childThreadId, task}`。
- `threadDelegationResultSchema`：strict `{childThreadId, turn: loose{id, status: string}}`
  （turn 投影细节由通知流承载，结果只带身份）。

## 15. thread-harness-switch

- `harnessHandoffIntentSchema`：enum("continue","execute-plan","review","reanalyze")。
- `harnessHandoffIncludesSchema`：strict 五布尔 `{conversation, plan, evidence, files, unresolved}`。
- `threadHarnessSwitchParamsSchema`：strict `{threadId, harnessId: string min1,
  note?: max2000, intent?, includes?}`。
- `threadHarnessSwitchResultSchema`：strict `{threadId, checkpointId: min1,
  phase?: enum("ready","rolled-back","cancelled"), fromHarnessId?: min1, toHarnessId?: min1}`。

## 16. harness-permission-modes

常量：ID ≤128、label ≤256、description ≤1024、目录 ≤32。
非空文本基元：trim 非空，消息 `"Value must not be empty or whitespace"`。

- `harnessPermissionModeIdSchema`：非空文本 + max128 + regex `^[A-Za-z0-9._~-]+$`
  （消息 `"Permission Mode ID must use transport-safe characters"`）+ brand。
- `harnessPermissionModeSchema`：strict `{id, label, description?, dangerous?: boolean}`。
- `harnessPermissionModeCatalogSchema`：strict `{modes: mode[] min1 max32,
  defaultModeId}` + superRefine：id 唯一（`"Permission Mode IDs must be unique"`，
  path ["modes", i, "id"]）且 defaultModeId 必须在目录中
  （`"Default Permission Mode must exist in the catalog"`，path ["defaultModeId"]）。
- `threadPermissionModeSelectParamsSchema`：strict `{threadId, permissionModeId}`。

## 17. harness-models

常量：`HARNESS_MODEL_REF_MAX_LENGTH=512`、`HARNESS_MODEL_LABEL_MAX_LENGTH=256`、
`HARNESS_THINKING_OPTION_ID_MAX_LENGTH=128`、`THREAD_OWNERSHIP_LIST_MAX_LENGTH=100`。
非空文本基元同 §16。

- `harnessModelRefIdSchema`：非空文本 + max512 + regex `^[A-Za-z0-9._~-]+$`
  （`"Model Ref must use transport-safe opaque characters"`）+ brand；
  `harnessModelRefSchema`：strict `{id}`。
- `harnessThinkingOptionIdSchema`：同上模式 max128（`"Thinking option ID must use transport-safe characters"`）。
- `harnessResolvedModelLabelSchema`：非空文本 max256。
- `harnessThinkingOptionSchema`：strict `{id, label}`。
- `harnessModelSchema`：strict `{ref, label, resolvedModelLabel?,
  supportedThinkingOptionIds?: thinkingId[]}`。
- thinking 选项数组：id 唯一 refine（`"Thinking option IDs must be unique"`，path [i,"id"]）。
- `harnessModelCatalogSchema`：strict `{models: model[], defaultModel?: ref,
  thinkingOptions: options, defaultThinkingOptionId?}` + superRefine：
  - model ref 唯一（`"Model Catalog refs must be unique"`，path ["models",i,"ref","id"]）；
  - 每模型 supportedThinkingOptionIds 内部唯一
    （`"Supported Thinking option IDs must be unique per Model"`）且必须存在于目录
    （`"Supported Thinking option must exist in the catalog"`），
    path ["models",i,"supportedThinkingOptionIds",j]；
  - defaultModel 必须在 models 中（`"Default Model must exist in the Model Catalog"`）；
  - defaultThinkingOptionId 必须在 options 中（`"Default Thinking option must exist in the catalog"`）。
- `harnessPermissionModeScopeSchema`：enum("live","atCreate")；
  `permissionModeFixedAtCreate({permissionModeScope?}) === ("atCreate")`。
- 历史能力：strict `{fork, forkAcrossCwd, rollbackLastTurn}` + refine
  `forkAcrossCwd → fork`（消息 `"Cross-cwd Fork requires exact history Fork support"`，
  path ["forkAcrossCwd"]）。
- `harnessSessionCapabilitiesSchema`：strict `{configuration: strict{selectModel,
  selectThinkingOption, selectPermissionMode, permissionModeScope: scope.default("live")},
  history, workspace?: strict{git: literal(true), worktree: literal(true),
  finalDiff: literal(true), nativeDiff: boolean, nativePatch: boolean},
  subagents?: strict{observe, readTranscript}, autonomousTurns?: strict{observe}}`。
- `harnessConfigurationStateSchema`：strict `{effectiveModel?, resolvedModelLabel?,
  effectiveThinkingOptionId?, availableThinkingOptions?, effectivePermissionModeId?}` +
  superRefine：effectiveThinkingOptionId 与 availableThinkingOptions 同现时，
  有效项必须存在于可用列表（`"Effective Thinking option must be currently available"`）。
- `harnessModelSelectionStateSchema` / `HarnessModelSelectionState` 是它的别名。
- `harnessWebUiCapabilitySchema`：strict `{open: literal(true)}`。
- ready 检查：strict `{status: literal("ready"), catalog, permissionModes?,
  capabilities, webUi?}` + superRefine：`selectPermissionMode === Boolean(permissionModes)`
  （消息 `"Permission Mode catalog and capability must agree"`，path 指向缺失侧）。
- failed 检查：strict `{status: enum("notInstalled","unavailable","error"), error}`。
- `harnessInspectionSchema` = ready | failed union。
- `harnessInspectParamsSchema`：strict `{harnessId, cwd?: 非空 max16384, refresh?: boolean}`。
- `harnessWebUiOpenParamsSchema`：strict `{harnessId}`；`harnessWebUiOpenResultSchema`：strict `{}`。
- `threadModelSelectParamsSchema`：strict `{threadId, model}`；
  `threadThinkingSelectParamsSchema`：strict `{threadId, thinkingOptionId}`；
  `threadInspectionParamsSchema`：strict `{threadId}`。
- 线程检查 discriminatedUnion("owner")：
  - codex：strict `{owner: literal("codex"), accountId?: 非空, locked: literal(true)}`；
  - external：strict `{owner: literal("external"), harnessId: 非空 max256,
    transportModelId: 非空 max1024, effectiveModel?, resolvedModelLabel?,
    effectiveThinkingOptionId?, availableThinkingOptions?, effectivePermissionModeId?,
    history, workspace?: strict{hostManaged: literal(true),
      git: strict{available, root?, head?, branch?: string|null, dirty?, reason?:
        enum("not-a-git-repository","git-unavailable")},
      worktree: strict{available, active, branch?, root?},
      finalDiff: strict{available: literal(true), source: literal("snapshot")},
      nativeDiff, nativePatch}, usage?, accountCredits?, locked: literal(true)}`。
- `threadOwnershipListParamsSchema`：strict `{threadIds: threadId[] min1 max100}` +
  唯一性 refine（`"Thread ownership-list IDs must be unique"`，path ["threadIds",i]）。
- `threadOwnershipSchema` = discriminatedUnion("owner")：
  codex `{threadId, owner: "codex"}`；external `{threadId, owner: "external",
  harnessId: string max256 pipe harnessId}`。
- `threadOwnershipListResultSchema`：strict `{threads: ownership[] min1 max100}` +
  threadId 唯一 refine（`"Thread ownership-list results must be unique"`）。

## 18. harness-session-import

常量：ID ≤1024、cwd ≤16384、title ≤4096、单响应列表 ≤1000、默认分页 20、
updatedAt ≤ 8_640_000_000_000_000（wire 界，非存储界）。

- 非空文本基元：trim 非空（`"Value must not be empty or whitespace"`）且不含 NUL
  （`"Value must not contain NUL"`）。
- `harnessSessionImportIdSchema`：非空文本 max1024。
- `harnessSessionImportCandidateSchema`：strict `{nativeSessionId, title: 非空 max4096 | null,
  updatedAt: int ≥0 ≤MAX, cwd: 非空 max16384, running: boolean | null}`。
- `harnessSessionImportSourcesParamsSchema`：strict `{}`；
  `...SourcesResultSchema`：strict `{harnesses: strict{harnessId: pluginId,
  name: 非空 max128}[] max128}`。
- `harnessSessionListParamsSchema`：strict `{harnessId: pluginId,
  query?: string trim max4096 无 NUL, offset?: int ≥0 safe, limit?: int [1,1000]}`。
- `harnessSessionListResultSchema`：strict `{candidates: candidate[] max1000,
  total: int ≥0 safe}`。
- `harnessSessionImportParamsSchema`：strict `{harnessId: pluginId, nativeSessionId}`。
- `harnessSessionImportResultSchema`：strict `{threadId: 非空 max1024 pipe hostThreadId}`。

## 19. deepseek-modern-sessions

- 常量逐一等于 §18 对应值；额外 `DEEPSEEK_MODERN_HOST_THREAD_ID_MAX_LENGTH = 1024`。
- `deepSeekModernSessionCandidateSchema` = `harnessSessionImportCandidateSchema`（同一 schema）。
- `deepSeekModernSessionListParamsSchema`：strict `{}`；
  `...ListResultSchema`：strict `{candidates: candidate[] max LIST_MAX}`。
- `deepSeekModernSessionImportParamsSchema`：strict `{nativeSessionId}`；
  `...ImportResultSchema`：strict `{threadId: 非空 max1024 pipe hostThreadId}`。

## 20. codex-accounts

- accountId：min1 max256 regex `^[A-Za-z0-9._~-]+$`；非空文本基元：`z.string().trim().min(1)`。
- `codexAccountPlanTypeSchema`：enum 16 值（free, go, plus, pro, prolite, team,
  self_serve_business_prolite, self_serve_business_usage_based, business, ent26,
  enterprise_cbp_automation, enterprise_cbp_usage_based, enterprise, edu, edu_plus,
  edu_pro, unknown）。
- `codexAccountSchema`：strict `{accountId, label: 非空 max256,
  email?: z.string().email() max320, planType?, codexHome: 非空 max16384,
  active, isDefault, authenticated?, management?: enum("native","isolated")}`。
- `codexAccountListResultSchema`：strict `{accounts: account[] max128}`。
- create：strict `{label?: 非空 max256}`；activate/delete：strict `{accountId}`；
  delete result：strict `{deletedAccountId}`；mutation：strict `{account}`。
- login start：strict `{accountId}` → strict `{accountId, loginId: 非空 max1024,
  verificationUrl: z.string().url() max16384, userCode: 非空 max1024}`。
- login cancel：strict `{accountId?, loginId: 非空 max1024}` → strict `{cancelled: boolean}`。
- `codexAccountLoginCompletedSchema`：strict `{accountId, loginId, success: boolean,
  error: string max4096 | null}`。
- usage：strict `{accountId}` → strict `{accountId, usage: threadUsageSnapshot | null,
  accountCredits?}`。
- reset-credit consume：strict `{accountId, idempotencyKey?: z.string().uuid()}` →
  strict `{accountId, outcome: enum("reset","nothingToReset","noCredit","alreadyRedeemed"),
  accountCredits?}`。

## 21. updates

- `UPDATE_ERROR_MAX_LENGTH = 500`；
  `UPDATE_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u`。
- `updateSemanticVersionSchema`：string regex 上述。
- `updateInstallationSchema`：enum("npm","windows-installer","macos-dmg")；
  `updatePhaseSchema`：enum("prepared","downloading","waiting-for-exit","installing",
  "restarting","succeeded","failed")。
- `updateStatusSchema`：strictObject `{version, installation, phase,
  updatedAt: int ≥0, downloadedBytes?: int ≥0, totalBytes?: int >0,
  error: string[1,500] | null}` + superRefine downloadedBytes ≤ totalBytes
  （消息 `"downloadedBytes must not exceed totalBytes"`，path ["downloadedBytes"]）。
- `updateEmptyParamsSchema`：strictObject `{}`。
- release notes URL：string max300 regex
  `^https:\/\/github\.com\/emo-xiaoyu\/harness-mix\/releases\/tag\/v[0-9A-Za-z.+-]+$`，
  消息 `"release notes URL must identify a Harness Mix GitHub Release"`。
- `updateCheckResultSchema`：strictObject `{currentVersion, installation | null,
  latestVersion | null, updateAvailable, installationAvailable,
  releaseNotes: string[1,20000] | null, releaseNotesUrl: 上述 | null,
  status: updateStatus | null, error: string[1,500] | null}`。
- `updateStartResultSchema`：strictObject `{status}`；
  `updateStatusResultSchema`：strictObject `{status | null}`。

## 22. index（门面）

- 按 `index.ts` 现有导出清单**逐一重导**（值导出与类型导出均不可增删改名）。
- 额外两个门面自有导出：
  - `workspaceContractVersionSchema = z.literal(WORKSPACE_CONTRACT_VERSION)`；
  - `packageMetadata = { name: "@harnessmix/shared-contracts",
    contractVersion: WORKSPACE_CONTRACT_VERSION } as const`。
- 包必须保持浏览器可打包（esbuild 无外部依赖，仅 zod）。
