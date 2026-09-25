/**
 * Typed client for the Host integrations API (MCP servers + skills). The
 * zod schemas are the wire contract; the method names are fixed.
 */
import { z } from "zod";

const serverSchema = z.object({
  id: z.string(),
  name: z.string(),
  transportType: z.enum(["stdio", "streamable_http"]).optional(),
  command: z.string().optional().default(""),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
  env_vars: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  url: z.string().optional(),
  bearer_token_env_var: z.string().optional(),
  http_headers: z.record(z.string(), z.string()).optional(),
  env_http_headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  scope: z.enum(["global", "project"]),
  editable: z.boolean(),
  effective: z.boolean(),
  appliedSessions: z.number(),
});

const skillSchema = z.object({
  name: z.string(),
  path: z.string(),
  root: z.string(),
  enabled: z.boolean(),
  writable: z.boolean(),
  scope: z.enum(["global", "project"]),
  status: z.string(),
});

const snapshotSchema = z.object({
  harnessId: z.string(),
  mcpSupported: z.boolean(),
  skillsSupported: z.boolean(),
  servers: z.array(serverSchema),
  native: z.array(
    z.object({
      sessionId: z.string(),
      name: z.string(),
      status: z.string(),
      tools: z.array(z.string()),
    }),
  ),
  skills: z.array(skillSchema),
  note: z.string(),
});

const catalogSchema = z.object({
  harnesses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      available: z.boolean(),
      mcp: z.boolean(),
      skills: z.boolean(),
    }),
  ),
});

export type IntegrationSnapshot = z.infer<typeof snapshotSchema>;

export interface IntegrationScope {
  harnessId: string;
  scope: "global" | "project";
  cwd?: string;
}

export interface ManagedServer {
  id?: string | undefined;
  name: string;
  transportType?: "stdio" | "streamable_http" | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  env_vars?: string[] | undefined;
  cwd?: string | null | undefined;
  url?: string | undefined;
  bearer_token_env_var?: string | undefined;
  http_headers?: Record<string, string> | undefined;
  env_http_headers?: Record<string, string> | undefined;
  enabled: boolean;
}

export interface DroppedSkillFile {
  path: string;
  contentBase64: string;
}

export interface SkillChange {
  name: string;
  root?: string;
  source?: string;
  files?: DroppedSkillFile[];
  action: "install" | "enable" | "disable";
}

export interface RendererIntegrationsClient {
  integrationCatalog(): Promise<z.infer<typeof catalogSchema>>;
  listIntegrations(input: IntegrationScope): Promise<IntegrationSnapshot>;
  saveMcp(input: IntegrationScope & { server: ManagedServer }): Promise<unknown>;
  removeMcp(input: IntegrationScope & { id: string }): Promise<unknown>;
  changeSkill(input: IntegrationScope & SkillChange): Promise<unknown>;
}

export function createRendererIntegrationsClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): RendererIntegrationsClient {
  return {
    integrationCatalog: async () =>
      catalogSchema.parse(await send("harnessmix/integrations/catalog", {})),
    listIntegrations: async (input) =>
      snapshotSchema.parse(await send("harnessmix/integrations/list", input)),
    saveMcp: (input) => send("harnessmix/integrations/mcp/save", input),
    removeMcp: (input) => send("harnessmix/integrations/mcp/remove", input),
    changeSkill: (input) => send("harnessmix/integrations/skill/change", input),
  };
}
