import { KNOWN_RENDERER_AGENTS, type ExternalRendererAgent } from "./agent-selection-state.js";

/**
 * Presentation placement for an external Agent:
 * - "main": directly visible in the Agent picker and the Connections page.
 * - "more": tucked into the collapsible "More Agents" group so the picker
 *   stays scannable as more Harnesses are supported.
 *
 * Purely cosmetic: it never decides install state, enablement, or
 * reachability — those belong to `enabledAgents` / availability elsewhere.
 */
export type AgentGroupSection = "main" | "more";

export interface AgentGroupEntry {
  readonly agent: ExternalRendererAgent;
  readonly section: AgentGroupSection;
}

export interface AgentGroupPreferenceStore {
  /** Every external Agent in display order, each tagged with its section. */
  list(): readonly AgentGroupEntry[];
  sectionOf(agent: ExternalRendererAgent): AgentGroupSection;
  /**
   * Relocate `agent` into `section`. With `beforeAgent` given, insert directly
   * before it (both must share the target section afterwards); without it the
   * Agent is appended to that section's tail.
   */
  moveAgent(
    agent: ExternalRendererAgent,
    section: AgentGroupSection,
    beforeAgent?: ExternalRendererAgent | null,
  ): void;
  resetToDefault(): void;
  subscribe(listener: () => void): () => void;
}

export const AGENT_GROUP_PREFERENCE_STORAGE_KEY = "harnessmix.agentGroupPreference.v1";

const EXTERNAL_AGENTS: readonly ExternalRendererAgent[] = KNOWN_RENDERER_AGENTS.filter(
  (agent): agent is ExternalRendererAgent => agent !== "codex",
);

interface StoredEntry {
  readonly agent: string;
  readonly section: AgentGroupSection;
}

function belongsToKnownAgents(value: unknown): value is ExternalRendererAgent {
  return typeof value === "string" && (EXTERNAL_AGENTS as readonly string[]).includes(value);
}

function isValidStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredEntry>;
  return (
    belongsToKnownAgents(entry.agent) &&
    (entry.section === "main" || entry.section === "more")
  );
}

/** Renames the pre-rebrand Agent id so legacy saves stay readable. */
function migrateStoredEntries(parsed: unknown[]): unknown[] {
  return parsed.map((entry) =>
    entry && (entry as StoredEntry).agent === "workbuddy" ? { ...entry, agent: "codebuddy" } : entry,
  );
}

function loadStoredEntries(storage: Pick<Storage, "getItem"> | null): StoredEntry[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(AGENT_GROUP_PREFERENCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return migrateStoredEntries(parsed).filter(isValidStoredEntry);
  } catch {
    return null;
  }
}

function saveStoredEntries(
  storage: Pick<Storage, "setItem"> | null,
  entries: readonly StoredEntry[],
): void {
  if (!storage) return;
  try {
    storage.setItem(AGENT_GROUP_PREFERENCE_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Persistence is best effort; quota/private-mode failures must not surface.
  }
}

function defaultLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function freshSectionMap(): Map<ExternalRendererAgent, AgentGroupSection> {
  return new Map(EXTERNAL_AGENTS.map((agent) => [agent, "main" as AgentGroupSection]));
}

/**
 * Builds a self-contained preference store. Tests pass their own `storage`
 * (or null) to keep cases isolated from the real `localStorage`.
 */
export function createAgentGroupPreferenceStore(
  storage: Storage | null = defaultLocalStorage(),
): AgentGroupPreferenceStore {
  let order: ExternalRendererAgent[] = [...EXTERNAL_AGENTS];
  let sections = freshSectionMap();
  const listeners = new Set<() => void>();

  const applyStored = (stored: readonly StoredEntry[]): void => {
    const placed = new Set<ExternalRendererAgent>();
    const restoredOrder: ExternalRendererAgent[] = [];
    for (const entry of stored) {
      const agent = entry.agent as ExternalRendererAgent;
      if (placed.has(agent)) continue;
      placed.add(agent);
      restoredOrder.push(agent);
      sections.set(agent, entry.section);
    }
    // Harnesses introduced after the user's last save join as "main" at the end.
    for (const agent of EXTERNAL_AGENTS) {
      if (!placed.has(agent)) restoredOrder.push(agent);
    }
    order = restoredOrder;
  };

  const toEntries = (): readonly AgentGroupEntry[] =>
    order.map((agent) => ({ agent, section: sections.get(agent) ?? "main" }));

  const announce = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const stored = loadStoredEntries(storage);
  if (stored && stored.length > 0) applyStored(stored);

  return {
    list() {
      return toEntries();
    },
    sectionOf(agent) {
      return sections.get(agent) ?? "main";
    },
    moveAgent(agent, section, beforeAgent = null) {
      if (!EXTERNAL_AGENTS.includes(agent)) return;
      order = order.filter((candidate) => candidate !== agent);
      const anchor =
        beforeAgent && beforeAgent !== agent ? order.indexOf(beforeAgent) : -1;
      if (anchor >= 0) order.splice(anchor, 0, agent);
      else order.push(agent);
      sections.set(agent, section);
      saveStoredEntries(storage, toEntries());
      announce();
    },
    resetToDefault() {
      order = [...EXTERNAL_AGENTS];
      sections = freshSectionMap();
      saveStoredEntries(storage, toEntries());
      announce();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let sharedStore: AgentGroupPreferenceStore | null = null;

/** One process-wide store so the Connections page and every picker agree. */
export function getSharedAgentGroupPreferenceStore(): AgentGroupPreferenceStore {
  if (!sharedStore) sharedStore = createAgentGroupPreferenceStore();
  return sharedStore;
}
