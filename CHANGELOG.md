# Changelog

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
