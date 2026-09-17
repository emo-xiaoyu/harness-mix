# Harness Mix

macOS/Linux 已加入源码构建与启动适配；目标系统的完整桌面验收仍需在对应机器执行。安装方式、Linux 桌面前提和支持边界见 [跨平台指南](docs/cross-platform.md)。

<p align="center">
  <img src="src/assets/brand-harness-mix.png" width="92" alt="Harness Mix logo">
</p>

<p align="center">
  ⭐ 如果这个项目对你有帮助，请给我们一个 <a href="https://github.com/emo-xiaoyu/harness-mix">Star</a>！ ⭐
</p>

<p align="center">
  <a href="https://linux.do/"><img alt="Linux DO" src="https://img.shields.io/badge/Linux%20DO-%E7%A4%BE%E5%8C%BA-0A66C2.svg"></a>
</p>

<p align="center"><strong>Codex 原生 UI，连接多个原生 Coding Harness，并让任务在它们之间无缝接力。</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="UI" src="https://img.shields.io/badge/UI-Codex%20Desktop-412991.svg">
  <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-0078D4.svg">
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-555555.svg">
  <img alt="Linux" src="https://img.shields.io/badge/platform-Linux-FCC624.svg">
</p>

<p align="center"><strong>当前注册的 Harness（17 个）</strong></p>

<table align="center">
  <tbody>
    <tr>
      <td align="center"><img src="src/assets/icons/antigravity-color.svg" width="28" height="28" alt="Antigravity"><br><sub>Antigravity</sub></td>
      <td align="center"><img src="src/assets/icons/codex-harness.svg" width="28" height="28" alt="Codex"><br><sub>Codex</sub></td>
      <td align="center"><img src="src/assets/icons/claude-color.svg" width="28" height="28" alt="Claude Code"><br><sub>Claude Code</sub></td>
      <td align="center"><img src="src/assets/icons/pi.svg" width="28" height="28" alt="Pi"><br><sub>Pi</sub></td>
    </tr>
    <tr>
      <td align="center"><img src="src/assets/icons/omp-color.svg" width="28" height="28" alt="Oh My Pi"><br><sub>Oh My Pi</sub></td>
      <td align="center"><img src="src/assets/icons/deepseek-color.svg" width="28" height="28" alt="DeepSeek Harness"><br><sub>DeepSeek</sub></td>
      <td align="center"><img src="src/assets/icons/opencode-color.svg" width="28" height="28" alt="OpenCode"><br><sub>OpenCode</sub></td>
      <td align="center"><img src="src/assets/icons/grok-color.svg" width="28" height="28" alt="Grok"><br><sub>Grok</sub></td>
    </tr>
    <tr>
      <td align="center"><img src="src/assets/icons/openclaw-color.svg" width="28" height="28" alt="OpenClaw"><br><sub>OpenClaw</sub></td>
      <td align="center"><img src="src/assets/icons/hermes-color.svg" width="28" height="28" alt="Hermes"><br><sub>Hermes</sub></td>
      <td align="center"><img src="src/assets/icons/qoder-color.svg" width="28" height="28" alt="Qoder"><br><sub>Qoder</sub></td>
      <td align="center"><img src="src/assets/icons/codebuddy-color.svg" width="28" height="28" alt="CodeBuddy"><br><sub>CodeBuddy</sub></td>
    </tr>
    <tr>
      <td align="center"><img src="src/assets/icons/kiro-cli-color.svg" width="28" height="28" alt="Kiro"><br><sub>Kiro</sub></td>
      <td align="center"><img src="src/assets/icons/cursor.svg" width="28" height="28" alt="Cursor"><br><sub>Cursor</sub></td>
      <td align="center"><img src="src/assets/icons/zcode-color.svg" width="28" height="28" alt="ZCode"><br><sub>ZCode</sub></td>
      <td align="center"><img src="src/assets/icons/trae-color.svg" width="28" height="28" alt="Trae"><br><sub>Trae</sub></td>
    </tr>
    <tr>
      <td align="center"><img src="src/assets/icons/cline-color.svg" width="28" height="28" alt="Cline"><br><sub>Cline</sub></td>
    </tr>
  </tbody>
</table>

<p align="center"><sub>图标与 Harness 能力均来自项目自身的注册表；只有本机已安装且握手成功的 Harness 才会进入真实运行。</sub></p>

Harness Mix 是接入官方 Codex Desktop 原生界面的本地内核。它通过本地编译的 CLI Shim 对接桌面的 app-server 协议，把包括 Antigravity、Codex、Pi、Oh My Pi、Claude Code、DeepSeek Harness、OpenCode、Grok、OpenClaw、Hermes、Qoder、CodeBuddy、Kiro CLI、Cursor CLI、ZCode、Trae 和 Cline 在内的原生 Coding Harness 接入同一套 UI。Host Runtime 与 Protocol Core 管理任务映射、协作和事件投影；模型调用、工具执行、原生会话与凭据仍由各 Harness 自己管理。

## 界面预览

<p align="center">
  <img src="docs/images/codex-desktop-home.png" width="960" alt="Codex Desktop 原生首页中的 Harness Mix">
</p>

预览来自当前 Codex Desktop 原生窗口：Harness Mix 作为原生扩展入口出现在桌面工具栏和 Composer 中，会话、模型、工具与权限仍由 Codex Desktop 及各 Harness 管理。

| 功能模块 | 核心能力 | 交互入口与特点 |
| :--- | :--- | :--- |
| **🔄 跨 Harness 任务接力** | 4 种接力模式（继续执行 / 执行计划 / 独立审查 / 重新分析）平滑交接 | 输入框接力角标 / `/switch`；持久化脱敏检查点与证据追溯 |
| **🎨 皮肤市场** | 内置 HeiGe 与 Codex Styler 主题，支持亮色 / 暗色、背景装饰和可读性保护 | 设置 → 皮肤；一键预览、应用和恢复原生外观 |
| **📚 历史会话导入与引用** | 一键导入 Pi / Claude / Codex / CodeBuddy 原生历史并可中断续跑；`#` 引用任意旧会话注入脱敏上下文 | 引用仅预取最近一页；MCP 只读工具 `get_session_info` / `list_session_messages` 供 Harness 按需翻页与读取分支 / 模型 / 用量元数据 |
| **🤝 多 Agent 协同编排** | 输入 `#` 唤起目标 Harness，胶囊标签直观管理，主控强约束派发 | 输入框 `#` 菜单；支持循环审查验证、子任务级联取消与超时熔断 |
| **🧩 原生 Skills 管理** | 全量覆盖 17 个 Harness 原生技能目录，会话启动自动预建根目录 | 设置 → Skills；支持单个 `SKILL.md` 或完整文件夹直接拖拽安装 |
| **🛠️ 原生 MCP 扩展** | 支持本地 stdio 与远程 Streamable HTTP / SSE 协议 | 设置 → MCP；支持自定义 Header 传递，按 Harness 独立生效 |
| **📋 原生消息队列** | 完整接入 Codex 会话排队机制（增删改查、排序、插队抢占与自动排空） | 原生 Composer 队列；当前回合完成后自动顺序调度执行排队消息 |
| **✅ 可配置验证门禁** | 任务级 off / advisory / required 策略，内置一致性检查与自定义验证命令 | 命令面板 `/gate`、`/verify`；强制模式保护隔离分支合并与推送 |
| **💾 会话存储治理** | schema v3 分片惰性加载、无损紧凑存储、迁移备份与体积诊断 | 冷启动只读任务索引；打开任务时才恢复对应 Core checkpoint |
| **🩹 失败分类与恢复** | 失败回合归类为连接 / 登录 / 额度 / 被拒 / 服务异常五类，分类来自原生结构化错误（Codex `codexErrorInfo` 透传）、状态码或消息特征，无法归类时诚实标注 unknown | 错误状态随任务投影；Renderer 可查 `harnessmix/harness/turn-error` 获取分类与动作（重试 / 去登录 / 新建会话），login 按钮按 Harness 真实登录能力出现 |
| **🌐 ChatGPT 侧边栏桥接** | 安全脱敏提取当前会话上下文并一键生成结构化草稿 | Web 快捷聊天面板；直通注入 ChatGPT，实现跨工具无缝协作 |
| **👤 账户与用量隔离** | Codex 多账户隔离与即时切换；实时追踪 Token / Credits 用量 | 原生侧边栏与设置面板；各 Harness 凭据、模型与审批原生自理 |

### 🎨 皮肤市场预览

主题资源随项目发布，图片直接使用仓库内的授权素材；应用皮肤只改变视觉层，不改变 Codex 原生交互和 Harness 执行行为。

<table align="center">
  <tr>
    <td align="center"><img src="src/assets/skins/heige/themes/miku-488137/hero.webp" width="360" alt="Miku 主题"><br><sub>🎀 Miku</sub></td>
    <td align="center"><img src="src/assets/skins/heige/themes/genshin-night/hero.webp" width="360" alt="Genshin Night 主题"><br><sub>🌌 Genshin Night</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="src/assets/skins/heige/themes/deepspace-star/hero.webp" width="360" alt="Deepspace Star 主题"><br><sub>🌠 Deepspace Star</sub></td>
    <td align="center"><img src="src/assets/skins/heige/themes/wuthering-tide/hero.webp" width="360" alt="Wuthering Tide 主题"><br><sub>🌊 Wuthering Tide</sub></td>
  </tr>
</table>

## 原生 Harness 功能支持矩阵

> 💡 **设计原则**：所有能力严格在 Adapter `manifest` 中诚实声明，界面按真实能力渲染，不依靠名称猜测。凭据、模型、工具与权限审批始终由原生 Harness 独立掌控。

| Harness | 原生接入协议 | 流式输出 | 思考推理 | 工具审批 | 用户提问 | 会话恢复/Fork | 图片附件 | 原生 Skills | MCP 扩展 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity** | `agy` CLI (`stream-json` / Hook) | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ✅ |
| **Codex** | `codex app-server --stdio` | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ✅ |
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ✅ |
| **Pi** | `pi --mode rpc` | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ➖ |
| **Oh My Pi** | `omp --mode rpc` (`pi-family.js`) | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ➖ |
| **DeepSeek** | 普通 Web Remote / 协作 ACP | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ✅ |
| **OpenCode** | `opencode serve` (HTTP / SSE) | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ✅ |
| **Grok** | `grok agent stdio` (`_x.ai/*`) | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ | ✅ |
| **OpenClaw** | Gateway WebSocket Loopback | ✅ | ➖ | ✅ | ➖ | ✅ / ➖ | ✅ | ✅ | ➖ |
| **Hermes** | `hermes acp` | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ➖ | ✅ | ✅ |
| **CodeBuddy** | `codebuddy --acp` (`_codebuddy.ai/*`) | ✅ | ✅ | ✅ | ✅ | ✅ / ➖ | ✅ | ✅ | ✅ |
| **Kiro CLI** | `kiro-cli acp` (`_kiro/*`) | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ | ➖ | ✅ | ✅ |
| **Cursor CLI** | `cursor-agent acp` (`cursor/*`) | ✅ | ✅ | ✅ | ✅ | ✅ / ➖ | ➖ | ✅ | ✅ |
| **Qoder** | `qoder --acp` | ✅ | ➖ | ✅ | ➖ | ✅ / ➖ | ✅ | ✅ | ✅ |
| **ZCode** | 兼容 ACP 桥接程序 | ✅ | ➖ | ✅ | ➖ | ✅ / ➖ | ➖ | ✅ | ✅ |
| **Trae** | 兼容 ACP 桥接程序 | ✅ | ➖ | ✅ | ➖ | ✅ / ➖ | ➖ | ✅ | ✅ |
| **Cline** | `cline --acp` | ✅ | ✅ | ✅ | ➖ | ✅ / ➖ | ✅ | ✅ | ✅ |

<sub>注：✅ 为原生支持并已打通；➖ 为上游协议当前未开放或未声明；只有本机已安装且握手成功的 Harness 才会进入真实运行。详见 [原生 ACP 深度适配](docs/native-acp.md) 与 [Harness 管理说明](docs/harness-management.md)。</sub>

## 核心功能特色

### 🔄 跨 Harness 任务接力（Task Handoff）
一个 Harness 负责深入分析，另一个编写具体实现，再切回原 Harness 交叉复核——整个过程无缝保留在同一个 Codex Desktop 原生窗口中：
- **现场完整保留**：保留对话历史、未提交代码改动、Git 状态与 Review 记录。
- **持久化检查点**：创建带哈希的接力快照，自动脱敏测试证据与敏感密钥，支持随时暂停与恢复。
- **独立会话恢复**：每个 Harness 的原生 Session 与参数独立保存，切回时调用其原生恢复机制（如 Pi `--session` 或 Claude `resume`）。
- **四种接力方式**：支持「继续执行」、「执行上一方案」、「独立审查」与「重新分析」。

### 🤝 多 Agent 协同编排（Multi-Agent Collaboration）
- **触发符解耦**：在原生输入框输入 `#` 调出协同菜单（`#pi`、`#claude`、`#codex`、`#dsh`），完全保留官方 `@` 菜单给 Codex 原生功能。
- **标签可视化**：已选协同 Agent 在输入框顶部呈现为胶囊标签，支持点击快速删除或 Backspace 撤销。
- **严谨编排约束**：自动为主控 Coordinator 注入硬约束，严禁越界派发给未指定的 Harness；完善级联取消与子任务超时熔断机制。
- **真正的 Agent Team**：一个 Lead 可组织最多六个并发的具名 Harness 成员；Team、职责、共享任务依赖图和成员邮箱均由 Host 持久化，teammate 可直接定向通信、交接和反馈，而不是只把并行结果返回 Lead。
- **原生 Team Workbench**：对话顶部团队驾驶舱点击「展开详情」后在 Codex 内容流内显示唯一主导者、各成员职责、独立任务列、进度、通信流和事件回放，不覆盖原生侧栏、消息或输入框；成员卡片可跳转其原生子任务。状态直接向 Host 实时刷新，各成员仍使用自己的原生 Harness Session、模型、工具、权限和账户。
- **统一 Workspace 能力**：全部 Harness 由 Host 统一获得 Git 探测、Worktree 隔离和最终快照 Diff；原生实时 Diff 继续按各 Harness 实际协议叠加。显式隔离失败不会降级到共享目录。

### 🧩 原生 Skills 与 MCP 管理
- **17 平台免配置预建**：打开会话时自动预建全部 17 个 Harness 声明的原生 Skills 根目录，新安装 Harness 也能即开即用。
- **拖拽安装**：在「设置 → Skills」中可将单个 `SKILL.md` 或完整技能文件夹直接拖拽安装，自带安全路径校验。
- **作用域与安全停用**：支持 Global（全局）与 Project（项目级）无缝切换；停用时安全移入保留目录，绝不损坏用户源文件。
- **远程 MCP 支持**：支持配置带自定义 Headers 的 Streamable HTTP / SSE 远程服务。

### 🎨 皮肤市场与可读性保护
- **主题预览与切换**：设置 → 皮肤中可预览并应用内置主题，也可随时恢复原生 Codex 外观。
- **全界面覆盖**：背景、侧边栏、消息卡片、输入框、按钮和文字颜色统一使用主题令牌。
- **暗色可读性**：自动增加遮罩和对比度，避免侧边栏、任务列表和消息内容在深色背景上消失。
- **交互零侵入**：不替换 Codex 控件，不修改模型、工具、权限、队列或原生会话。

## 本地运行

开发环境需要 Windows、macOS 或 Linux，近期 Node.js LTS 和 npm。应用不会读取或保存 Harness 的账户密钥，请先在对应的原生 CLI 中完成安装与登录；平台前提和真机验收范围见 [跨平台指南](docs/cross-platform.md)。
```powershell
git clone https://github.com/emo-xiaoyu/harness-mix.git
cd harness-mix
npm install
```

### 从 npm 安装

Harness Mix 发布为 `@harness-mix/cli` npm 包，命令名仍是 `harness-mix`。当前发布包包含本次构建平台的 native Shim；macOS/Linux 请在目标系统执行源码构建，完整说明见 [跨平台指南](docs/cross-platform.md)。

```powershell
npm install --global @harness-mix/cli
harness-mix
```

升级到最新版本：

```powershell
npm update --global @harness-mix/cli
```

首次运行会重启已打开的 Codex Desktop。npm 包只分发 Harness Mix 本身；各 Harness 的 CLI、登录状态、模型额度和权限仍需按下表在本机单独安装和配置。

### 运行方式

原生模式（默认）：本地编译的 Shim 与 Renderer 扩展接入官方 Codex Desktop，模型选择会路由到对应 Harness。首次启动会重启已打开的 Codex Desktop：
```powershell
npm start
```

常用原生依赖：

- Codex：安装 `@openai/codex`，确保 `codex` 命令可用。
- Pi：确保 `pi.cmd` 可用。
- Claude Code：SDK 已由 npm 依赖安装，认证仍由 Claude Code 环境管理。
- DeepSeek Harness：使用本项目锁定的 `@deepseek-ai/dsh@0.1.2-rc.1`。可通过 `HARNESS_MIX_DSH_ROOT` 显式指定源码目录，但版本必须被内核支持。
- CodeBuddy：安装官方 `codebuddy` CLI 并完成登录；旧 WorkBuddy 安装也可通过兼容别名继续使用。
- Kiro CLI：安装 `kiro-cli`，启用 `acp` 子命令并完成 CLI 登录。
- Cursor CLI：安装 `cursor-agent` 并完成 CLI 登录。
- Cline：安装 `cline`（`npm i -g cline`）并通过 `cline auth` 完成登录；Harness Mix 以官方 `cline --acp` 接入。
- Qoder：安装 `qodercli`（或 `qoder`）并完成 CLI 登录；ACP 入口由本机版本决定。
- ZCode / Trae：只有在拥有已验证的 ACP 兼容桥接程序时才配置 `HARNESS_MIX_ZCODE_ACP_EXECUTABLE` / `HARNESS_MIX_TRAE_EXECUTABLE`，项目不会猜测官方入口。

原生接入方式、数据目录和验证说明见 [原生 Codex 接入](docs/native-codex.md)。

## 验证

```powershell
npm run check
npm run test:core-all
npm run e2e:native
npm run smoke:native-ui
```

涉及原生 Adapter 时，再执行对应的真实链路：

```powershell
npm run e2e:pi
npm run e2e:dsh
npm run e2e:claude
npm run e2e:codex
```

部分 E2E 会启动真实 Harness，可能需要本机安装、登录或模型额度。测试生成物写入 `output/`，不应提交到仓库。

## License

Harness Mix 基于 [Apache License 2.0](LICENSE) 发布。第三方组件仍适用各自的许可证；归属信息见 [NOTICE](NOTICE)。

## 鸣谢

Harness Mix 一路走来，受了下面这些开源项目不少启发。它们都把成果公开在自己的仓库里，本项目的架构分层、协议接线和界面细节都从中获益：

- [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) —— 官方 Codex Desktop 原生界面集成（renderer extension / desktop control / shared contracts）的衍生基础，也是整体分层与协议接线的思路来源。
- [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) —— 多 Agent 协作运行时的编排思路来源。
- [xintaofei/codeg](https://github.com/xintaofei/codeg) —— 工具协议与多 Harness 接线方式的参考。
- [HeiGeAi/heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) —— 皮肤市场内置皮肤素材的来源。

以上项目各自适用原有许可证，归属声明与许可正文见 [NOTICE](NOTICE) 与 [licenses/](licenses/)。相关商标仍归各自所有者，本项目仅用于标识所集成的产品，不主张任何商标权、背书或关联关系。

## Acknowledgements

Harness Mix owes a lot to the open-source projects below. All of them publish their work in their own repositories, and this project's architecture, protocol wiring and interface details have benefited from them:

- [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) — the upstream basis for the native Codex Desktop integration (renderer extension, desktop control, shared contracts), and the source of its overall layering and protocol wiring.
- [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) — the orchestration approach behind the multi-Agent collaboration runtime.
- [xintaofei/codeg](https://github.com/xintaofei/codeg) — a reference for the tool protocol and multi-Harness wiring.
- [HeiGeAi/heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) — the artwork bundled in the skin marketplace.

Each project remains subject to its own license; see [NOTICE](NOTICE) and [licenses/](licenses/) for the attribution records and upstream license texts. All trademarks remain the property of their respective owners. They are bundled solely to identify the products this project integrates with, and no trademark right, endorsement or affiliation is claimed.
