import { describe, expect, it } from "vitest";

import { RENDERER_AGENTS, RendererAgentId } from "../src/index.js";

describe("Renderer agent catalog single source", () => {
  it("is unique, non-empty and always includes the stock codex route", () => {
    expect(new Set(RENDERER_AGENTS).size).toBe(RENDERER_AGENTS.length);
    expect(RENDERER_AGENTS.length).toBeGreaterThan(1);
    expect(RENDERER_AGENTS).toContain("codex");
    expect(RENDERER_AGENTS).toContain("kimi-code");
  });

  it("keeps the agent id type a pure string union", () => {
    const agent: RendererAgentId = RENDERER_AGENTS[0];
    expect(typeof agent).toBe("string");
  });
});
