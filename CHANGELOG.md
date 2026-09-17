# Changelog

## Unreleased

- Renamed the kernel's internal `codexhost` identifiers to `harnessmix`: data directory, environment variables, protocol method namespaces, DOM hooks, and the `@harnessmix/*` package scope. Deployed Shim and protocol binaries must be rebuilt (`npm run build:native`) so the Rust and JavaScript layers agree on the environment contract.
- Relocated the data directory to `<base>/harnessmix`. The launcher now moves an existing `harness-mix/codexhost` directory into the new location once, after retiring the previous runtime, so sessions, Harness accounts, thread mappings, collaboration state, and the credential vault survive the rename.
- `npm run build:native` now fails instead of silently keeping a stale `harness-mix-shim.exe` when a running Codex Desktop locks it **and** its contents changed; a byte-identical locked binary is still kept for UI-only rebuilds.
- Removed the remaining third-party reference comments from adapter and error-classification sources, and narrowed the release-notes URL check in `@harnessmix/shared-contracts` so only this project's GitHub Release (`emo-xiaoyu/harness-mix`) is accepted. Attribution required by upstream licenses (`NOTICE`, `licenses/`, `src/native-ui/LICENSE` and the per-subtree provenance notes) is unchanged.
- Dropped the last third-party reference comments in the multi-Agent collaboration runtime and renamed `docs/superpowers/specs/` to `docs/specs/`, so no source path or comment names another project. Stopped tracking `.workbuddy/memory/` (already covered by `.gitignore`); the local notes are unchanged.
- Added the missing attribution for the bundled harness and model icons: twenty-four of the thirty-three are redistributed from `lobehub/lobe-icons` (MIT) — fifteen byte-identical, nine with identical path data — so `licenses/lobe-icons-MIT.txt` was added, `src/assets/icons/PROVENANCE.md` now maps every file to its origin (and lists the three files no code path references), and `NOTICE` records the redistribution plus the trademark status of all bundled brand marks.

## 0.1.11 — 2026-09-16

- Aligned all six `@harness-mix/native-*` runtime packages at 0.1.11 with the CLI; native binaries are unchanged from 0.1.9.
- Supersedes 0.1.10, whose manifest kept native pins at 0.1.9 (functionally identical binaries).
- Added durable multi-Harness Agent Teams with one Lead, up to six concurrent specialist members, a dependency-aware shared task graph, teammate mailboxes/direct session delivery, and a live in-conversation Team Workbench with explicit responsibilities, per-member task lanes, Harness icons, member-session navigation, and replayable state history.
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
