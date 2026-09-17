import { DEFAULT_RENDERER_AGENTS, type RendererAgent } from "./agent-selection-state.js";
import {
  installRendererBindingProbe,
  type RendererBindingProbeApi,
} from "./renderer-binding-probe.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";

export function installRendererBinding(
  enabledAgents: readonly RendererAgent[] = DEFAULT_RENDERER_AGENTS,
  defaultAgent: RendererAgent = "codex",
): RendererBindingProbeApi {
  window.__harnessmixRendererBindingProbeV1?.dispose();
  const binding = installRendererBindingProbe({ enabledAgents, defaultAgent });
  try {
    const adapter = installCurrentRendererAdapter();
    binding.setAdapter(adapter.status, adapter.dispose, adapter.applyAgent, adapter.modelControl);
  } catch (error) {
    console.error(
      "harnessmix Renderer Adapter installation failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    binding.setAdapter({
      state: "unsupported",
      reason: "installation-failed",
      modelUpdates: 0,
      hook: null,
    });
  }
  return binding;
}
