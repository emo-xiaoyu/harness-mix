import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
} from "@harnessmix/shared-contracts";

import {
  KNOWN_RENDERER_AGENTS,
  type ExternalRendererAgent,
  type RendererAgent,
} from "./agent-selection-state.js";

export const RENDERER_NEW_THREAD_PREFERENCE_KEY = "harnessmix.new-thread-preference.v1";

interface ExternalConfigurationPreference {
  model: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

interface NewThreadPreference {
  version: 1;
  lastAgent: RendererAgent;
  externalByAgent: Partial<Record<ExternalRendererAgent, ExternalConfigurationPreference>>;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts an entry only when its model ref parses; thinking/mode stay absent unless valid. */
function decodeExternalConfiguration(
  value: unknown,
): ExternalConfigurationPreference | undefined {
  if (!isRecord(value)) return undefined;
  const model = harnessModelRefSchema.safeParse(value.model);
  if (!model.success) return undefined;
  const thinkingOptionId = harnessThinkingOptionIdSchema.safeParse(value.thinkingOptionId);
  const permissionModeId = harnessPermissionModeIdSchema.safeParse(value.permissionModeId);
  return {
    model: model.data,
    ...(thinkingOptionId.success ? { thinkingOptionId: thinkingOptionId.data } : {}),
    ...(permissionModeId.success ? { permissionModeId: permissionModeId.data } : {}),
  };
}

/** Legacy saves may still carry the pre-rebrand "workbuddy" id. */
function migrateRenamedAgent(stored: Record<string, unknown>): Record<string, unknown> {
  if (stored.lastAgent === "workbuddy") stored.lastAgent = "codebuddy";
  const external = isRecord(stored.externalByAgent) ? stored.externalByAgent : {};
  if (!external.codebuddy && external.workbuddy) external.codebuddy = external.workbuddy;
  return external;
}

function decodeStoredPreference(
  storage: PreferenceStorage | null,
): NewThreadPreference | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(RENDERER_NEW_THREAD_PREFERENCE_KEY);
    if (!raw) return undefined;
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored) || stored.version !== 1) return undefined;
    const externalRaw = migrateRenamedAgent(stored);
    if (!KNOWN_RENDERER_AGENTS.some((agent) => agent === stored.lastAgent)) return undefined;
    const externalByAgent = Object.fromEntries(
      KNOWN_RENDERER_AGENTS.filter(
        (agent): agent is ExternalRendererAgent => agent !== "codex",
      ).flatMap((agent) => {
        const configuration = decodeExternalConfiguration(externalRaw[agent]);
        return configuration ? [[agent, configuration]] : [];
      }),
    ) as NewThreadPreference["externalByAgent"];
    return {
      version: 1,
      lastAgent: stored.lastAgent as RendererAgent,
      externalByAgent,
    };
  } catch {
    return undefined;
  }
}

function persistPreference(
  preference: NewThreadPreference,
  storage: PreferenceStorage | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(RENDERER_NEW_THREAD_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // Failing to remember a preference must never block composer configuration.
  }
}

export function readNewThreadAgentPreference(
  enabledAgents: ReadonlySet<RendererAgent>,
  storage: PreferenceStorage | null = defaultStorage(),
): RendererAgent | undefined {
  const agent = decodeStoredPreference(storage)?.lastAgent;
  return agent && enabledAgents.has(agent) ? agent : undefined;
}

export function readNewThreadExternalConfigurationPreference(
  agent: ExternalRendererAgent,
  catalog: HarnessModelCatalog,
  permissionModes?: HarnessPermissionModeCatalog,
  storage: PreferenceStorage | null = defaultStorage(),
): ExternalConfigurationPreference | undefined {
  const preference = decodeStoredPreference(storage)?.externalByAgent[agent];
  if (!preference) return undefined;
  // Re-check every remembered value against the live catalog: models, thinking
  // options and permission modes may have changed between sessions.
  const catalogModel = catalog.models.find(({ ref }) => ref.id === preference.model.id);
  if (!catalogModel) return undefined;
  const thinkingOptionId =
    preference.thinkingOptionId &&
    catalogModel.supportedThinkingOptionIds?.includes(preference.thinkingOptionId)
      ? preference.thinkingOptionId
      : undefined;
  const permissionModeId =
    preference.permissionModeId &&
    permissionModes?.modes.some(({ id }) => id === preference.permissionModeId)
      ? preference.permissionModeId
      : undefined;
  return {
    model: catalogModel.ref,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(permissionModeId ? { permissionModeId } : {}),
  };
}

export function writeNewThreadAgentPreference(
  agent: RendererAgent,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  const current = decodeStoredPreference(storage);
  persistPreference(
    {
      version: 1,
      lastAgent: agent,
      externalByAgent: current?.externalByAgent ?? {},
    },
    storage,
  );
}

export function writeNewThreadExternalConfigurationPreference(
  agent: ExternalRendererAgent,
  model: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  const current = decodeStoredPreference(storage);
  persistPreference(
    {
      version: 1,
      lastAgent: current?.lastAgent ?? "codex",
      externalByAgent: {
        ...current?.externalByAgent,
        [agent]: {
          model: harnessModelRefSchema.parse(model),
          ...(thinkingOptionId
            ? { thinkingOptionId: harnessThinkingOptionIdSchema.parse(thinkingOptionId) }
            : {}),
          ...(permissionModeId
            ? { permissionModeId: harnessPermissionModeIdSchema.parse(permissionModeId) }
            : {}),
        },
      },
    },
    storage,
  );
}
