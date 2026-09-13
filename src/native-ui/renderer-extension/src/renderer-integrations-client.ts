import { z } from 'zod';

const serverSchema = z.object({ id: z.string(), name: z.string(), command: z.string(), args: z.array(z.string()), enabled: z.boolean(), scope: z.enum(['global', 'project']), editable: z.boolean(), effective: z.boolean(), appliedSessions: z.number() });
const skillSchema = z.object({ name: z.string(), path: z.string(), root: z.string(), enabled: z.boolean(), writable: z.boolean(), scope: z.enum(['global', 'project']), status: z.string() });
const snapshotSchema = z.object({ harnessId: z.string(), mcpSupported: z.boolean(), skillsSupported: z.boolean(), servers: z.array(serverSchema), native: z.array(z.object({ sessionId: z.string(), name: z.string(), status: z.string(), tools: z.array(z.string()) })), skills: z.array(skillSchema), note: z.string() });
const catalogSchema = z.object({ harnesses: z.array(z.object({ id: z.string(), name: z.string(), available: z.boolean(), mcp: z.boolean(), skills: z.boolean() })) });
export type IntegrationSnapshot = z.infer<typeof snapshotSchema>;
export interface IntegrationScope { harnessId: string; scope: 'global' | 'project'; cwd?: string }
export interface ManagedServer { name: string; command: string; args: string[]; enabled: boolean }
export interface SkillChange { name: string; root?: string; source?: string; action: 'install' | 'enable' | 'disable' }
export interface RendererIntegrationsClient {
  integrationCatalog(): Promise<z.infer<typeof catalogSchema>>;
  listIntegrations(input: IntegrationScope): Promise<IntegrationSnapshot>;
  saveMcp(input: IntegrationScope & { server: ManagedServer }): Promise<unknown>;
  removeMcp(input: IntegrationScope & { id: string }): Promise<unknown>;
  changeSkill(input: IntegrationScope & SkillChange): Promise<unknown>;
}
export function createRendererIntegrationsClient(send: (method: string, params: unknown) => Promise<unknown>): RendererIntegrationsClient {
  return {
    integrationCatalog: async () => catalogSchema.parse(await send('codexhost/integrations/catalog', {})),
    listIntegrations: async input => snapshotSchema.parse(await send('codexhost/integrations/list', input)),
    saveMcp: input => send('codexhost/integrations/mcp/save', input),
    removeMcp: input => send('codexhost/integrations/mcp/remove', input),
    changeSkill: input => send('codexhost/integrations/skill/change', input),
  };
}
