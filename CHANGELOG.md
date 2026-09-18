# Changelog

## Unreleased

- Send/cancel race hardening: the per-thread send lock is now ticket-owned. Stopping a turn mid-stream frees the thread for an immediate resend, but the old send's exit path can no longer delete the newer send's lock (which previously let a third submission run concurrently and trip the native harness's "already processing" error); pending cancel requests are likewise scoped to the send generation they target. 取消-重发竞态修复：发送锁改为票据所有制，旧发送退出时不再误删新发送的锁。
- Stuck-turn watchdog now cancels the native session when it settles a wedged turn, instead of only settling the UI: a zombie native process no longer blocks the thread's next turn with an occupancy error. 卡死回合看门狗结算时级联取消原生会话，避免僵尸进程占用后续回合。
- `/delegate` waits for the child task to actually settle (up to 30 minutes, aligned with collaboration orchestration, injectable as `delegationTimeoutMs`) and cancels the child on timeout with an explicit parent-side error — previously a non-blocking harness child (e.g. Pi) running longer than 30 seconds was silently reported as done with its result dropped. 委派等待修复：子任务异步结算前父线程不再提前误判成功。
- Forked threads now broadcast `thread/started`, so a fork appears in the Desktop sidebar immediately instead of only after a reload. Fork 分支会话即时显示在侧边栏。
- Multi-select question answers from the Desktop are preserved in full (JSON-encoded) instead of being truncated to the first option, fixing `JSON.parse` crashes on OpenCode multiple-choice questions; empty answer arrays now resolve to `''` rather than `undefined`. 多选答案全量保留，空数组回退为空字符串。
- Workspace review attribution: files this turn's own tools touched win over historical "foreign session" attribution, so same-directory sessions' old edits no longer hide this turn's legitimate changes from the review card and undo list. 审查归属修复：本轮触碰的文件不再被历史 foreign 归属误剔。
- Child-process stdin streams (`jsonl` transports, the DPAPI secure-store helper, the Antigravity CLI, and the official app-server pipe) now swallow asynchronous EPIPE stream errors instead of crashing the host process with an unhandled exception. 子进程 stdin 管道错误不再导致宿主崩溃。

## 0.2.2 — 2026-09-18

- Aligns all six `@harness-mix/native-*` runtime packages at 0.2.2 with the CLI and pins `optionalDependencies` to the same version. 0.2.1 shipped with pins still at 0.1.11, so a fresh install's postinstall could overwrite the bundled fresh Shim binaries with the old-contract 0.1.11 ones; supersedes 0.2.1. Native binaries are rebuilt from unchanged Rust sources.

## 0.2.1 — 2026-09-18

- Turn transcripts now match Codex's native three-stage experience: opening remarks and inter-tool commentary stream live as progress-phase agent messages alongside command rows while the turn runs, and on completion Codex Desktop folds every progress segment and tool item under the elapsed-time bar, leaving only the final-phase conclusion visible. The previous buffer-and-reclassify-as-reasoning approach (which hid narration while running) is removed.
- Runtime hardening: cancelling while a send is still opening the session or assembling the prompt no longer strands an invisible zombie run — the cancel is recorded and settled before the prompt is delivered; a watchdog now settles running turns that produce no events for 15 minutes (approval waits excluded) so the UI stops spinning and review snapshots finalize instead of hanging forever.
- Pi-family and Claude adapters: a Host-side projection exception can no longer kill the native event pump; Pi `message_end` failures wait for `agent_end`'s `willRetry` so automatic retries are no longer reported as final errors (mid-retry user messages are queued as native follow-ups instead of hitting "Agent is already processing"), and an abort issued during prompt preflight is re-issued after the ack so the just-started run is actually stopped.
- Collaboration cards: the spawnAgent card settles as done as soon as the child session is ready and execution state moves to a separate sendInput card, so Desktop no longer shows "creating agents" for the whole run; team cards settle when the team completes.
- Workspace reviews positively exclude edits whose paths were reported by other concurrent sessions' harnesses, keeping each turn's diff and undo list attributable to its own session.
- Desktop pet switching in the Pets settings page: the **Use / 使用** button on an installed pet now switches **Codex Desktop's official pet** by driving the app's own UI (profile menu → Settings → official Pets settings → the pet's card, live-verified against Codex Desktop 26.908), so the native mascot (the profile-menu / Show-pet companion window) changes accordingly. A "Now showing / 当前桌宠" panel at the top of the page mirrors the pet Harness Mix last switched to (persisted as a small local record; clearing it never touches the official mascot — visibility stays with Codex's own Show pet toggle), and the active card gets an "Active / 使用中" badge. No account APIs are called and no credentials are touched: selection happens through genuine DOM clicks on Codex's own settings UI.
- Settings → Collaboration is a new page with two independent switches (both on by default): **Multi-Agent collaboration** (the `#` mention menu, delegation tools and coordinator prompt are fully disabled when off) and **Agent Team** (`create_agent_team` and the other team tools are hidden from the injected MCP server and rejected Host-side when off, while one-shot delegation stays available). Preferences persist across Host restarts.
- The skin marketplace grows from 17 to 30 built-ins: the **Gothic Void Crusade** background theme redistributed from Fei-Away/Codex-Dream-Skin (MIT, artwork by @seansong-ideogram), and twelve classic editor palette themes (Catppuccin Latte/Mocha, Claude Desktop dark/light, Gruvbox dark/light, Nord dark/light, One Dark/Light, Tokyo Night dark/light) derived from miniLV/Anthropic-codex-theme (MIT). License texts and provenance are recorded under licenses/ and src/assets/skins/dream-skin/.
- Native protocol: collaboration child threads project as `subAgentThreadSpawn`, so Desktop's sub-agent cards open the child session on click instead of silently doing nothing.
- Workspace reviews: concurrent same-directory sessions now show per-session diffs narrowed to the files their own tools touched (lead turns include collaboration children), line-diff ignores CR/LF-only changes (no more full-file phantom diffs), file edits refresh the review ~250ms after landing instead of on a 3s poll, and `turn/diff/updated` notifications are deduplicated per turn.

## 0.2.0 — 2026-09-17

- **Agent Team**：新增持久的多 Harness 智能体团队 —— 一个 Lead 可组织最多六个并发的具名 Harness 成员，共享依赖感知的任务图、成员邮箱与直接会话投递，并配备会话内实时 Team Workbench（明确职责、按成员的任务泳道、Harness 图标、成员会话跳转与可回放的状态历史）。Added durable multi-Harness Agent Teams: one Lead orchestrates up to six concurrent named Harness members with a dependency-aware shared task graph, teammate mailboxes/direct session delivery, and a live in-conversation Team Workbench with explicit responsibilities, per-member task lanes, Harness icons, member-session navigation, and replayable state history.
- Antigravity: agy 1.2.x intermittently settles a turn with `SUCCESS` but no assistant text at all (tools ran, final answer lost). The adapter now automatically issues one nudge prompt in the same native conversation instead of failing the turn, and only reports the empty result when the retry also comes back empty (`HARNESSMIX_ANTIGRAVITY_EMPTY_RESULT_RETRIES`, default 1).
- Collaboration: inspecting a thread's team without an explicit `teamId` (the renderer's per-thread poll) now answers `{ team: null, snapshots: [] }` instead of throwing an internal error for every ordinary thread; an explicit `teamId` remains an ownership check.
- The README is now fully bilingual (中文 + English), and Harness Mix is dual-licensed under Apache-2.0 OR MIT: `LICENSE-MIT` was added, and `package.json`, the Rust crates and the native-package publisher now declare `(Apache-2.0 OR MIT)`.

- Renamed the kernel's internal legacy identifiers to `harnessmix`: data directory, environment variables, protocol method namespaces, DOM hooks, and the `@harnessmix/*` package scope. Deployed Shim and protocol binaries must be rebuilt (`npm run build:native`) so the Rust and JavaScript layers agree on the environment contract.
- Relocated the data directory to `<base>/harnessmix`; the one-time relocation of pre-rename installs has served its purpose and is now removed together with every remaining mention of the old naming.
- `npm run build:native` now fails instead of silently keeping a stale `harness-mix-shim.exe` when a running Codex Desktop locks it **and** its contents changed; a byte-identical locked binary is still kept for UI-only rebuilds.
- Removed the remaining third-party reference comments from adapter and error-classification sources, and narrowed the release-notes URL check in `@harnessmix/shared-contracts` so only this project's GitHub Release (`emo-xiaoyu/harness-mix`) is accepted. Attribution required by upstream licenses (`NOTICE`, `licenses/`, `src/native-ui/LICENSE` and the per-subtree provenance notes) is unchanged.
- Dropped the last third-party reference comments in the multi-Agent collaboration runtime and renamed `docs/superpowers/specs/` to `docs/specs/`, so no source path or comment names another project. Stopped tracking `.workbuddy/memory/` (already covered by `.gitignore`); the local notes are unchanged.
- Added the missing attribution for the bundled harness and model icons: twenty-four of the thirty-three are redistributed from `lobehub/lobe-icons` (MIT) — fifteen byte-identical, nine with identical path data — so `licenses/lobe-icons-MIT.txt` was added, `src/assets/icons/PROVENANCE.md` now maps every file to its origin (and lists the three files no code path references), and `NOTICE` records the redistribution plus the trademark status of all bundled brand marks.
- Added a bilingual acknowledgements section to the README crediting the projects this kernel drew on: BytePioneer-AI's Codex Desktop integration project for the native integration basis, `NanmiCoder/cc-haha` for the collaboration orchestration approach, `xintaofei/codeg` for the tool protocol and multi-Harness wiring, and `HeiGeAi/heige-codex-skin-studio` for the bundled skin artwork.

## 0.1.11 — 2026-09-16

- Aligned all six `@harness-mix/native-*` runtime packages at 0.1.11 with the CLI; native binaries are unchanged from 0.1.9.
- Supersedes 0.1.10, whose manifest kept native pins at 0.1.9 (functionally identical binaries).
- Unified Host-owned Git inspection, strict Worktree isolation, and final snapshot Diff across all registered Harness adapters without changing native models, sessions, tools, approvals, or credentials.

## 0.1.10 — 2026-09-16

- Added a community desktop pet marketplace with browsing, installation, and localization in the native settings shell.
- Preserved new task drafts across navigation so unsent composer text survives sidebar switches.
- Avoided restarting already-active Codex Desktop sessions from the launcher.
- Improved responsive skin readability across narrow layouts.

## 0.1.5 — 2026-09-13

- Added graphical cross-Harness task handoff in the native Codex Desktop composer, with continue, execute-plan, independent-review, and reanalyze modes.
- Added persistent, hashed handoff checkpoints with bounded redacted conversation, plan, file, Git, test, build, command, and error evidence.
- Added task-scoped read-only MCP access for capable Harnesses while preserving bounded-summary fallback for other native protocols.
- Added native Codex account management and Harness-scoped MCP/Skills integration controls.
- Preserved native ownership of sessions, models, tools, credentials, permissions, and approvals across handoffs.

## 0.1.3 — 2026-09-13

- Added multi-agent collaboration support (@ mentions composer, thread delegation, worktree isolation).
- Cleaned up legacy standalone workbench UI services, throwaway HTML prototypes, and unused icon assets.
- Enhanced native harness adapters and settings management.

## 0.1.2 — 2026-09-13

- Hardened native process supervision, DPAPI secret store, and dual-channel auto-update.


- Added native ACP adapters for CodeBuddy, Kiro CLI, Cursor CLI and Qoder.
- Added explicit ACP bridge configuration for ZCode and Trae without claiming an unverified vendor entry point.
- Renamed WorkBuddy to CodeBuddy while preserving legacy task, history and preference identifiers.
- Added image capability negotiation, bounded ACP event draining, idle/hard turn timeouts, cancellation fallback and stuck-tool diagnostics.
- Added durable multi-agent recovery checkpoints and verified DSH → CodeBuddy collaboration.
- Updated the README and native integration documentation with installation, verification and capability limits.
