# Repository Guidelines

Contributor guide for **Harness Mix** — an Electron desktop shell that presents native coding harnesses (Pi, Claude Code, DeepSeek Harness) under one UI while sessions, model calls, tools, and permissions stay owned by each native program.

## Project Structure & Module Organization

- `src/main/` — Electron main process. `main.js` (window lifecycle), `preload.js` (whitelisted IPC bridge).
- `src/main/host/` — Host Runtime: `runtime.js` (orchestration/resume/projection), `store.js`, `jsonl.js` (persistence).
- `src/main/adapters/` — one plugin per harness (`pi.js`, `dsh.js`, `claude.js`), registered in `index.js`. New harnesses follow the manifest/factory/session shape documented in `README.md`.
- `src/renderer/` — desktop UI: `app.js`, `index.html`, `style.css`, `icons/`.
- `scripts/` — verification tooling (`check.cjs`, `ui-smoke.cjs`, `e2e-*.cjs`).
- `design/` — prototype HTML/PNG and icon assets. `output/playwright/` — generated test artifacts; do not commit.

## Build, Test, and Development Commands

- `npm install` — install the only devDependency (Electron).
- `npm start` — launch the desktop app locally.
- `npm run check` — syntax-check every `.js`/`.cjs` under `src/` and `scripts/`; must pass before submitting.
- `npm run smoke` — integration check with real Renderer + mocked IPC; no model calls.
- `npm run e2e:pi` / `npm run e2e:dsh` — end-to-end runs against the real harness (requires `pi.cmd` or a DSH checkout at `E:\dsh\deepseek-harness`, overridable via `HARNESS_MIX_DSH_ROOT`).

## Coding Style & Naming Conventions

Plain CommonJS JavaScript — no TypeScript, bundler, or linter is configured, so `node --check` cleanliness (via `npm run check`) is the enforced bar. Match existing style: 2-space indentation, single quotes, `require`/`module.exports`, camelCase functions, PascalCase only for classes. Adapter files are lowercase (`pi.js`); capability flags live in the adapter `manifest`, never as UI-side guesses.

## Testing Guidelines

There is no unit-test framework; verification is layered: `check` (syntax) → `smoke` (mocked IPC) → `e2e:*` (real harness). Run at least `check` and `smoke` for any change; add an `e2e` pass when touching adapter or runtime code. Name new scripts `*.cjs` under `scripts/` and wire them into `package.json`.

## Commit & Pull Request Guidelines

This project has no committed Git history yet — adopt Conventional Commits (`feat:`, `fix:`, `refactor:`) with a scoped summary, e.g. `feat(adapter): add fork capability to pi`. PRs should describe which harness layers are affected (renderer / IPC / runtime / adapter), state honestly-declared capability changes, and attach a smoke-run log or screenshot for UI changes.

## Security & Configuration Tips

Harness Mix never reads or stores credentials — accounts, keys, and permissions belong to the native harnesses. Keep it that way: do not proxy or persist tokens, and do not fabricate permission decisions in adapters; route approvals through `respond()` to the native protocol.
