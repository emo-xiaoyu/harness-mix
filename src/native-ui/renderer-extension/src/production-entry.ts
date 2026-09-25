/**
 * Production bundle entrypoint. The controller injects this script on every
 * document load with __harnessmixProductionConfigV1 already set; consume and
 * delete it so the page cannot re-read our configuration.
 */
import { DEFAULT_RENDERER_AGENTS, type RendererAgent } from "./agent-selection-state.js";
import { installRendererBinding } from "./install-renderer-binding.js";

declare global {
  interface Window {
    __harnessmixProductionConfigV1?: {
      defaultAgent: RendererAgent;
    };
  }
}

const configuration = window.__harnessmixProductionConfigV1;
delete window.__harnessmixProductionConfigV1;

const install = (): void => {
  installRendererBinding(DEFAULT_RENDERER_AGENTS, configuration?.defaultAgent ?? "codex");
};

// In sidecar mode the renderer must wait for the draft prewarm policy bridge
// (installed separately) before binding — it provides the transport.
const installWhenTransportReady = (): void => {
  if (window.__harnessmixSidecarModeV1 === true && !window.__harnessmixDraftPrewarmPolicyV1) {
    window.addEventListener("harnessmix:draft-prewarm-policy-changed", install, { once: true });
    return;
  }
  install();
};

if (document.documentElement && document.body) {
  installWhenTransportReady();
} else {
  window.addEventListener("DOMContentLoaded", installWhenTransportReady, { once: true });
}
