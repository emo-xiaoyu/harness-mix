/**
 * Single source of truth for the renderer agent catalog. The desktop
 * controller validates the injected renderer binding against this list and
 * the renderer extension builds its picker from it — two independently
 * hardcoded copies drifted apart once (kimi-code shipped renderer-side only,
 * 2026-09-28) and every controller reinstall failed permanently on the next
 * page reload; both sides must now reference this module so the sets can no
 * longer disagree within one build.
 */
export const RENDERER_AGENTS = [
  "codex",
  "pi",
  "claude-code",
  "deepseek-harness",
  "opencode",
  "grok",
  "omp",
  "antigravity",
  "kiro-cli",
  "openclaw",
  "hermes",
  "qoder",
  "codebuddy",
  "zcode",
  "trae",
  "cursor-cli",
  "cline",
  "kimi-code",
  "codex-harness",
] as const;

export type RendererAgentId = (typeof RENDERER_AGENTS)[number];
