import type {
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessThinkingOptionId,
} from "@harnessmix/shared-contracts";

export const KNOWN_RENDERER_AGENTS = [
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
  "codex-harness",
] as const;
export const DEFAULT_RENDERER_AGENTS = [
  'codex',
  'pi',
  'omp',
  'claude-code',
  'deepseek-harness',
  'antigravity',
  'opencode',
  'grok',
  'openclaw',
  'hermes',
  'qoder',
  'codebuddy',
  'zcode',
  'trae',
  'cursor-cli',
  'kiro-cli',
  'cline',
  'codex-harness',
] as const;
export type RendererAgent = (typeof KNOWN_RENDERER_AGENTS)[number];
export type ExternalRendererAgent = Exclude<RendererAgent, "codex">;
export type RendererAgentAvailability =
  "checking" | "ready" | "notInstalled" | "unavailable" | "error";
export type ComposerAgentPhase = "draft" | "locked";

export interface DraftComposerState {
  agent: RendererAgent;
  phase: ComposerAgentPhase;
  composerId: string;
  codexAccountId?: string;
  piModel?: HarnessModelRef;
  piThinkingOptionId?: HarnessThinkingOptionId;
  claudeModel?: HarnessModelRef;
  claudeThinkingOptionId?: HarnessThinkingOptionId;
  deepSeekHarnessModel?: HarnessModelRef;
  openCodeModel?: HarnessModelRef;
  openCodeThinkingOptionId?: HarnessThinkingOptionId;
  grokModel?: HarnessModelRef;
  grokThinkingOptionId?: HarnessThinkingOptionId;
  ompModel?: HarnessModelRef;
  ompThinkingOptionId?: HarnessThinkingOptionId;
  antigravityModel?: HarnessModelRef;
  antigravityThinkingOptionId?: HarnessThinkingOptionId;
  kiroCliModel?: HarnessModelRef;
  kiroCliThinkingOptionId?: HarnessThinkingOptionId;
  openclawModel?: HarnessModelRef;
  openclawThinkingOptionId?: HarnessThinkingOptionId;
  hermesModel?: HarnessModelRef;
  hermesThinkingOptionId?: HarnessThinkingOptionId;
  qoderModel?: HarnessModelRef;
  qoderThinkingOptionId?: HarnessThinkingOptionId;
  codebuddyModel?: HarnessModelRef;
  codebuddyThinkingOptionId?: HarnessThinkingOptionId;
  zcodeModel?: HarnessModelRef;
  zcodeThinkingOptionId?: HarnessThinkingOptionId;
  traeModel?: HarnessModelRef;
  cursorModel?: HarnessModelRef;
  traeThinkingOptionId?: HarnessThinkingOptionId;
  cursorThinkingOptionId?: HarnessThinkingOptionId;
  clineModel?: HarnessModelRef;
  clineThinkingOptionId?: HarnessThinkingOptionId;
  codexHarnessModel?: HarnessModelRef;
  codexHarnessThinkingOptionId?: HarnessThinkingOptionId;
  permissionModeByAgent?: Partial<Record<ExternalRendererAgent, HarnessPermissionModeId>>;
}

/** Every external Agent, in catalog order. Used wherever Codex is excluded. */
const EXTERNAL_AGENT_IDS: readonly ExternalRendererAgent[] = KNOWN_RENDERER_AGENTS.filter(
  (agent): agent is ExternalRendererAgent => agent !== "codex",
);

/**
 * Per-Agent field addresses on {@link DraftComposerState}. Each external Agent
 * owns one model slot; most also own a thinking slot (DeepSeek Harness does
 * not expose one). Keeping the mapping in one table lets the rest of the
 * controller stay Agent-agnostic.
 */
type AgentModelSlot = {
  readonly model: {
    readonly [K in keyof DraftComposerState]-?: NonNullable<DraftComposerState[K]> extends HarnessModelRef
      ? K
      : never;
  }[keyof DraftComposerState];
  readonly thinking?: {
    readonly [K in keyof DraftComposerState]-?: NonNullable<
      DraftComposerState[K]
    > extends HarnessThinkingOptionId
      ? K
      : never;
  }[keyof DraftComposerState];
};

const AGENT_MODEL_SLOTS: Readonly<Record<ExternalRendererAgent, AgentModelSlot>> = {
  pi: { model: "piModel", thinking: "piThinkingOptionId" },
  "claude-code": { model: "claudeModel", thinking: "claudeThinkingOptionId" },
  "deepseek-harness": { model: "deepSeekHarnessModel" },
  opencode: { model: "openCodeModel", thinking: "openCodeThinkingOptionId" },
  grok: { model: "grokModel", thinking: "grokThinkingOptionId" },
  omp: { model: "ompModel", thinking: "ompThinkingOptionId" },
  antigravity: { model: "antigravityModel", thinking: "antigravityThinkingOptionId" },
  "kiro-cli": { model: "kiroCliModel", thinking: "kiroCliThinkingOptionId" },
  openclaw: { model: "openclawModel", thinking: "openclawThinkingOptionId" },
  hermes: { model: "hermesModel", thinking: "hermesThinkingOptionId" },
  qoder: { model: "qoderModel", thinking: "qoderThinkingOptionId" },
  codebuddy: { model: "codebuddyModel", thinking: "codebuddyThinkingOptionId" },
  zcode: { model: "zcodeModel", thinking: "zcodeThinkingOptionId" },
  trae: { model: "traeModel", thinking: "traeThinkingOptionId" },
  "cursor-cli": { model: "cursorModel", thinking: "cursorThinkingOptionId" },
  cline: { model: "clineModel", thinking: "clineThinkingOptionId" },
  "codex-harness": { model: "codexHarnessModel", thinking: "codexHarnessThinkingOptionId" },
};

function writeAgentModel(
  state: DraftComposerState,
  agent: ExternalRendererAgent,
  model: HarnessModelRef,
): void {
  state[AGENT_MODEL_SLOTS[agent].model] = model;
}

function writeAgentThinking(
  state: DraftComposerState,
  agent: ExternalRendererAgent,
  thinkingOptionId: HarnessThinkingOptionId | undefined,
): void {
  const slot = AGENT_MODEL_SLOTS[agent].thinking;
  if (slot === undefined) return;
  if (thinkingOptionId) state[slot] = thinkingOptionId;
  else delete state[slot];
}

type MutableComposerState = DraftComposerState;

/** One remembered (target → state) binding; targets are opaque composer keys. */
interface TargetBinding {
  target: readonly unknown[];
  state: MutableComposerState;
}

/**
 * Monotonic per-state generation counters. Every "begin" invalidates all
 * earlier generations for that state, so stale async replies (model catalogs,
 * ownership lookups) can be recognized and dropped by comparing numbers.
 */
class GenerationClock {
  readonly #latest = new WeakMap<MutableComposerState, number>();
  #issued = 0;

  begin(state: MutableComposerState): number {
    this.#issued += 1;
    this.#latest.set(state, this.#issued);
    return this.#issued;
  }

  current(state: MutableComposerState): number {
    return this.#latest.get(state) ?? 0;
  }
}

function defaultIdFactory(sequence: number): string {
  return `harnessmix-composer-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

/** "default" (new-Thread composer) vs "conversation" (existing Thread). */
function targetKind(target: readonly unknown[] | null): "default" | "conversation" | null {
  if (target === null) return null;
  if (target[0] === "default") return "default";
  if (target[0] === "conversation") return "conversation";
  return null;
}

/**
 * Only targets that actually identify something are worth remembering: any
 * conversation target, plus default targets that carry a derived draft id
 * (a bare ["default"] never becomes a stable identity).
 */
function isRememberedTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  if (target === null) return false;
  return target[0] === "conversation" || (target[0] === "default" && target.length > 1);
}

function targetsIdentical(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Type guard companion of targetKind for the conversation-only branches. */
function isConversationTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  return targetKind(target) === "conversation";
}

export interface DraftAgentControllerOptions {
  idFactory?: (sequence: number) => string;
  enabledAgents?: readonly RendererAgent[];
  defaultAgent?: RendererAgent;
}

export interface DraftAgentSwitchOperations {
  applyAgent(agent: RendererAgent): boolean;
  clearPrewarm(): Promise<void>;
}

export class DraftAgentController<Composer extends object> {
  readonly #idFactory: (sequence: number) => string;
  readonly #startupAgent: RendererAgent;
  readonly #allowedAgents: ReadonlySet<RendererAgent>;
  readonly #targetBindings: TargetBinding[] = [];
  readonly #modelRequestClock = new GenerationClock();
  readonly #ownershipRequestClock = new GenerationClock();
  readonly #states = new WeakMap<Composer, MutableComposerState>();
  /** Drafts the user configured by hand; they survive draft-id rebinds. */
  readonly #handTunedDrafts = new WeakSet<MutableComposerState>();
  readonly #inFlightSwitches = new Set<MutableComposerState>();
  readonly #queuedSubmissions = new Set<MutableComposerState>();
  #issuedComposerIds = 0;
  #lastSubmittedAgent: RendererAgent;

  constructor(options: DraftAgentControllerOptions = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#allowedAgents = new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS);
    if (!this.#allowedAgents.has("codex")) {
      throw new Error("Renderer enabled Agents must include Codex");
    }
    this.#startupAgent = options.defaultAgent ?? "codex";
    if (!this.#allowedAgents.has(this.#startupAgent)) {
      throw new Error("Renderer default Agent must be enabled");
    }
    this.#lastSubmittedAgent = this.#startupAgent;
  }

  get(composer: Composer): Readonly<DraftComposerState> {
    return this.#stateFor(composer);
  }

  mount(
    composer: Composer,
    target: readonly unknown[] | null,
    preferredNewThreadAgent?: RendererAgent,
  ): Readonly<DraftComposerState> {
    const remembered = this.#bindingFor(target);
    if (remembered) {
      this.#states.set(composer, remembered);
      return remembered;
    }
    const seeded = this.#stateFor(composer, this.#agentForFreshTarget(target, preferredNewThreadAgent));
    if (isRememberedTarget(target)) this.#targetBindings.push({ target, state: seeded });
    return seeded;
  }

  isSwitching(composer: Composer): boolean {
    return this.#inFlightSwitches.has(this.#stateFor(composer));
  }

  beginModelRequest(composer: Composer): number {
    return this.#modelRequestClock.begin(this.#stateFor(composer));
  }

  invalidateModelRequests(composer: Composer): void {
    this.beginModelRequest(composer);
  }

  isCurrentModelRequest(composer: Composer, generation: number): boolean {
    return this.#modelRequestClock.current(this.#stateFor(composer)) === generation;
  }

  beginOwnershipRequest(composer: Composer): number {
    return this.#ownershipRequestClock.begin(this.#stateFor(composer));
  }

  isCurrentOwnershipRequest(composer: Composer, generation: number): boolean {
    return this.#ownershipRequestClock.current(this.#stateFor(composer)) === generation;
  }

  rebindConversation(
    composer: Composer,
    target: readonly unknown[] | null,
  ): Readonly<DraftComposerState> | null {
    if (targetKind(target) !== "conversation") return null;
    return this.rebindTarget(composer, target);
  }

  rebindTarget(
    composer: Composer,
    target: readonly unknown[] | null,
    preferredNewThreadAgent?: RendererAgent,
  ): Readonly<DraftComposerState> | null {
    if (targetKind(target) === null) return null;
    const outgoing = this.#stateFor(composer);
    const wasQueued = this.#queuedSubmissions.delete(outgoing);
    this.#modelRequestClock.begin(outgoing);
    this.#ownershipRequestClock.begin(outgoing);

    let incoming = this.#bindingFor(target);
    if (incoming === null) {
      if (
        targetKind(target) === "default" &&
        outgoing.phase === "draft" &&
        this.#handTunedDrafts.has(outgoing)
      ) {
        // The Desktop can re-derive a new-Thread draft's id while keeping the
        // same composer element. A hand-tuned draft keeps its live selections
        // (Agent/Model); untouched drafts keep following the new-Thread seed.
        incoming = outgoing;
        if (wasQueued) this.#queuedSubmissions.add(incoming);
      } else {
        incoming = {
          agent: this.#agentForFreshTarget(target, preferredNewThreadAgent),
          phase: "draft",
          composerId: this.#idFactory(++this.#issuedComposerIds),
        };
      }
      if (isRememberedTarget(target)) this.#targetBindings.push({ target, state: incoming });
    }
    this.#states.set(composer, incoming);
    this.#modelRequestClock.begin(incoming);
    this.#ownershipRequestClock.begin(incoming);
    return incoming;
  }

  restore(
    composer: Composer,
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
    codexAccountId?: string,
  ): Readonly<DraftComposerState> | null {
    if (!this.#allowedAgents.has(agent)) return null;
    const state = this.#stateFor(composer);
    this.#queuedSubmissions.delete(state);
    state.agent = agent;
    state.phase = "locked";
    if (agent === "codex" && codexAccountId) state.codexAccountId = codexAccountId;
    else delete state.codexAccountId;
    if (agent !== "codex") {
      if (model) writeAgentModel(state, agent, model);
      writeAgentThinking(state, agent, thinkingOptionId);
      this.#rebuildPermissionModes(state, agent, permissionModeId);
    }
    return state;
  }

  modelForAgent(composer: Composer, agent: RendererAgent): HarnessModelRef | undefined {
    const state = this.#stateFor(composer);
    if (agent === "codex") return undefined;
    return state[AGENT_MODEL_SLOTS[agent].model];
  }

  thinkingOptionForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessThinkingOptionId | undefined {
    const slot = AGENT_MODEL_SLOTS[agent].thinking;
    if (slot === undefined) return undefined;
    return this.#stateFor(composer)[slot];
  }

  permissionModeForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessPermissionModeId | undefined {
    return this.#stateFor(composer).permissionModeByAgent?.[agent];
  }

  setExternalPermissionMode(
    composer: Composer,
    agent: ExternalRendererAgent,
    permissionModeId: HarnessPermissionModeId,
  ): Readonly<DraftComposerState> {
    const state = this.#stateFor(composer);
    state.permissionModeByAgent = {
      ...state.permissionModeByAgent,
      [agent]: permissionModeId,
    };
    this.#noteHandTuned(state);
    return state;
  }

  setExternalModel(
    composer: Composer,
    agent: ExternalRendererAgent,
    model: HarnessModelRef,
  ): Readonly<DraftComposerState> {
    const state = this.#stateFor(composer);
    writeAgentModel(state, agent, model);
    this.#noteHandTuned(state);
    return state;
  }

  setPiConfiguration(
    composer: Composer,
    model: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    const state = this.#stateFor(composer);
    state.piModel = model;
    if (thinkingOptionId) state.piThinkingOptionId = thinkingOptionId;
    else delete state.piThinkingOptionId;
    this.#noteHandTuned(state);
    return state;
  }

  setPiModel(composer: Composer, model: HarnessModelRef): Readonly<DraftComposerState> {
    return this.setExternalModel(composer, "pi", model);
  }

  setExternalThinkingOption(
    composer: Composer,
    agent: ExternalRendererAgent,
    thinkingOptionId?: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    const state = this.#stateFor(composer);
    writeAgentThinking(state, agent, thinkingOptionId);
    this.#noteHandTuned(state);
    return state;
  }

  setPiThinkingOption(
    composer: Composer,
    thinkingOptionId: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    return this.setExternalThinkingOption(composer, "pi", thinkingOptionId);
  }

  lock(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#stateFor(composer);
    this.#queuedSubmissions.delete(state);
    state.phase = "locked";
    return state;
  }

  markSubmissionPending(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#stateFor(composer);
    if (state.phase === "draft") this.#queuedSubmissions.add(state);
    return state;
  }

  isSubmissionPending(composer: Composer): boolean {
    return this.#queuedSubmissions.has(this.#stateFor(composer));
  }

  clearPendingSubmission(composer: Composer): void {
    const state = this.#stateFor(composer);
    this.#queuedSubmissions.delete(state);
    if (state.phase === "draft") delete state.codexAccountId;
  }

  recordSubmission(composer: Composer, codexAccountId?: string): Readonly<DraftComposerState> {
    const state = this.#stateFor(composer);
    if (
      state.agent === "codex" &&
      state.phase === "draft" &&
      !state.codexAccountId &&
      codexAccountId
    ) {
      state.codexAccountId = codexAccountId;
    }
    this.#lastSubmittedAgent = state.agent;
    return state;
  }

  transfer(
    source: Composer,
    replacement: Composer,
    target: readonly unknown[] | null = null,
  ): boolean {
    const state = this.#states.get(source);
    if (!state) return false;
    const alreadyBound = this.#bindingFor(target);
    if (alreadyBound && alreadyBound !== state) return false;
    if (source !== replacement) {
      if (this.#states.has(replacement)) return false;
      this.#states.set(replacement, state);
    }
    if (isConversationTarget(target) && !alreadyBound) {
      if (state.phase === "locked" || this.#queuedSubmissions.has(state)) {
        // Once a state belongs to a real Thread (or is about to), any stale
        // remembered bindings pointing at it must go so the identity is not
        // shared with an unrelated draft target.
        for (let index = this.#targetBindings.length - 1; index >= 0; index -= 1) {
          if (this.#targetBindings[index]?.state === state) this.#targetBindings.splice(index, 1);
        }
      }
      this.#targetBindings.push({ target, state });
    }
    if (isConversationTarget(target) && this.#queuedSubmissions.delete(state)) {
      state.phase = "locked";
    }
    return true;
  }

  async switchAgent(
    composer: Composer,
    nextAgent: RendererAgent,
    operations: DraftAgentSwitchOperations,
  ): Promise<boolean> {
    const state = this.#stateFor(composer);
    if (!this.#allowedAgents.has(nextAgent)) return false;
    if (state.phase !== "draft" || this.#inFlightSwitches.has(state)) return false;
    if (state.agent === nextAgent) return true;

    this.#queuedSubmissions.delete(state);

    this.#inFlightSwitches.add(state);
    try {
      if (!operations.applyAgent(nextAgent)) return false;
      try {
        await operations.clearPrewarm();
      } catch (error) {
        if (!operations.applyAgent(state.agent)) {
          throw new Error("Draft Agent switch could not restore the prior Agent", {
            cause: error,
          });
        }
        return false;
      }
      state.agent = nextAgent;
      this.#handTunedDrafts.add(state);
      return true;
    } finally {
      this.#inFlightSwitches.delete(state);
    }
  }

  /** Rebuilds the permission-mode map around one restored Agent. */
  #rebuildPermissionModes(
    state: MutableComposerState,
    agent: ExternalRendererAgent,
    permissionModeId: HarnessPermissionModeId | undefined,
  ): void {
    const retained: NonNullable<DraftComposerState["permissionModeByAgent"]> = {};
    for (const otherAgent of EXTERNAL_AGENT_IDS) {
      if (otherAgent === agent) continue;
      const existing = state.permissionModeByAgent?.[otherAgent];
      if (existing) retained[otherAgent] = existing;
    }
    if (permissionModeId) retained[agent] = permissionModeId;
    if (Object.keys(retained).length > 0) state.permissionModeByAgent = retained;
    else delete state.permissionModeByAgent;
  }

  #noteHandTuned(state: MutableComposerState): void {
    if (state.phase === "draft") this.#handTunedDrafts.add(state);
  }

  /**
   * Seed Agent for a target with no remembered state yet: new-Thread composers
   * follow the caller's preference (or the last submission); conversation
   * composers always start as Codex.
   */
  #agentForFreshTarget(
    target: readonly unknown[] | null,
    preferredNewThreadAgent?: RendererAgent,
  ): RendererAgent {
    if (targetKind(target) !== "default") return "codex";
    if (preferredNewThreadAgent && this.#allowedAgents.has(preferredNewThreadAgent)) {
      return preferredNewThreadAgent;
    }
    return this.#lastSubmittedAgent;
  }

  #bindingFor(target: readonly unknown[] | null): MutableComposerState | null {
    if (!isRememberedTarget(target)) return null;
    return (
      this.#targetBindings.find((binding) => targetsIdentical(binding.target, target))?.state ??
      null
    );
  }

  #stateFor(composer: Composer, initialAgent?: RendererAgent): MutableComposerState {
    const existing = this.#states.get(composer);
    if (existing) return existing;
    const created: MutableComposerState = {
      agent: initialAgent ?? this.#startupAgent,
      phase: "draft",
      composerId: this.#idFactory(++this.#issuedComposerIds),
    };
    this.#states.set(composer, created);
    return created;
  }
}
