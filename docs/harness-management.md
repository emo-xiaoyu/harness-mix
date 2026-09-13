# Harness 管理

入口：右上角「Harness 管理」、左下角设置，或 `Ctrl+,`。

## 连接

按当前适配器注册表检查本机安装状态，包括 CodeBuddy、Kiro CLI 和 Cursor CLI。检测不会发送用户消息；程序可用不等于账号已登录。Kiro/Cursor 提供官方安装链接与刷新检测，不猜测 npm 安装包。

CodeBuddy 的旧名称 Workbuddy 自动兼容，已有原生会话 ID 不变。配置路径、专用协议和验证边界见 [原生 ACP 适配说明](native-acp.md)。

## 账号

| Harness | 读取状态 | 管理方式 |
| --- | --- | --- |
| Codex | 原生 `account/read` | 原生 `account/login/start` 打开浏览器；支持取消、完成通知与退出登录 |
| Claude Code | 原生 `claude auth status --json` | 打开原生认证窗口执行 `claude auth login/logout`，完成后刷新 |
| Pi | 原生 RPC 模型目录中的供应商 | 打开 Pi 原生交互终端，使用 `/login` 与 `/logout` |
| DeepSeek Harness | 原生 Web Remote 模型目录中的供应商 | 在独立、安全隔离的应用窗口中打开 DSH 原生管理页面，进入设置管理供应商 |
| CodeBuddy / Kiro CLI / Cursor CLI | 可执行文件版本检测；打开会话后读取原生目录 | 在各自 CLI 完成原生登录，再刷新检测；不读取或复制登录凭据 |

Pi / DSH 显示「已配置」而非「已登录」，目录存在不能证明凭据通过在线验证。登录与配置仍使用原生程序自己的账号存储，Harness Mix 不复制账号密钥。Codex 例外地支持多个原生隔离档案：默认账号继续使用官方 Desktop 的 `CODEX_HOME`，附加账号各自由 Codex app-server 在独立 `CODEX_HOME` 内完成设备码登录、令牌刷新与额度读取；Harness Mix 只保存档案 ID、显示名和活动选择。

切换 Codex 账号只作用于下一条新任务，不会改写正在运行或已经创建的任务。附加账号的新任务通过 Codex Adapter 固定到创建时的账号档案，因此可以在编辑器账号菜单中无感换号，同时在「账号」设置页并行查看各账号的 5 小时/7 天额度和刷新时间。

修改登录前会检查该 Harness 是否有运行中的任务。Codex 登录连接保留至完成、取消或五分钟超时；关闭设置不会取消浏览器登录，应用退出会取消待完成的登录。

## 模型

- 按 Harness 读取原生模型目录，支持按名称和供应商筛选。
- 「保存为新对话默认」写入 Harness Mix 的本地非敏感偏好，刷新与重启后保留，不改写原生模型配置。
- 同名模型按供应商区分。默认选择只允许来自该 Harness 实际返回的目录。
- 「应用到当前对话」通过现有原生 `setModel` 链路执行；任务运行中不能切换。
- 选择「跟随原生默认」可清除 Harness Mix 的默认模型覆盖。
- 配置或登录完成后刷新状态和目录，使新的供应商与模型可见。

## 任务接力

已由 Harness Mix 管理的任务可以在同一个原生任务窗口中更换 Harness。点击输入框旁带接力角标的当前 Harness 图标，选择另一个可用 Harness；确认弹窗会显示接力方向，可选择“继续执行”“执行上一方案”“独立审查”或“重新分析”，并可勾选交接内容、填写可选说明。当前回合仍在运行时需要先停止或等待完成。

接力只关闭当前原生进程并更换底层原生会话，任务标题、可见对话、工作目录、文件变更和 Review 记录不变。Host 会在自己的数据目录中保存不可重放的脱敏检查点，包含对话、计划、标准化工具证据、Core 文件记录以及切换瞬间的 Git HEAD、状态和 Diff 摘要。目标 Harness 收到的下一条真实消息会附带紧凑摘要；支持原生 MCP 的 Harness 可通过只读、当前任务作用域的工具按需读取详细证据，不支持时会明确降级为有界摘要。目标仍需用自己的工具核对真实文件状态。切回用过的 Harness 时，支持恢复的适配器会恢复原生会话及其模型设置。

接力不会传递凭据、环境密钥、审批决定、待审批状态、原始 Tool Call ID 或 Harness 私有协议对象。目标 Harness 的权限请求仍由它自己重新发起，Host 不会自动批准或自动重放操作。

官方 Codex 任务由官方 app-server 直接拥有，不经过 HostRuntime，因此不会显示接力入口；需要使用 Harness Mix 管理的 `Codex（协作）` 才能参与这种跨 Harness 接力。`/switch <Harness 名> [备注]` 继续作为键盘快捷入口。

## MCP / Skills

设置页的「MCP / Skills」按 Harness 和作用域管理扩展。全局配置适用于该 Harness 的全部项目；项目配置按服务名覆盖全局配置。MCP 只保存 stdio 可执行文件与参数，禁止保存令牌、密码和环境变量。账号与凭据继续由原生 Harness 环境管理。

Harness Mix 不改写各 Harness 已有的 MCP 配置文件。启用的托管配置在新建、恢复、Fork 或回退后的下一次原生会话打开时，通过各 Harness 的原生会话配置接口传入。正在运行的会话不会热改配置。Claude Code 与 OpenCode 可返回原生连接状态和工具名称；其他已接入 Harness 会区分「已配置」「已传入会话」和「连接状态未报告」，不会把保存成功当成已连接。

Skills 从已确认的原生目录发现：Claude Code、Codex、Pi 和 OpenCode 支持全局或项目目录。安装只接受本机绝对目录、必须包含 `SKILL.md`，拒绝符号链接、同名覆盖、超过 10 MB 或 500 个文件的目录。停用会把整个技能目录移动到相邻的 Harness Mix 保留目录，恢复时原样移回；不删除技能内容。共享 `.agents/skills` 的修改会影响读取同一目录的 Harness。

当前 MCP 会话注入支持 Claude Code、Codex（协作入口）、OpenCode、Grok、Antigravity，以及使用通用 ACP 接入的 CodeBuddy、Kiro、Cursor、Qoder 和 Hermes。DSH 配置托管 MCP 后会使用其官方 ACP profile 打开该会话；未配置时仍走 Web Remote。Pi/OMP 的 MCP 扩展机制不是通用原生 MCP 声明，当前只保留已有协作工具注入；设置页会明确显示不支持。未确认原生技能目录的 Harness 不提供文件写入操作。

## 验证

```powershell
npm run test:native-ui
npm run test:integrations
npm run smoke:integrations-ui
npm run e2e:integrations
npm run smoke:native-ui
npm run e2e:native
```

`test:native-ui` 覆盖账号字段白名单、模型供应商身份、并发默认值保存、登录连接生命周期和设置页渲染逻辑。`smoke:native-ui` 使用 Electron 与模拟原生响应，检查 Renderer 注入及设置界面的关键交互。

`test:integrations` 覆盖作用域覆盖、持久化、敏感字段拒绝、原生状态投影和 Skills 安装/停用/恢复。`smoke:integrations-ui` 在隔离的 Electron Renderer 中执行设置页完整交互。`e2e:integrations` 默认使用 Claude Code 打开真实原生会话，验证 MCP 连接、工具发现和项目 Skill 加载；可用 `--harness=opencode` 等参数验证其他已安装 Harness。该验收不发送模型消息，也不会自动处理审批。

`e2e:native` 是只读协议验收：读取可用 Harness 与模型目录，不执行登录/退出或修改凭据。完整账号管理和 DSH 原生页面重开仍需在真实 Codex Desktop 重启验收中人工确认，不能由这条命令代替。
