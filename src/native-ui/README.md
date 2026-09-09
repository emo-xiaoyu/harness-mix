# Harness Mix native Desktop boundary

The renderer-extension, desktop-control and shared-contracts source directories
are derived from BytePioneer-AI/codex-host v0.6.1, commit
da97fa7b447d03bd3626bb8f782234d5fa519141 (MIT, see LICENSE).
They are maintained and built in this repository. No upstream Host Runtime,
ProtocolCore, adapter or account store is imported. Upstream wire names are
retained solely for compatibility with this renderer boundary.

Execution is owned by src/main/host/runtime.js and src/main/protocol-core.
Launcher and Shim sources live in src/main/native. Project icons are compiled
directly from src/assets/icons. Generated artifacts live in output/native-build.
