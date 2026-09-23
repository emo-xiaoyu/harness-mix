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
