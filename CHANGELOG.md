# Changelog

## Unreleased

- Settings → Collaboration is a new page with two independent switches (both on by default): **Multi-Agent collaboration** (the `#` mention menu, delegation tools and coordinator prompt are fully disabled when off) and **Agent Team** (`create_agent_team` and the other team tools are hidden from the injected MCP server and rejected Host-side when off, while one-shot delegation stays available). Preferences persist across Host restarts.

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
