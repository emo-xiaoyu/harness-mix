# Repository Guidelines

Contributor guide for **Harness Mix** — a local kernel that drives native coding harnesses (Codex, Pi, Claude Code, DeepSeek Harness, Antigravity) inside the official Codex Desktop UI, while sessions, model calls, tools, and permissions stay owned by each native program.

## Project Structure & Module Organization

- `src/main/native/` — native mode: `launcher.js` (desktop activation, leftover sweep, update flow), `updater.js` + `update-state.js` (dual-channel update: git fast-forward / npm registry, lock, rollback), `host.js` (protocol entry, heartbeat, crash reports), `protocol.js` (app-server projection), `process-utils.js` (process-tree termination), `redact.js` (log redaction), `secure-store.js` (DPAPI vault wrapper), `rs/` (Rust workspace: `harness-mix-shim` protocol bridge + kill-on-close job object, `harness-mix-appx` AppX activation, `harness-mix-secret` DPAPI vault), `icons.js` (icon catalog).
- `src/main/host/` — Host Runtime: `runtime.js` (orchestration/resume/projection), `store.js`, `jsonl.js` (persistence).
- `src/main/adapters/` — one plugin per harness (`pi.js`, `omp.js`, `dsh.js`, `claude.js`, `antigravity.js`, `codex.js`, `opencode.js`, `grok.js`; Pi/OMP share `pi-family.js`, OpenCode uses native HTTP/SSE via `opencode-server.js`, Grok independently maps native stdio and `_x.ai/*` extensions), registered in `index.js`. New harnesses follow the manifest/factory/session shape documented in `README.md`.
- `src/native-ui/` — TypeScript sources of the Codex Desktop integration: `renderer-extension/` (injected UI), `desktop-control/` (CDP controller), `shared-contracts/` (shared protocol contracts).
- `src/assets/icons/` — harness and model icons, embedded at build time.
- `scripts/` — verification tooling (`check.cjs`, `build-native.cjs`, `native-*-test.cjs`, `e2e-*.cjs`).
- `docs/images/` — Codex Desktop native UI screenshots used in the README. `output/` — build and test artifacts; do not commit.

## Build, Test, and Development Commands

- `npm install` — install devDependencies (Electron for native smoke, esbuild).
- `npm start` — launch native mode; restarts Codex Desktop with the local Shim.
- `npm run build:native` — rebuild the Renderer extension, Desktop controller and Rust binaries (requires a Rust toolchain) into `output/native-build/`.
- `npm run check` — syntax-check every `.js`/`.cjs` under `src/` and `scripts/`; must pass before submitting.
- `npm run test:core-all` — kernel test suite (contracts, projector, turn manager, adapters, replay, runtime, services).
- `npm run e2e:native` — real Shim + Host protocol check; `npm run e2e:native:pi` / `:dsh` / `:claude` send live turns.
- `npm run e2e:pi` / `npm run e2e:dsh` — end-to-end runs against the real harness through Host Runtime (requires `pi.cmd` or a DSH checkout, overridable via `HARNESS_MIX_DSH_ROOT`).

## Coding Style & Naming Conventions

Plain CommonJS JavaScript — no TypeScript, bundler, or linter is configured, so `node --check` cleanliness (via `npm run check`) is the enforced bar. Match existing style: 2-space indentation, single quotes, `require`/`module.exports`, camelCase functions, PascalCase only for classes. Adapter files are lowercase (`pi.js`); capability flags live in the adapter `manifest`, never as UI-side guesses.

## Testing Guidelines

There is no unit-test framework; verification is layered: `check` (syntax) → `test:core-all` (kernel) → `e2e:native` / `e2e:*` (real harness). Run at least `check` and `test:core-all` for any change; add an `e2e` pass when touching adapter or runtime code. Name new scripts `*.cjs` under `scripts/` and wire them into `package.json`.

## Commit & Pull Request Guidelines

This project has no committed Git history yet — adopt Conventional Commits (`feat:`, `fix:`, `refactor:`) with a scoped summary, e.g. `feat(adapter): add fork capability to pi`. PRs should describe which harness layers are affected (renderer extension / desktop control / runtime / adapter), state honestly-declared capability changes, and attach a smoke-run log or screenshot for UI changes.

## Security & Configuration Tips

Harness Mix never reads or stores credentials — accounts, keys, and permissions belong to the native harnesses. Keep it that way: do not proxy or persist tokens, and do not fabricate permission decisions in adapters; route approvals through `respond()` to the native protocol.
