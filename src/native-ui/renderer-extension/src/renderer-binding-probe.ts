import {
  decodeHarnessPluginRoute,
  harnessIdSchema,
  hostThreadIdSchema,
  permissionModeFixedAtCreate,
  type HarnessCommandDescriptor,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessModelSelectionState,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessPermissionModeScope,
  type HarnessThinkingOptionId,
  type AccountCreditsSnapshot,
  type ThreadInspection,
  type ThreadUsageInspection,
  type ThreadUsageSnapshot,
  type HarnessMixError,
} from "@harnessmix/shared-contracts";

import {
  DEFAULT_RENDERER_AGENTS,
  DraftAgentController,
  type ComposerAgentPhase,
  type ExternalRendererAgent,
  type RendererAgent,
  type RendererAgentAvailability,
} from "./agent-selection-state.js";
import {
  CODEX_COMPOSER_SELECTOR,
  EDITOR_SELECTOR,
  composerForEditor,
  composerForElement,
  disposeComposerAgentControl,
  editorForElement,
  eventElement,
  isComposerInputIntent,
  isComposerSubmissionKey,
  mountComposerAgentControl,
  reconcileComposerNativeControls,
  renderComposerAgentControl,
  isComposerStopButton,
  sendButtonWithin,
  type ComposerAgentControl,
  type ExternalModelControlView,
  type ExternalPermissionModeControlView,
} from "./renderer-composer-dom.js";
import { rendererHarnessMessages } from "./renderer-harness-localization.js";
import {
  codexAccountRouteOverride,
  RendererCodexAccountState,
} from "./renderer-codex-account-state.js";
import {
  decodeAntigravityTransportModelId,
  decodeClaudeTransportModelId,
  decodeDeepSeekHarnessTransportModelId,
  decodeGrokTransportModelId,
  decodeOmpTransportModelId,
  decodeOpenCodeTransportModelId,
  decodePiTransportModelId,
  findComposerModelTarget,
  threadIdFromComposerModelTarget,
  waitForRendererDraftPrewarmPolicy,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import { RENDERER_AGENT_INSTALL_URLS } from "./renderer-agent-picker.js";
import {
  readClaudePermissionModePreference,
  writeClaudePermissionModePreference,
} from "./renderer-permission-mode-preference.js";
import { isPermissionModeControlReady } from "./renderer-permission-mode-picker.js";
import {
  readNewThreadAgentPreference,
  readNewThreadExternalConfigurationPreference,
  writeNewThreadAgentPreference,
  writeNewThreadExternalConfigurationPreference,
} from "./renderer-new-thread-preference.js";
import { installRendererSidebarAgentIcons } from "./renderer-sidebar-agent-icons.js";
import { installHarnessMentions } from "./renderer-harness-mentions.js";
import { installCollabCards } from "./renderer-collab-cards.js";
import { installTeamCards } from "./renderer-team-cards.js";
import {
  rendererHarnessCommandExecutesDirectly,
  routeRendererHarnessCommandSelection,
} from "./renderer-harness-command-claim.js";
import { installRendererSettingsLifecycle } from "./harness-mix-settings.js";
import { openRendererThread } from "./renderer-fork-control.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "./settings/pages.js";
import type { RendererHarnessHandoffRequest } from "./renderer-harness-handoff.js";

export { resolveCodexAccountSelection } from "./renderer-codex-account-state.js";

// Every foreign harness the probe tracks for availability. Keyed route ids are
// parsed once so per-composer work reuses the validated branded strings.
const externalHarnessIds = {
  pi: harnessIdSchema.parse("pi"),
  "claude-code": harnessIdSchema.parse("claude-code"),
  "deepseek-harness": harnessIdSchema.parse("deepseek-harness"),
  opencode: harnessIdSchema.parse("opencode"),
  grok: harnessIdSchema.parse("grok"),
  omp: harnessIdSchema.parse("omp"),
  antigravity: harnessIdSchema.parse("antigravity"),
  "kiro-cli": harnessIdSchema.parse("kiro-cli"),
  openclaw: harnessIdSchema.parse("openclaw"),
  hermes: harnessIdSchema.parse("hermes"),
  qoder: harnessIdSchema.parse("qoder"),
  codebuddy: harnessIdSchema.parse("codebuddy"),
  zcode: harnessIdSchema.parse("zcode"),
  trae: harnessIdSchema.parse("trae"),
  'cursor-cli': harnessIdSchema.parse("cursor-cli"),
  cline: harnessIdSchema.parse("cline"),
  'codex-harness': harnessIdSchema.parse('codex-harness'),
} as const;

const externalAgents: readonly ExternalRendererAgent[] = [
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
  'codex-harness',
];
type HarnessAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;
type HarnessAvailabilityErrors = Record<ExternalRendererAgent, HarnessMixError | undefined>;
type HarnessWebUiAvailability = Record<ExternalRendererAgent, boolean>;

function availabilityIsRetryable(
  availability: RendererAgentAvailability | undefined,
  error: HarnessMixError | undefined,
): boolean {
  return (
    availability !== undefined &&
    availability !== "ready" &&
    availability !== "notInstalled" &&
    error?.retryable === true
  );
}

export function retryableHarnessAvailabilityAgents(
  availability: HarnessAvailability,
  errors: HarnessAvailabilityErrors,
): ExternalRendererAgent[] {
  return externalAgents.filter((agent) =>
    availabilityIsRetryable(availability[agent], errors[agent]),
  );
}

export function passiveHarnessAvailabilityAgents(
  availability: HarnessAvailability,
  errors: HarnessAvailabilityErrors,
): ExternalRendererAgent[] {
  return externalAgents.filter(
    (agent) =>
      availability[agent] === "checking" ||
      availabilityIsRetryable(availability[agent], errors[agent]),
  );
}

/** While an inspect or retry is in flight, keep showing the last known state. */
export function harnessAvailabilityDuringInspect(
  current: RendererAgentAvailability | undefined,
): RendererAgentAvailability {
  return current ?? "checking";
}

export function shouldRefreshCodexAccountsForAdapterState(
  state: RendererAdapterStatus["state"],
): boolean {
  return state === "ready";
}

// Backoff ladder for usage polls that have not produced a full snapshot yet.
const rendererUsageRefreshDelays = [250, 500, 1000, 2000, 4000, 8000] as const;

export function refreshConnectionHosts(
  hostIds: Iterable<string>,
  refreshHost: (hostId: string) => Promise<void>,
): Promise<void> {
  return Promise.all([...hostIds].map((hostId) => refreshHost(hostId))).then(() => undefined);
}

export function rendererUsageRefreshDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attempt), rendererUsageRefreshDelays.length - 1));
  return rendererUsageRefreshDelays[index] ?? rendererUsageRefreshDelays[0];
}

/**
 * Fail closed for a Codex draft submission while the composer's Codex account
 * routing state is still unknown (fresh request manager, account list not yet
 * loaded) on a Host that has been seen carrying isolated, Harness-Mix-routed
 * Codex accounts. Letting the submission through in that window would drop the
 * account route marker and create the thread on the official Codex route — the
 * duplicate sidebar-session regression. Hosts without isolated accounts, or
 * composers without an owned bridge for their Host, pass through unchanged.
 */
export function shouldBlockCodexDraftSubmission(input: {
  accountsResolved: boolean;
  accountsLoaded: boolean;
  hostIsolatedAccountsLatched: boolean;
  policyHostId: string | null;
  composerHostId: string | null;
}): boolean {
  if (input.accountsResolved && input.accountsLoaded) return false;
  if (!input.hostIsolatedAccountsLatched) return false;
  if (input.composerHostId === null) return false;
  return input.policyHostId === input.composerHostId;
}

/**
 * Agents whose account-level Credits exist independently of a Thread Usage
 * snapshot. Retrying usage is only worthwhile for them once Usage itself has
 * already arrived.
 */
function agentReportsAccountCredits(agent: RendererAgent): boolean {
  return (
    agent === "codex" ||
    agent === "grok" ||
    agent === "claude-code" ||
    agent === "antigravity"
  );
}

export function shouldRetryExternalThreadUsage(
  agent: RendererAgent,
  usage: ThreadUsageSnapshot | null,
  accountCredits: AccountCreditsSnapshot | null = null,
): boolean {
  if (usage === null) return true;
  return agentReportsAccountCredits(agent) && accountCredits === null;
}

export function shouldReloadExternalCatalogAfterAvailabilityRefresh(
  previous: RendererAgentAvailability | undefined,
  next: RendererAgentAvailability,
  configurationReady: boolean,
  explicitRefresh = false,
): boolean {
  return explicitRefresh || previous !== next || !configurationReady;
}

function externalViewsReady(
  modelView: ExternalModelControlView,
  permissionModeView: ExternalPermissionModeControlView,
): boolean {
  return (
    modelView.status !== "selecting" &&
    modelView.catalog?.models.some((model) => model.ref.id === modelView.selected?.id) === true &&
    isPermissionModeControlReady(permissionModeView)
  );
}

function externalViewsSettled(
  modelView: ExternalModelControlView,
  permissionModeView: ExternalPermissionModeControlView,
): boolean {
  return (
    (modelView.status === "empty" && isPermissionModeControlReady(permissionModeView)) ||
    externalViewsReady(modelView, permissionModeView)
  );
}

export interface RendererBindingProbeStatus {
  version: 2;
  mountedComposers: number;
  enabledAgents: RendererAgent[];
  availability: HarnessAvailability;
  selections: Array<{
    composerId: string;
    agent: RendererAgent;
    phase: ComposerAgentPhase;
  }>;
  adapter: RendererAdapterStatus;
}

export interface RendererBindingProbeOptions {
  enabledAgents?: readonly RendererAgent[];
  defaultAgent?: RendererAgent;
}

type ApplyAdapterAgent = (
  agent: RendererAgent,
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
  composer?: Element,
) => boolean;

export interface RendererBindingProbeApi {
  status(): RendererBindingProbeStatus;
  lockedSelection(): LockedComposerSelection | null;
  setAdapter(
    status: RendererAdapterStatus,
    dispose?: () => void,
    applyAgent?: ApplyAdapterAgent,
    modelControl?: RendererModelClient | null,
  ): void;
  dispose(): void;
}

declare global {
  interface Window {
    __harnessmixRendererBindingProbeV1?: RendererBindingProbeApi;
    __harnessmixSidecarModeV1?: boolean;
  }
}

export type ComposerOwnershipStatus = "not-required" | "loading" | "ready" | "error";

export interface RestoredThreadOwnership {
  agent: RendererAgent;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

function thinkingOptionInSelection(
  state: HarnessModelSelectionState,
): HarnessThinkingOptionId | undefined {
  return state.effectiveThinkingOptionId &&
    state.availableThinkingOptions?.some(({ id }) => id === state.effectiveThinkingOptionId)
    ? state.effectiveThinkingOptionId
    : undefined;
}

export function draftThinkingOptionForModel(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef,
  requested: HarnessThinkingOptionId | undefined,
): HarnessThinkingOptionId | undefined {
  const options = thinkingOptionsForModel(catalog, model);
  // With no explicit choice and no catalog-declared default, stay unselected:
  // the native session then applies its own default instead of silently
  // inheriting the catalog's first entry (for example Pi's "off").
  return (
    options.find(({ id }) => id === requested)?.id ??
    options.find(({ id }) => id === catalog.defaultThinkingOptionId)?.id
  );
}

export function draftPermissionMode(
  catalog: HarnessPermissionModeCatalog,
  requested: HarnessPermissionModeId | undefined,
): HarnessPermissionModeId {
  return (
    catalog.modes.find(({ id }) => id === requested)?.id ??
    catalog.modes.find(({ id }) => id === catalog.defaultModeId)?.id ??
    catalog.defaultModeId
  );
}

export function lockedPermissionMode(
  catalog: HarnessPermissionModeCatalog,
  effective: HarnessPermissionModeId | undefined,
  carrier: HarnessPermissionModeId | undefined,
): HarnessPermissionModeId | undefined {
  const restored = effective ?? carrier;
  if (restored && !catalog.modes.some(({ id }) => id === restored)) {
    throw new Error("Existing Thread Permission Mode is absent from the current Catalog");
  }
  return restored;
}

export function permissionModeSelectionLocked(input: {
  phase: ComposerAgentPhase;
  permissionModeScope?: HarnessPermissionModeScope;
}): boolean {
  return input.phase === "locked" && permissionModeFixedAtCreate(input);
}

export function shouldPersistNewThreadConfigurationSelection(phase: ComposerAgentPhase): boolean {
  return phase === "draft";
}

function ownershipWithOptionalFields(
  agent: RendererAgent,
  model: HarnessModelRef | undefined,
  thinkingOptionId: HarnessThinkingOptionId | undefined,
  permissionModeId: HarnessPermissionModeId | undefined,
): RestoredThreadOwnership {
  return {
    agent,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(permissionModeId ? { permissionModeId } : {}),
  };
}

export function restoredThreadOwnership(inspection: ThreadInspection): RestoredThreadOwnership {
  if (inspection.owner === "codex") return { agent: "codex" };
  if (inspection.harnessId === "pi") {
    const transportSelection = decodePiTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Pi Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      "pi",
      inspection.effectiveModel ?? transportSelection.model,
      thinkingOptionInSelection(inspection) ?? transportSelection.thinkingOptionId,
      inspection.effectivePermissionModeId,
    );
  }
  if (inspection.harnessId === "grok") {
    const transportSelection = decodeGrokTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Grok Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      "grok",
      inspection.effectiveModel ?? transportSelection.model,
      thinkingOptionInSelection(inspection) ?? transportSelection.thinkingOptionId,
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId,
    );
  }
  if (inspection.harnessId === "omp") {
    const transportSelection = decodeOmpTransportModelId(inspection.transportModelId);
    if (!transportSelection) throw new Error("OMP Thread reported an incompatible transport Model");
    return ownershipWithOptionalFields(
      "omp",
      inspection.effectiveModel ?? transportSelection.model,
      thinkingOptionInSelection(inspection) ?? transportSelection.thinkingOptionId,
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId,
    );
  }
  if (inspection.harnessId === "claude-code") {
    const transportSelection = decodeClaudeTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Claude Code Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      "claude-code",
      inspection.effectiveModel ?? transportSelection.model,
      thinkingOptionInSelection(inspection) ?? transportSelection.thinkingOptionId,
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId,
    );
  }
  if (inspection.harnessId === "deepseek-harness") {
    const transportSelection = decodeDeepSeekHarnessTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("DeepSeek Harness Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      "deepseek-harness",
      inspection.effectiveModel ?? transportSelection.model,
      undefined,
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId,
    );
  }
  if (inspection.harnessId === "opencode") {
    const transportSelection = decodeOpenCodeTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("OpenCode Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      "opencode",
      inspection.effectiveModel ?? transportSelection.model,
      thinkingOptionInSelection(inspection) ?? transportSelection.thinkingOptionId,
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId,
    );
  }
  if (inspection.harnessId === "antigravity") {
    const transportSelection = decodeAntigravityTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Antigravity Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      "antigravity",
      inspection.effectiveModel ?? transportSelection.model,
      thinkingOptionInSelection(inspection) ?? transportSelection.thinkingOptionId,
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId,
    );
  }
  if (inspection.harnessId === "kiro-cli") {
    const route = decodeHarnessPluginRoute(inspection.transportModelId);
    if (!route || route.harnessId !== "kiro-cli") {
      throw new Error("Kiro Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      "kiro-cli",
      inspection.effectiveModel ?? route.model,
      inspection.availableThinkingOptions !== undefined
        ? thinkingOptionInSelection(inspection)
        : (inspection.effectiveThinkingOptionId ?? route.thinkingOptionId),
      inspection.effectivePermissionModeId ?? route.permissionModeId,
    );
  }
  if (inspection.harnessId === "openclaw" || inspection.harnessId === "hermes" || inspection.harnessId === 'codex-harness' || inspection.harnessId === 'qoder' || inspection.harnessId === 'codebuddy' || inspection.harnessId === 'zcode' || inspection.harnessId === 'trae' || inspection.harnessId === 'cursor-cli' || inspection.harnessId === 'cline') {
    const harnessId = inspection.harnessId;
    const route = decodeHarnessPluginRoute(inspection.transportModelId);
    if (!route || route.harnessId !== harnessId) {
      throw new Error("Thread reported an incompatible transport Model");
    }
    return ownershipWithOptionalFields(
      harnessId,
      inspection.effectiveModel ?? route.model,
      inspection.availableThinkingOptions !== undefined
        ? thinkingOptionInSelection(inspection)
        : (inspection.effectiveThinkingOptionId ?? route.thinkingOptionId),
      inspection.effectivePermissionModeId ?? route.permissionModeId,
    );
  }
  throw new Error("Thread owner is not a Renderer Agent");
}

export function isOwnershipSubmissionBlocked(status: ComposerOwnershipStatus): boolean {
  return status === "loading" || status === "error";
}

interface ComposerEntry {
  composer: Element;
  composerId: string;
  control: ComposerAgentControl;
  modelTarget: readonly unknown[] | null;
  modelView: ExternalModelControlView;
  permissionModeView: ExternalPermissionModeControlView;
  ownershipStatus: ComposerOwnershipStatus;
  threadConfiguration: HarnessModelSelectionState | undefined;
  usage: ThreadUsageSnapshot | null;
  accountCredits: AccountCreditsSnapshot | null;
  hostId: string | null;
  usageRequestGeneration: number;
  commandRequestGeneration: number;
  harnessSwitching: boolean;
}

interface ComposerReplacement {
  source: ComposerEntry;
  sourceModelTarget: readonly unknown[] | null;
}

type SubmissionTrigger = "click" | "enter" | "submit";

export function shouldTransferComposerState(
  sourceTarget: readonly unknown[] | null,
  replacementTarget: readonly unknown[] | null,
  sourcePhase: ComposerAgentPhase,
  submissionPending = false,
): boolean {
  if (!sourceTarget || !replacementTarget) return false;
  if (sourceTarget === replacementTarget) return true;
  return (
    (sourcePhase === "locked" || submissionPending) &&
    sourceTarget[0] === "default" &&
    replacementTarget[0] === "conversation"
  );
}

export function isLateConversationTarget(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
): boolean {
  if (currentTarget?.[0] !== "conversation") return false;
  if (mountedTarget === null) return true;
  if (mountedTarget?.[0] === "default") return true;
  if (mountedTarget?.[0] !== "conversation") return false;
  return (
    mountedTarget.length !== currentTarget.length ||
    mountedTarget.some((value, index) => value !== currentTarget[index])
  );
}

export function composerTargetResolution(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
  sourcePhase: ComposerAgentPhase,
  submissionPending = false,
): "none" | "transfer" | "inspect" | "restore-draft" {
  if (!currentTarget) return "none";
  if (
    mountedTarget &&
    mountedTarget.length === currentTarget.length &&
    mountedTarget.every((value, index) => value === currentTarget[index])
  ) {
    return "none";
  }
  if (currentTarget[0] === "default") return "restore-draft";
  if (currentTarget[0] !== "conversation") return "none";
  return mountedTarget?.[0] === "default" && (sourcePhase === "locked" || submissionPending)
    ? "transfer"
    : "inspect";
}

export function lateConversationTargetResolution(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
  sourcePhase: ComposerAgentPhase,
  submissionPending = false,
): "none" | "transfer" | "inspect" {
  const resolution = composerTargetResolution(
    mountedTarget,
    currentTarget,
    sourcePhase,
    submissionPending,
  );
  return resolution === "restore-draft" ? "none" : resolution;
}

export function scopedComposerTarget(
  target: readonly unknown[] | null,
  hostId: string | null,
): readonly unknown[] | null {
  if (target?.[0] !== "conversation" || !hostId) return target;
  return ["conversation", target[1], hostId];
}

export function isComposerModelWriteAllowed(target: readonly unknown[] | null): boolean {
  return target?.[0] === "default";
}

export function shouldApplyDraftAgentCarrier(
  agent: RendererAgent,
  model: HarnessModelRef | undefined,
): boolean {
  return agent === "codex" || model !== undefined;
}

export function applyComposerModelWrite(
  target: readonly unknown[] | null,
  write: () => boolean,
): boolean {
  if (target?.[0] === "conversation") return true;
  if (!isComposerModelWriteAllowed(target)) return false;
  return write();
}

function mutationTouchesComposerTarget(mutation: MutationRecord): boolean {
  const target =
    mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  return !target || editorForElement(target) === null;
}

/** Overlay a thread's own selection state onto a harness model catalog. */
function catalogOverlayedWithThreadState(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef,
  state: HarnessModelSelectionState,
): HarnessModelCatalog {
  if (!state.availableThinkingOptions) return catalog;
  const supportedThinkingOptionIds = state.availableThinkingOptions.map(({ id }) => id);
  const models = catalog.models.map((candidate) => {
    const normalized = { ...candidate };
    delete normalized.supportedThinkingOptionIds;
    return candidate.ref.id === model.id
      ? { ...normalized, supportedThinkingOptionIds }
      : normalized;
  });
  const overlay = {
    ...catalog,
    models,
    defaultModel: model,
    thinkingOptions: state.availableThinkingOptions,
  };
  if (state.effectiveThinkingOptionId) {
    overlay.defaultThinkingOptionId = state.effectiveThinkingOptionId;
  } else {
    delete overlay.defaultThinkingOptionId;
  }
  return overlay;
}

interface HostAvailabilityState {
  codexAccounts: RendererCodexAccountState | null;
  // Sticky flag: this Host has at least once reported an isolated
  // (Harness-Mix-routed) Codex account. It survives account-state recreation
  // so the submission guard can keep failing closed while the per-client state
  // rebuilds.
  codexAccountsIsolated: boolean;
  availability: HarnessAvailability;
  errors: HarnessAvailabilityErrors;
  webUi: HarnessWebUiAvailability;
  requestGeneration: number;
  request: { client: RendererModelClient; promise: Promise<void> } | null;
  retryTimer: number | null;
  retryAttempt: number;
}

export function installRendererBindingProbe(
  options: RendererBindingProbeOptions = {},
): RendererBindingProbeApi {
  const existing = window.__harnessmixRendererBindingProbeV1;
  if (existing) return existing;

  const enabledAgents = [...new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS)];
  const enabledAgentSet = new Set(enabledAgents);
  const controller = new DraftAgentController<Element>({
    enabledAgents,
    ...(options.defaultAgent ? { defaultAgent: options.defaultAgent } : {}),
  });
  const composerEntries = new Map<Element, ComposerEntry>();
  const replacementQueue = new Map<Element, ComposerReplacement>();
  let disposed = false;
  let scanScheduled = false;
  let refreshTargetsOnNextScan = false;
  let adapterDispose: (() => void) | null = null;
  let applyAdapterAgent: ApplyAdapterAgent | null = null;
  let modelControl: RendererModelClient | null = null;
  const activeModelHostId = (): string | null => {
    if (!modelControl) return null;
    return modelControl.currentHostId ? modelControl.currentHostId() : "local";
  };
  const controllerTarget = (target: readonly unknown[] | null, hostId: string | null) =>
    scopedComposerTarget(target, hostId);
  let usageNotificationDispose: (() => void) | null = null;
  const sidebarAgentForThread = (input: {
    hostId: string;
    threadId: string | null;
    draftId: string | null;
  }): RendererAgent | null => {
    const mountedHostId = modelControl?.currentHostId?.() ?? "local";
    if (input.hostId !== mountedHostId) return null;
    for (const mounted of composerEntries.values()) {
      const target = mounted.modelTarget;
      if (target?.[0] === "default" && input.draftId !== null && target[1] === input.draftId) {
        return controller.get(mounted.composer).agent;
      }
      if (
        target?.[0] === "conversation" &&
        input.threadId !== null &&
        target[1] === input.threadId &&
        mounted.ownershipStatus === "ready"
      ) {
        return controller.get(mounted.composer).agent;
      }
    }
    return null;
  };
  const sidebarIcons = installRendererSidebarAgentIcons({
    getClient: (hostId) => modelClientForHost(hostId),
    getLocalAgent: sidebarAgentForThread,
  });
  const mentionsBridge = installHarnessMentions(async (editor, query) => {
    const composer = editor.closest('[data-codex-composer-root]');
    if (!composer) return { agents: [], sessions: [] };
    const state = controller.get(composer);
    const client = modelClientForHost(modelControl?.currentHostId?.() ?? 'local');
    // A thread-scoped composer carries its threadId so project-scoped team
    // templates (.harness-mix/teams/*.md) merge into the # menu by cwd; a
    // brand-new draft has none and only sees user/builtin templates.
    const templateThreadId = threadIdFromComposerModelTarget(composerEntries.get(composer)?.modelTarget ?? null);
    const [agentResult, sessionResult, prefsResult, templateResult] = await Promise.allSettled([
      client?.listCollaborationAgents?.() ?? Promise.resolve([]),
      client?.listHarnessSessions?.({ harnessId: harnessIdSchema.parse('all-harnesses'), query, offset: 0, limit: 12 }) ?? Promise.resolve({ candidates: [], total: 0 }),
      client?.getCollaborationPreferences?.() ?? Promise.resolve({ collaboration: true, agentTeam: true }),
      client?.listTeamTemplates?.(templateThreadId ? { threadId: templateThreadId } : {}) ?? Promise.resolve({ templates: [] }),
    ]);
    const collaborationEnabled = prefsResult.status === 'fulfilled' ? prefsResult.value.collaboration !== false : true;
    const teamEnabled = prefsResult.status === 'fulfilled' ? prefsResult.value.agentTeam !== false : true;
    const agents = collaborationEnabled && agentResult.status === 'fulfilled' ? agentResult.value : [];
    (window as any).__lastMentionDebug = {
      hasClient: !!client,
      agentStatus: agentResult.status,
      agentValue: agentResult.status === 'fulfilled' ? agentResult.value : (agentResult as any).reason?.message,
      sessionStatus: sessionResult.status,
      sessionValue: sessionResult.status === 'fulfilled' ? sessionResult.value : (sessionResult as any).reason?.message,
    };
    const sessions = sessionResult.status === 'fulfilled' ? sessionResult.value.candidates.map(candidate => {
      const match = /^\[([^\]]+)\]\s*/.exec(candidate.title ?? '');
      return { id: candidate.nativeSessionId, title: (candidate.title ?? '未命名会话').replace(/^\[[^\]]+\]\s*/, ''), harnessId: match?.[1] ?? 'codex', cwd: candidate.cwd, running: candidate.running };
    }) : [];
    const templates = collaborationEnabled && teamEnabled && templateResult.status === 'fulfilled'
      && Array.isArray((templateResult.value as { templates?: unknown[] })?.templates)
      ? (templateResult.value as { templates: Array<{ id: string; name: string; description: string; members: Array<{ name: string; role: string; agent: string; available: boolean }> }> }).templates
        .filter(template => template && typeof template.id === 'string' && Array.isArray(template.members))
        .map(template => ({ ...template, members: template.members.filter(member => member && typeof member.name === 'string') }))
      : [];
    return { agents, sessions, templates, canDelegate: agents.some(agent => agent.id === state.agent && agent.lead) };
  });
  const collaborationCards = installCollabCards({
    openThread: (threadId) => openRendererThread(threadId, { hostId: 'local' }),
    reviewWorkspace: async (threadId) => {
      const client = modelClientForHost('local');
      return (client as any)?.reviewThreadWorkspace?.({ threadId }) ?? { patch: '', digest: '' };
    },
    applyWorkspace: async (threadId, digest) => {
      const client = modelClientForHost('local');
      return (client as any)?.applyThreadWorkspace?.({ threadId, digest }) ?? { patch: '', digest: '' };
    },
    continueCollab: async (threadId, taskId) => {
      const client = modelClientForHost('local');
      return (client as any)?.collaborationUserAction?.({ action: 'continue', threadId, ...(taskId ? { taskId } : {}) });
    },
  });
  const teamCards = installTeamCards({
    inspectTeam: async (threadId, teamId) => {
      const client = modelClientForHost('local');
      return client?.inspectThreadTeam?.({ threadId, ...(teamId ? { teamId } : {}) }) ?? null;
    },
    userAction: async input => {
      const client = modelClientForHost('local');
      return client?.collaborationUserAction?.(input) ?? null;
    },
    openThread: (threadId) => openRendererThread(hostThreadIdSchema.parse(threadId), { hostId: 'local' }),
    activeThread: () => {
      const mounted = [...composerEntries.values()].find(candidate => {
        if (!candidate.composer.isConnected || !candidate.control.root.isConnected) return false;
        if (!threadIdFromComposerModelTarget(candidate.modelTarget)) return false;
        const style = window.getComputedStyle(candidate.composer);
        return style.display !== 'none' && style.visibility !== 'hidden' && candidate.composer.getClientRects().length > 0;
      });
      const threadId = mounted ? threadIdFromComposerModelTarget(mounted.modelTarget) : null;
      const scroll = mounted?.composer.closest('.thread-scroll-container');
      const content = scroll?.parentElement?.parentElement;
      return mounted && threadId ? { threadId, anchor: content ?? mounted.composer } : null;
    },
  });
  let connectionDiagnostics: RendererConnectionDiagnostics | null = null;
  const settingsLifecycle = installRendererSettingsLifecycle(window, {
    getUpdateClient: () => modelControl,
    getAccountClient: () => modelControl,
    getConnectionDiagnostics: () => connectionDiagnostics,
    getStorageClient: () => {
      const client = modelClientForHost('local');
      return client?.inspectStorage && client.optimizeStorage ? { inspectStorage: () => client.inspectStorage!(), optimizeStorage: () => client.optimizeStorage!() } : null;
    },
    getUsageClient: () => {
      const client = modelClientForHost('local');
      return client?.usageHistory && client.usageSummary
        ? { usageHistory: input => client.usageHistory!(input), usageSummary: () => client.usageSummary!() }
        : null;
    },
    getHealthClient: () => {
      const client = modelClientForHost('local');
      return client?.healthSnapshot && client.healthRefresh
        ? { healthSnapshot: () => client.healthSnapshot!(), healthRefresh: () => client.healthRefresh!() }
        : null;
    },
    getIntegrationsClient: () => {
      const client = modelClientForHost('local');
      if (!client?.integrationCatalog || !client.listIntegrations || !client.saveMcp || !client.removeMcp || !client.changeSkill) return null;
      return { integrationCatalog: () => client.integrationCatalog!(), listIntegrations: input => client.listIntegrations!(input), saveMcp: input => client.saveMcp!(input), removeMcp: input => client.removeMcp!(input), changeSkill: input => client.changeSkill!(input) };
    },
    getSessionImportClient: () => {
      const client = modelClientForHost("local");
      const sources = client?.listSessionImportSources;
      const list = client?.listHarnessSessions;
      const importSession = client?.importHarnessSession;
      if (!sources || !list || !importSession) return null;
      return {
        listSessionImportSources: () => sources(),
        listHarnessSessions: (input) => list(input),
        importHarnessSession: (input) => importSession(input),
      };
    },
    getPetClient: () => {
      const client = modelClientForHost("local");
      return client?.petsClient ?? null;
    },
    getCollaborationClient: () => {
      const client = modelClientForHost("local");
      if (!client?.getCollaborationPreferences || !client?.saveCollaborationPreferences) return null;
      return {
        getCollaborationPreferences: () => client.getCollaborationPreferences!(),
        saveCollaborationPreferences: (input) => client.saveCollaborationPreferences!(input),
        ...(client.listTeamTemplates && client.saveTeamTemplate && client.deleteTeamTemplate
          ? {
              listTeamTemplates: () => client.listTeamTemplates!(),
              saveTeamTemplate: input => client.saveTeamTemplate!(input),
              deleteTeamTemplate: id => client.deleteTeamTemplate!(id),
              ...(client.restoreTeamTemplates ? { restoreTeamTemplates: () => client.restoreTeamTemplates!() } : {}),
            }
          : {}),
        ...(client.listCollaborationAgents ? { listAgents: () => client.listCollaborationAgents!() } : {}),
        inspectAgent: (id: string) => client.inspectHarness({ harnessId: id as Parameters<typeof client.inspectHarness>[0]["harnessId"] }),
      };
    },
    openImportedThread: (threadId, signal) =>
      openRendererThread(threadId, { hostId: "local", signal }),
    onLocaleChange() {
      for (const mounted of composerEntries.values()) paintComposer(mounted);
    },
  });
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    modelUpdates: 0,
    hook: null,
  };
  const makeHostState = (): HostAvailabilityState => ({
    codexAccounts: null,
    codexAccountsIsolated: false,
    availability: Object.fromEntries(
      externalAgents.map((agent) => [agent, "checking"]),
    ) as HarnessAvailability,
    errors: {
      pi: undefined,
      "claude-code": undefined,
      "deepseek-harness": undefined,
      opencode: undefined,
      grok: undefined,
      omp: undefined,
      antigravity: undefined,
      "kiro-cli": undefined,
      openclaw: undefined,
      hermes: undefined,
      qoder: undefined,
      codebuddy: undefined,
      zcode: undefined,
      trae: undefined,
      'cursor-cli': undefined,
      cline: undefined,
      'codex-harness': undefined,
    },
    webUi: Object.fromEntries(
      externalAgents.map((agent) => [agent, false]),
    ) as HarnessWebUiAvailability,
    requestGeneration: 0,
    request: null,
    retryTimer: null,
    retryAttempt: 0,
  });
  const availabilityByHost = new Map<string, HostAvailabilityState>();
  const hostState = (hostId: string): HostAvailabilityState => {
    let state = availabilityByHost.get(hostId);
    if (!state) {
      state = makeHostState();
      availabilityByHost.set(hostId, state);
    }
    return state;
  };
  const codexAccountsForHost = (hostId: string | null): RendererCodexAccountState | null => {
    if (!hostId) return null;
    const client = modelClientForHost(hostId);
    if (!client) return null;
    const state = hostState(hostId);
    if (state.codexAccounts?.client !== client) {
      state.codexAccounts = new RendererCodexAccountState(client);
    }
    return state.codexAccounts;
  };
  const codexAccountsForComposer = (composer: Element): RendererCodexAccountState | null =>
    codexAccountsForHost(composerEntries.get(composer)?.hostId ?? null);
  let activeAvailabilityHostId = "local";
  const activeHostState = (): HostAvailabilityState => hostState(activeAvailabilityHostId);
  const connectionListeners = new Set<() => void>();
  const notifyConnectionListeners = (): void => {
    for (const listener of connectionListeners) listener();
  };
  const availabilityRetryDelays = [500, 1000, 2000, 4000, 8000] as const;
  const usageRefreshTimers = new Map<Element, number>();
  const usageRefreshAttempts = new Map<Element, number>();

  const isLiveComposer = (composer: Element): boolean =>
    composer.isConnected &&
    composer.matches(CODEX_COMPOSER_SELECTOR) &&
    composerEntries.has(composer);

  const isLiveModelRequest = (mounted: ComposerEntry, generation: number): boolean =>
    isLiveComposer(mounted.composer) &&
    composerEntries.get(mounted.composer) === mounted &&
    controller.isCurrentModelRequest(mounted.composer, generation);

  const isLiveOwnershipRequest = (mounted: ComposerEntry, generation: number): boolean =>
    mounted.composer.isConnected &&
    composerEntries.get(mounted.composer) === mounted &&
    controller.isCurrentOwnershipRequest(mounted.composer, generation);

  const announceSubmission = (composer: Element, trigger: SubmissionTrigger): void => {
    const accounts = codexAccountsForComposer(composer);
    const state = controller.recordSubmission(
      composer,
      accounts?.selection.selectedAccountId ?? undefined,
    );
    if (state.agent === "codex" && accounts) accounts.overrideAccountId = null;
    writeNewThreadAgentPreference(state.agent);
    if (state.agent !== "codex") {
      const model = controller.modelForAgent(composer, state.agent);
      if (model) {
        writeNewThreadExternalConfigurationPreference(
          state.agent,
          model,
          controller.thinkingOptionForAgent(composer, state.agent),
          controller.permissionModeForAgent(composer, state.agent),
        );
      }
    }
    window.dispatchEvent(
      new CustomEvent("harnessmix:renderer-submission", {
        detail: {
          composerId: state.composerId,
          agent: state.agent,
          trigger,
        },
      }),
    );
  };

  const paintComposer = (mounted: ComposerEntry): void => {
    const state = controller.get(mounted.composer);
    const accounts = codexAccountsForComposer(mounted.composer);
    const selectedCodexAccountId =
      state.phase === "locked" ||
      (controller.isSubmissionPending(mounted.composer) && state.codexAccountId)
        ? state.codexAccountId
        : accounts?.selection.selectedAccountId;
    renderComposerAgentControl(
      mounted.control,
      controller.get(mounted.composer),
      adapterStatus.state,
      accounts?.switching === true ||
        controller.isSwitching(mounted.composer) ||
        mounted.harnessSwitching ||
        mounted.ownershipStatus === "loading",
      activeHostState().availability,
      mounted.modelView,
      mounted.permissionModeView,
      mounted.usage,
      mounted.accountCredits,
      settingsLifecycle.locale,
      (accounts?.accounts ?? []).map((account) => ({
        ...account,
        active: account.accountId === selectedCodexAccountId,
      })),
      mounted.ownershipStatus === "error",
    );
    if (mounted.control.usage) {
      mounted.control.usage.onOpen = () => {
        void pullThreadUsage(
          mounted,
          controller.get(mounted.composer).agent === "codex" ? undefined : "exact",
        );
      };
    }
  };

  const reloadCommandCatalog = async (mounted: ComposerEntry): Promise<void> => {
    const generation = ++mounted.commandRequestGeneration;
    const agent = controller.get(mounted.composer).agent;
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    const hostId = threadId ? mounted.hostId : activeModelHostId();
    const requestControl = modelControl;
    const client = hostClientFrom(requestControl, hostId);
    mounted.control.harnessCommands.setCommands([]);
    if (agent === "codex" || !client) return;
    try {
      // Live native command catalogs (ACP availableCommands, Claude
      // supportedCommands, Pi get_commands, OpenCode GET /command, OpenClaw
      // commands.list) only come back from listCommands with an open Session,
      // so a thread-bound composer reads Thread commands while drafts fall
      // back to the session-less harness catalog.
      const catalog = threadId
        ? await client.inspectThreadCommands({ threadId })
        : await client.inspectHarnessCommands({ harnessId: externalHarnessIds[agent] });
      if (
        disposed ||
        composerEntries.get(mounted.composer) !== mounted ||
        mounted.commandRequestGeneration !== generation ||
        requestControl !== modelControl ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        (threadId ? mounted.hostId : activeModelHostId()) !== hostId ||
        controller.get(mounted.composer).agent !== agent
      )
        return;
      mounted.control.harnessCommands.setCommands(
        catalog.commands,
        threadIdFromComposerModelTarget(mounted.modelTarget) !== null,
      );
    } catch {
      // Leave the entry unavailable; never open a Session just for the catalog.
    }
  };

  const runCommand = async (
    mounted: ComposerEntry,
    command: HarnessCommandDescriptor,
  ): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId || !modelControl || controller.get(mounted.composer).agent === "codex") return;
    mounted.control.harnessCommands.setExecuting(command.id);
    try {
      await modelControl.executeThreadCommand({ threadId, commandId: command.id });
    } catch (error) {
      console.error(
        "harnessmix Harness command failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      mounted.control.harnessCommands.setExecuting(null);
    }
  };

  const chooseCommand = (mounted: ComposerEntry, command: HarnessCommandDescriptor): void => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!modelControl || controller.get(mounted.composer).agent === "codex") return;
    if (!threadId && rendererHarnessCommandExecutesDirectly(command)) return;
    const editor = mounted.composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (
      routeRendererHarnessCommandSelection(editor, command, () => {
        void runCommand(mounted, command);
      })
    ) {
      return;
    }
    console.error("harnessmix Harness command could not claim the current Composer editor");
  };

  const onThreadUsageUpdate = (update: ThreadUsageInspection): void => {
    for (const mounted of composerEntries.values()) {
      if (threadIdFromComposerModelTarget(mounted.modelTarget) !== update.threadId) continue;
      mounted.usageRequestGeneration += 1;
      mounted.usage = update.usage;
      mounted.accountCredits = update.accountCredits ?? null;
      usageRefreshAttempts.delete(mounted.composer);
      paintComposer(mounted);
    }
  };

  const pollDraftCodexUsage = async (mounted: ComposerEntry): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (
      state.agent !== "codex" ||
      state.phase !== "draft" ||
      controller.isSubmissionPending(mounted.composer) ||
      threadIdFromComposerModelTarget(mounted.modelTarget)
    )
      return;
    const accounts = codexAccountsForComposer(mounted.composer);
    const client = accounts?.client;
    const accountId = accounts?.selection.selectedAccountId;
    const hostId = mounted.hostId;
    const generation = ++mounted.usageRequestGeneration;
    mounted.usage = null;
    mounted.accountCredits = null;
    paintComposer(mounted);
    if (accounts?.switching || !accountId || !client?.inspectCodexAccountUsage) return;
    try {
      const result = await client.inspectCodexAccountUsage({ accountId });
      if (
        disposed ||
        mounted.hostId !== hostId ||
        codexAccountsForComposer(mounted.composer) !== accounts ||
        !mounted.composer.isConnected ||
        composerEntries.get(mounted.composer) !== mounted ||
        mounted.usageRequestGeneration !== generation ||
        controller.get(mounted.composer).agent !== "codex" ||
        controller.get(mounted.composer).phase !== "draft" ||
        controller.isSubmissionPending(mounted.composer) ||
        threadIdFromComposerModelTarget(mounted.modelTarget) ||
        accounts.selection.selectedAccountId !== accountId ||
        result.accountId !== accountId
      )
        return;
      mounted.usage = result.usage;
      mounted.accountCredits = result.accountCredits ?? null;
      paintComposer(mounted);
    } catch {
      // Keep the unknown quota empty rather than showing another account's data.
    }
  };

  const pollDraftExternalCredits = async (mounted: ComposerEntry): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (
      state.agent === "codex" ||
      state.phase !== "draft" ||
      controller.isSubmissionPending(mounted.composer) ||
      threadIdFromComposerModelTarget(mounted.modelTarget)
    ) {
      return;
    }
    const hostId = mounted.hostId;
    const client = hostClientFrom(modelControl, hostId ?? activeModelHostId());
    if (!client?.listHarnessAccounts) return;
    const harnessId = externalHarnessIds[state.agent as keyof typeof externalHarnessIds];
    if (!harnessId) return;
    const generation = ++mounted.usageRequestGeneration;
    try {
      const result = await client.listHarnessAccounts();
      if (
        disposed ||
        !mounted.composer.isConnected ||
        composerEntries.get(mounted.composer) !== mounted ||
        mounted.usageRequestGeneration !== generation ||
        controller.get(mounted.composer).agent !== state.agent ||
        controller.get(mounted.composer).phase !== "draft" ||
        threadIdFromComposerModelTarget(mounted.modelTarget)
      ) {
        return;
      }
      const match = result.accounts.find((a) => a.harnessId === harnessId);
      mounted.accountCredits = match?.credits ?? null;
      paintComposer(mounted);
    } catch {
      // Credits simply stay empty when the account list is unavailable.
    }
  };

  const pullThreadUsage = async (mounted: ComposerEntry, refresh?: "exact"): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId) {
      if (controller.get(mounted.composer).agent === "codex") {
        await pollDraftCodexUsage(mounted);
      } else {
        await pollDraftExternalCredits(mounted);
      }
      return;
    }
    if (!modelControl) {
      mounted.usage = null;
      mounted.accountCredits = null;
      usageRefreshAttempts.delete(mounted.composer);
      paintComposer(mounted);
      return;
    }
    const generation = ++mounted.usageRequestGeneration;
    try {
      const result = await modelControl.inspectThreadUsage({
        threadId,
        ...(refresh ? { refresh } : {}),
      });
      if (
        disposed ||
        composerEntries.get(mounted.composer) !== mounted ||
        !mounted.composer.isConnected ||
        mounted.usageRequestGeneration !== generation ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        result.threadId !== threadId
      ) {
        return;
      }
      mounted.usage = result.usage;
      mounted.accountCredits = result.accountCredits ?? null;
      const agent = controller.get(mounted.composer).agent;
      if (
        result.usage !== null &&
        (!agentReportsAccountCredits(agent) || result.accountCredits)
      ) {
        usageRefreshAttempts.delete(mounted.composer);
      }
      paintComposer(mounted);
      if (
        shouldRetryExternalThreadUsage(
          controller.get(mounted.composer).agent,
          result.usage,
          result.accountCredits ?? null,
        )
      ) {
        queueThreadUsageRetry(mounted);
      }
    } catch (error) {
      if (
        composerEntries.get(mounted.composer) === mounted &&
        mounted.usageRequestGeneration === generation
      ) {
        paintComposer(mounted);
        if (
          !(error instanceof RendererMethodUnavailableError) &&
          shouldRetryExternalThreadUsage(controller.get(mounted.composer).agent, null, null)
        ) {
          queueThreadUsageRetry(mounted);
        }
      }
    }
  };

  const queueThreadUsageRetry = (mounted: ComposerEntry): void => {
    if (usageRefreshTimers.has(mounted.composer)) return;
    const attempt = usageRefreshAttempts.get(mounted.composer) ?? 0;
    usageRefreshAttempts.set(mounted.composer, attempt + 1);
    const timer = window.setTimeout(() => {
      usageRefreshTimers.delete(mounted.composer);
      void pullThreadUsage(mounted);
    }, rendererUsageRefreshDelay(attempt));
    usageRefreshTimers.set(mounted.composer, timer);
  };

  const externalConfigurationReady = (mounted: ComposerEntry): boolean => {
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return true;
    return externalViewsReady(mounted.modelView, mounted.permissionModeView);
  };

  const clearPrewarmCarrier = async (): Promise<void> => {
    const policy = await waitForRendererDraftPrewarmPolicy(window);
    await policy.clear();
  };

  const writeExternalConfiguration = (
    mounted: ComposerEntry,
    agent: Exclude<RendererAgent, "codex">,
    model: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): boolean => {
    return applyComposerModelWrite(
      mounted.modelTarget,
      () =>
        applyAdapterAgent?.(agent, model, thinkingOptionId, permissionModeId, mounted.composer) ??
        false,
    );
  };

  const restoreThreadOwnership = async (mounted: ComposerEntry): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId) {
      mounted.ownershipStatus = "not-required";
      return;
    }
    const requestModelControl = modelControl;
    const requestHostId = activeModelHostId();
    const client = hostClientFrom(requestModelControl, requestHostId);
    const generation = controller.beginOwnershipRequest(mounted.composer);
    const usageGeneration = mounted.usageRequestGeneration;
    mounted.ownershipStatus = "loading";
    paintComposer(mounted);
    try {
      if (!client || !requestHostId) throw new Error("Thread ownership control is unavailable");
      mounted.hostId = requestHostId;
      const inspection = await client.inspectThread({ threadId });
      if (
        !isLiveOwnershipRequest(mounted, generation) ||
        composerEntries.get(mounted.composer) !== mounted ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        mounted.hostId !== requestHostId ||
        modelControl !== requestModelControl ||
        activeModelHostId() !== requestHostId
      ) {
        return;
      }
      const { agent, model, thinkingOptionId, permissionModeId } =
        restoredThreadOwnership(inspection);
      if (mounted.usageRequestGeneration === usageGeneration) {
        mounted.usage = inspection.owner === "external" ? (inspection.usage ?? null) : null;
        mounted.accountCredits =
          inspection.owner === "external" ? (inspection.accountCredits ?? null) : null;
      }
      const restored = controller.restore(
        mounted.composer,
        agent,
        model,
        thinkingOptionId,
        permissionModeId,
        inspection.owner === "codex" ? inspection.accountId : undefined,
      );
      if (!restored) {
        throw new Error("Thread owner could not be applied to the Composer");
      }
      mounted.ownershipStatus = "ready";
      if (agent !== "codex") {
        if (inspection.owner !== "external") {
          throw new Error("External Thread inspection did not include configuration");
        }
        mounted.threadConfiguration = {
          ...(inspection.effectiveModel ? { effectiveModel: inspection.effectiveModel } : {}),
          ...(inspection.resolvedModelLabel
            ? { resolvedModelLabel: inspection.resolvedModelLabel }
            : {}),
          ...(inspection.effectiveThinkingOptionId
            ? { effectiveThinkingOptionId: inspection.effectiveThinkingOptionId }
            : {}),
          ...(inspection.availableThinkingOptions
            ? { availableThinkingOptions: inspection.availableThinkingOptions }
            : {}),
          ...(inspection.effectivePermissionModeId
            ? { effectivePermissionModeId: inspection.effectivePermissionModeId }
            : {}),
        };
        mounted.modelView = { status: "loading" };
        mounted.permissionModeView = { status: "loading" };
        void loadExternalConfiguration(mounted);
      } else {
        mounted.threadConfiguration = undefined;
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
      }
    } catch {
      if (!isLiveOwnershipRequest(mounted, generation)) return;
      mounted.ownershipStatus = "error";
    } finally {
      if (isLiveOwnershipRequest(mounted, generation)) {
        paintComposer(mounted);
        if (mounted.ownershipStatus !== "error") void reloadCommandCatalog(mounted);
        sidebarIcons.refresh();
        if (mounted.ownershipStatus !== "error") {
          const agent = controller.get(mounted.composer).agent;
          if (agent === "codex") {
            void pullThreadUsage(mounted);
          } else if (shouldRetryExternalThreadUsage(agent, mounted.usage, mounted.accountCredits)) {
            queueThreadUsageRetry(mounted);
          }
        }
      }
    }
  };

  const performHarnessHandoff = async (
    mounted: ComposerEntry,
    request: RendererHarnessHandoffRequest,
  ): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    const current = controller.get(mounted.composer);
    if (
      !threadId ||
      current.phase !== "locked" ||
      current.agent === "codex" ||
      current.agent !== request.from ||
      request.to === current.agent ||
      mounted.harnessSwitching
    ) {
      return;
    }
    const client = hostClientFrom(modelControl, mounted.hostId);
    if (!client?.switchHarness) {
      mounted.control.harnessHandoff.showError(
        settingsLifecycle.locale === "zh-CN" ? "当前任务无法使用 Harness 接力。" : "Harness handoff is unavailable for this task.",
      );
      return;
    }
    mounted.harnessSwitching = true;
    mounted.control.harnessHandoff.setSubmitting(true);
    paintComposer(mounted);
    try {
      await client.switchHarness({
        threadId,
        harnessId: externalHarnessIds[request.to],
        ...(request.note ? { note: request.note } : {}),
        intent: request.intent,
        includes: request.includes,
      });
      if (
        disposed ||
        composerEntries.get(mounted.composer) !== mounted ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId
      ) {
        return;
      }
      mounted.harnessSwitching = false;
      mounted.control.harnessHandoff.setSubmitting(false);
      mounted.control.harnessHandoff.close();
      mounted.modelView = { status: "loading" };
      mounted.permissionModeView = { status: "loading" };
      mounted.threadConfiguration = undefined;
      mounted.usage = null;
      mounted.accountCredits = null;
      await restoreThreadOwnership(mounted);
    } catch (error) {
      mounted.control.harnessHandoff.showError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (composerEntries.get(mounted.composer) === mounted) {
        mounted.harnessSwitching = false;
        mounted.control.harnessHandoff.setSubmitting(false);
        paintComposer(mounted);
      }
    }
  };

  const syncMountedTarget = (mounted: ComposerEntry): boolean => {
    const currentTarget = findComposerModelTarget(mounted.composer);
    const resolution = composerTargetResolution(
      mounted.modelTarget,
      currentTarget,
      controller.get(mounted.composer).phase,
      controller.isSubmissionPending(mounted.composer),
    );
    if (resolution === "none") return false;

    const nextHostId = activeModelHostId() ?? mounted.hostId;
    const nextControllerTarget = controllerTarget(currentTarget, nextHostId);
    mounted.modelTarget = currentTarget;
    mounted.hostId = nextHostId;
    const rebound =
      resolution === "transfer"
        ? controller.transfer(mounted.composer, mounted.composer, nextControllerTarget)
        : controller.rebindTarget(
            mounted.composer,
            nextControllerTarget,
            currentTarget?.[0] === "default"
              ? readNewThreadAgentPreference(enabledAgentSet)
              : undefined,
          ) !== null;
    if (!rebound) {
      mounted.ownershipStatus = "error";
      paintComposer(mounted);
      return true;
    }
    if (resolution === "transfer") {
      mounted.ownershipStatus = "ready";
      paintComposer(mounted);
      if (shouldRetryExternalThreadUsage(controller.get(mounted.composer).agent, null, null)) {
        queueThreadUsageRetry(mounted);
      }
    } else {
      mounted.composerId = controller.get(mounted.composer).composerId;
      mounted.modelView = { status: "idle" };
      mounted.permissionModeView = { status: "idle" };
      mounted.threadConfiguration = undefined;
      mounted.ownershipStatus =
        currentTarget?.[0] === "conversation" ? "loading" : "not-required";
      mounted.usage = null;
      mounted.accountCredits = null;
      mounted.usageRequestGeneration += 1;
      usageRefreshAttempts.delete(mounted.composer);
      paintComposer(mounted);
      if (currentTarget?.[0] === "conversation") {
        void restoreThreadOwnership(mounted);
      } else {
        pushComposerCarrier(mounted.composer);
        const state = controller.get(mounted.composer);
        if (state.agent !== "codex") void loadExternalConfiguration(mounted);
        void pollDraftCodexUsage(mounted);
        void reloadCommandCatalog(mounted);
      }
    }
    sidebarIcons.refresh();
    return true;
  };

  const loadExternalConfiguration = async (mounted: ComposerEntry): Promise<void> => {
    void reloadCommandCatalog(mounted);
    const state = controller.get(mounted.composer);
    if (state.agent === "codex") return;
    const agent = state.agent;
    const requestModelControl = modelControl;
    const isDraft = !threadIdFromComposerModelTarget(mounted.modelTarget);
    const requestHostId = isDraft ? activeModelHostId() : mounted.hostId;
    if (!requestHostId) {
      mounted.modelView = {
        status: "waitingForAdapter",
        thinkingSelectionSupported: false,
      };
      mounted.permissionModeView = { status: "idle" };
      paintComposer(mounted);
      return;
    }
    if (isDraft) mounted.hostId = requestHostId;
    const availability = hostState(requestHostId).availability[agent];
    // A locked thread already proved which harness owns it — the ownership
    // inspection restored the agent from the host itself. A stale or never
    // refreshed availability cache on a secondary host must not wedge the
    // model picker (the label falls back to "Select model" and submission
    // stays blocked forever), so locked threads fetch the catalog regardless
    // and let the inspect result speak for itself.
    const lockedOwnership =
      mounted.ownershipStatus === "ready" && state.phase === "locked";
    if (availability !== "ready" && !lockedOwnership) {
      mounted.modelView = {
        status:
          adapterStatus.state !== "ready" || availability === "checking"
            ? "waitingForAdapter"
            : "error",
        thinkingSelectionSupported: false,
        ...(availability && availability !== "checking"
          ? { error: `${agent} runtime is ${availability}` }
          : {}),
      };
      mounted.permissionModeView = { status: "idle" };
      paintComposer(mounted);
      if (availability === "checking") void refreshActiveHostAvailability();
      return;
    }
    mounted.modelView = {
      status: adapterStatus.state === "ready" ? "loading" : "waitingForAdapter",
      thinkingSelectionSupported: false,
    };
    mounted.permissionModeView = { status: "idle" };
    paintComposer(mounted);
    if (adapterStatus.state !== "ready") return;
    const generation = controller.beginModelRequest(mounted.composer);
    try {
      if (!requestModelControl || !requestHostId) {
        throw new Error("External configuration control is unavailable");
      }
      const client = hostClientFrom(requestModelControl, requestHostId);
      if (!client) {
        throw new Error(`Renderer Model request manager is unavailable for Host ${requestHostId}`);
      }
      const inspection = await client.inspectHarness({
        harnessId: externalHarnessIds[agent],
      });
      if (
        !isLiveModelRequest(mounted, generation) ||
        controller.get(mounted.composer).agent !== agent ||
        mounted.hostId !== requestHostId ||
        modelControl !== requestModelControl ||
        hostClientFrom(requestModelControl, requestHostId) !== client ||
        activeModelHostId() !== requestHostId
      ) {
        return;
      }
      if (inspection.status !== "ready") throw new Error(inspection.error.message);
      const current = controller.get(mounted.composer);
      const previousModel = controller.modelForAgent(mounted.composer, agent);
      const previousModelAvailable =
        previousModel !== undefined &&
        inspection.catalog.models.some((model) => model.ref.id === previousModel.id);
      const preferredConfiguration =
        current.phase === "draft" && !previousModelAvailable
          ? readNewThreadExternalConfigurationPreference(
              agent,
              inspection.catalog,
              inspection.permissionModes,
            )
          : undefined;
      const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
      const permissionModeLock = permissionModeSelectionLocked({
        phase: current.phase,
        permissionModeScope: inspection.capabilities.configuration.permissionModeScope,
      })
        ? {
            selectionLocked: true as const,
            selectionLockedReason: rendererHarnessMessages(settingsLifecycle.locale)
              .permissionModeFixedAtCreate,
          }
        : {};
      let selectedPermissionModeId: HarnessPermissionModeId | undefined;
      if (inspection.capabilities.configuration.selectPermissionMode) {
        const permissionModes = inspection.permissionModes;
        if (!permissionModes) {
          throw new Error("External Harness omitted its Permission Mode catalog");
        }
        mounted.permissionModeView = {
          status: "loading",
          catalog: permissionModes,
          ...permissionModeLock,
        };
        const restoredPermissionModeId =
          current.phase === "locked"
            ? lockedPermissionMode(
                permissionModes,
                mounted.threadConfiguration?.effectivePermissionModeId,
                previousPermissionModeId,
              )
            : undefined;
        const preferredPermissionModeId =
          preferredConfiguration?.permissionModeId ??
          (agent === "claude-code"
            ? readClaudePermissionModePreference(permissionModes)
            : undefined);
        selectedPermissionModeId = draftPermissionMode(
          permissionModes,
          restoredPermissionModeId ?? previousPermissionModeId ?? preferredPermissionModeId,
        );
        mounted.permissionModeView = {
          status: "loading",
          catalog: permissionModes,
          selected: selectedPermissionModeId,
          ...permissionModeLock,
        };
      } else {
        mounted.permissionModeView = { status: "unsupported" };
      }

      if (
        !inspection.capabilities.configuration.selectModel ||
        inspection.catalog.models.length === 0
      ) {
        mounted.modelView = {
          status: "empty",
          catalog: inspection.catalog,
          thinkingSelectionSupported: false,
        };
        if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
          controller.setExternalPermissionMode(mounted.composer, agent, selectedPermissionModeId);
          mounted.permissionModeView = {
            status: "ready",
            catalog: mounted.permissionModeView.catalog,
            selected: selectedPermissionModeId,
            ...permissionModeLock,
          };
        }
        return;
      }
      if (current.phase === "locked" && previousModel && !previousModelAvailable) {
        mounted.modelView = {
          status: "error",
          catalog: inspection.catalog,
          selected: previousModel,
          thinkingSelectionSupported: inspection.capabilities.configuration.selectThinkingOption,
          error: "Existing Thread Model is absent from the current Catalog",
        };
        if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
          mounted.permissionModeView = {
            status: "ready",
            catalog: mounted.permissionModeView.catalog,
            selected: selectedPermissionModeId,
            ...permissionModeLock,
          };
        }
        return;
      }

      const selected = previousModelAvailable
        ? previousModel
        : (preferredConfiguration?.model ?? inspection.catalog.defaultModel);
      if (!selected) throw new Error("External Harness did not report its default Model");
      const effectiveCatalog =
        current.phase === "locked" && mounted.threadConfiguration
          ? catalogOverlayedWithThreadState(inspection.catalog, selected, mounted.threadConfiguration)
          : inspection.catalog;
      const previousThinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
      const requestedThinkingOptionId = previousModelAvailable
        ? previousThinkingOptionId
        : preferredConfiguration?.thinkingOptionId;
      const selectedThinkingOptionId = inspection.capabilities.configuration.selectThinkingOption
        ? draftThinkingOptionForModel(effectiveCatalog, selected, requestedThinkingOptionId)
        : undefined;
      if (
        current.phase === "draft" &&
        (previousModel?.id !== selected.id ||
          previousThinkingOptionId !== selectedThinkingOptionId ||
          previousPermissionModeId !== selectedPermissionModeId)
      ) {
        if (
          !writeExternalConfiguration(
            mounted,
            agent,
            selected,
            selectedThinkingOptionId,
            selectedPermissionModeId,
          )
        ) {
          throw new Error("External configuration could not be applied to the Composer");
        }
        try {
          await clearPrewarmCarrier();
        } catch (error) {
          if (isLiveModelRequest(mounted, generation)) {
            applyAdapterAgent?.(
              agent,
              previousModel,
              previousThinkingOptionId,
              previousPermissionModeId,
              mounted.composer,
            );
          }
          throw error;
        }
        if (!isLiveModelRequest(mounted, generation)) return;
      }
      controller.setExternalModel(mounted.composer, agent, selected);
      controller.setExternalThinkingOption(mounted.composer, agent, selectedThinkingOptionId);
      if (selectedPermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, selectedPermissionModeId);
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected,
        ...(selectedThinkingOptionId ? { selectedThinkingOptionId } : {}),
        ...(mounted.threadConfiguration?.resolvedModelLabel
          ? { resolvedModelLabel: mounted.threadConfiguration.resolvedModelLabel }
          : {}),
        thinkingSelectionSupported: inspection.capabilities.configuration.selectThinkingOption,
      };
      if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
        mounted.permissionModeView = {
          status: "ready",
          catalog: mounted.permissionModeView.catalog,
          selected: selectedPermissionModeId,
          ...permissionModeLock,
        };
      }
    } catch (error) {
      if (!isLiveModelRequest(mounted, generation)) return;
      const selected = controller.modelForAgent(mounted.composer, agent);
      const selectedThinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
      const selectedPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
      const message = error instanceof Error ? error.message : String(error);
      mounted.modelView = {
        status: "error",
        ...(mounted.modelView.catalog ? { catalog: mounted.modelView.catalog } : {}),
        ...(selected ? { selected } : {}),
        ...(selectedThinkingOptionId ? { selectedThinkingOptionId } : {}),
        thinkingSelectionSupported: false,
        error: message,
      };
      if (
        mounted.permissionModeView.status !== "unsupported" &&
        mounted.permissionModeView.status !== "idle"
      ) {
        mounted.permissionModeView = {
          status: "error",
          ...(mounted.permissionModeView.catalog
            ? { catalog: mounted.permissionModeView.catalog }
            : {}),
          ...(selectedPermissionModeId ? { selected: selectedPermissionModeId } : {}),
          error: message,
        };
      }
    } finally {
      if (isLiveModelRequest(mounted, generation)) paintComposer(mounted);
    }
  };

  const pickExternalModel = async (mounted: ComposerEntry, modelId: string): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.modelView.catalog;
    const selected = catalog?.models.find((model) => model.ref.id === modelId)?.ref;
    if (!catalog || !selected || !modelControl) return;
    const previousModel = controller.modelForAgent(mounted.composer, agent);
    const previousThinking = controller.thinkingOptionForAgent(mounted.composer, agent);
    const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const supportsThinkingSelection = mounted.modelView.thinkingSelectionSupported === true;
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: previousModel ?? selected,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
      thinkingSelectionSupported: supportsThinkingSelection,
    };
    paintComposer(mounted);
    try {
      let effectiveModel: HarnessModelRef;
      let effectiveThinkingOptionId: HarnessThinkingOptionId | undefined;
      let effectiveCatalog: HarnessModelCatalog;
      let resolvedModelLabel: string | undefined;
      if (current.phase === "draft") {
        effectiveModel = selected;
        effectiveThinkingOptionId = supportsThinkingSelection
          ? draftThinkingOptionForModel(catalog, selected, previousThinking)
          : undefined;
        effectiveCatalog = catalog;
        if (
          !writeExternalConfiguration(
            mounted,
            agent,
            effectiveModel,
            effectiveThinkingOptionId,
            previousPermissionModeId,
          )
        ) {
          throw new Error("External Model configuration could not be applied to the Composer");
        }
        try {
          await clearPrewarmCarrier();
        } catch (error) {
          if (previousModel && isLiveModelRequest(mounted, generation)) {
            writeExternalConfiguration(
              mounted,
              agent,
              previousModel,
              previousThinking,
              previousPermissionModeId,
            );
          }
          throw error;
        }
        if (!isLiveModelRequest(mounted, generation)) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId) {
          throw new Error("External Thread identity is unavailable for Model selection");
        }
        const state = await modelControl.selectThreadModel({ threadId, model: selected });
        if (
          !isLiveModelRequest(mounted, generation) ||
          controller.get(mounted.composer).agent !== agent
        ) {
          return;
        }
        if (!state.effectiveModel) {
          throw new Error("External Harness did not confirm an effective Model");
        }
        effectiveModel = state.effectiveModel;
        if (!catalog.models.some((model) => model.ref.id === effectiveModel.id)) {
          throw new Error("External Harness activated a Model outside the current catalog");
        }
        effectiveThinkingOptionId = supportsThinkingSelection
          ? thinkingOptionInSelection(state)
          : undefined;
        effectiveCatalog = supportsThinkingSelection
          ? catalogOverlayedWithThreadState(catalog, effectiveModel, state)
          : catalog;
        resolvedModelLabel = state.resolvedModelLabel;
        const effectivePermissionModeId =
          state.effectivePermissionModeId ?? previousPermissionModeId;
        if (
          !writeExternalConfiguration(
            mounted,
            agent,
            effectiveModel,
            effectiveThinkingOptionId,
            effectivePermissionModeId,
          )
        ) {
          throw new Error("Confirmed external Model could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isLiveModelRequest(mounted, generation)) return;
      controller.setExternalModel(mounted.composer, agent, effectiveModel);
      controller.setExternalThinkingOption(mounted.composer, agent, effectiveThinkingOptionId);
      const effectivePermissionModeId =
        mounted.threadConfiguration?.effectivePermissionModeId ?? previousPermissionModeId;
      if (effectivePermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      }
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          effectiveModel,
          effectiveThinkingOptionId,
          effectivePermissionModeId,
        );
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: effectiveModel,
        ...(effectiveThinkingOptionId
          ? { selectedThinkingOptionId: effectiveThinkingOptionId }
          : {}),
        ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
        thinkingSelectionSupported: supportsThinkingSelection,
      };
    } catch (error) {
      if (!isLiveModelRequest(mounted, generation)) return;
      if (previousModel) {
        writeExternalConfiguration(
          mounted,
          agent,
          previousModel,
          previousThinking,
          previousPermissionModeId,
        );
      }
      mounted.modelView = {
        status: "error",
        catalog,
        ...(previousModel ? { selected: previousModel } : {}),
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
        thinkingSelectionSupported: supportsThinkingSelection,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isLiveModelRequest(mounted, generation)) paintComposer(mounted);
    }
  };

  const pickPermissionMode = async (
    mounted: ComposerEntry,
    permissionModeId: string,
  ): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.permissionModeView.catalog;
    const selectedPermissionModeId = catalog?.modes.find(({ id }) => id === permissionModeId)?.id;
    const model = controller.modelForAgent(mounted.composer, agent);
    if (
      !catalog ||
      !selectedPermissionModeId ||
      !model ||
      !modelControl ||
      mounted.permissionModeView.selectionLocked
    ) {
      return;
    }
    const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const thinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.permissionModeView = {
      status: "selecting",
      catalog,
      selected: previousPermissionModeId ?? selectedPermissionModeId,
    };
    paintComposer(mounted);
    try {
      let effectivePermissionModeId = selectedPermissionModeId;
      if (current.phase === "draft") {
        if (
          !writeExternalConfiguration(
            mounted,
            agent,
            model,
            thinkingOptionId,
            selectedPermissionModeId,
          )
        ) {
          throw new Error("Permission Mode could not be applied to the Composer");
        }
        try {
          await clearPrewarmCarrier();
        } catch (error) {
          if (isLiveModelRequest(mounted, generation)) {
            writeExternalConfiguration(
              mounted,
              agent,
              model,
              thinkingOptionId,
              previousPermissionModeId,
            );
          }
          throw error;
        }
        if (!isLiveModelRequest(mounted, generation)) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId) {
          throw new Error("External Thread identity is unavailable for Permission Mode selection");
        }
        const state = await modelControl.selectThreadPermissionMode({
          threadId,
          permissionModeId: selectedPermissionModeId,
        });
        if (
          !isLiveModelRequest(mounted, generation) ||
          controller.get(mounted.composer).agent !== agent
        ) {
          return;
        }
        if (
          !state.effectivePermissionModeId ||
          !catalog.modes.some(({ id }) => id === state.effectivePermissionModeId)
        ) {
          throw new Error("External Harness did not report a selectable Permission Mode");
        }
        effectivePermissionModeId = state.effectivePermissionModeId;
        if (
          !writeExternalConfiguration(
            mounted,
            agent,
            model,
            thinkingOptionId,
            effectivePermissionModeId,
          )
        ) {
          throw new Error("Confirmed Permission Mode could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isLiveModelRequest(mounted, generation)) return;
      controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          model,
          thinkingOptionId,
          effectivePermissionModeId,
        );
        if (agent === "claude-code") {
          writeClaudePermissionModePreference(effectivePermissionModeId);
        }
      }
      mounted.permissionModeView = {
        status: "ready",
        catalog,
        selected: effectivePermissionModeId,
      };
    } catch (error) {
      if (!isLiveModelRequest(mounted, generation)) return;
      if (previousPermissionModeId) {
        writeExternalConfiguration(
          mounted,
          agent,
          model,
          thinkingOptionId,
          previousPermissionModeId,
        );
      }
      mounted.permissionModeView = {
        status: "error",
        catalog,
        ...(previousPermissionModeId ? { selected: previousPermissionModeId } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isLiveModelRequest(mounted, generation)) paintComposer(mounted);
    }
  };

  const pickExternalThinking = async (
    mounted: ComposerEntry,
    thinkingOptionId: string,
  ): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.modelView.catalog;
    const model = controller.modelForAgent(mounted.composer, agent);
    const permissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const selectedThinkingOptionId = catalog?.thinkingOptions.find(
      ({ id }) => id === thinkingOptionId,
    )?.id;
    const catalogModel = catalog?.models.find((candidate) => candidate.ref.id === model?.id);
    if (
      !mounted.modelView.thinkingSelectionSupported ||
      !catalog ||
      !model ||
      !selectedThinkingOptionId ||
      !catalogModel?.supportedThinkingOptionIds?.includes(selectedThinkingOptionId)
    ) {
      return;
    }
    const previousThinking = controller.thinkingOptionForAgent(mounted.composer, agent);
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: model,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
      thinkingSelectionSupported: true,
    };
    paintComposer(mounted);
    try {
      let effectiveThinkingOptionId = selectedThinkingOptionId;
      let effectiveCatalog = catalog;
      if (current.phase === "draft") {
        if (
          !writeExternalConfiguration(
            mounted,
            agent,
            model,
            selectedThinkingOptionId,
            permissionModeId,
          )
        ) {
          throw new Error("External Thinking could not be applied to the Composer");
        }
        try {
          await clearPrewarmCarrier();
        } catch (error) {
          if (isLiveModelRequest(mounted, generation)) {
            writeExternalConfiguration(mounted, agent, model, previousThinking, permissionModeId);
          }
          throw error;
        }
        if (!isLiveModelRequest(mounted, generation)) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId || !modelControl) {
          throw new Error("External Thread identity is unavailable for Thinking selection");
        }
        const state = await modelControl.selectThreadThinking({
          threadId,
          thinkingOptionId: selectedThinkingOptionId,
        });
        if (
          !isLiveModelRequest(mounted, generation) ||
          controller.get(mounted.composer).agent !== agent
        ) {
          return;
        }
        if (state.effectiveModel && state.effectiveModel.id !== model.id) {
          throw new Error("External Harness changed Model during Thinking selection");
        }
        if (!state.effectiveThinkingOptionId) {
          throw new Error("External Harness did not confirm effective Thinking");
        }
        effectiveThinkingOptionId = state.effectiveThinkingOptionId;
        effectiveCatalog = catalogOverlayedWithThreadState(catalog, model, state);
        if (
          !writeExternalConfiguration(
            mounted,
            agent,
            model,
            effectiveThinkingOptionId,
            state.effectivePermissionModeId ?? permissionModeId,
          )
        ) {
          throw new Error("Confirmed external Thinking could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isLiveModelRequest(mounted, generation)) return;
      controller.setExternalThinkingOption(mounted.composer, agent, effectiveThinkingOptionId);
      const effectivePermissionModeId =
        mounted.threadConfiguration?.effectivePermissionModeId ?? permissionModeId;
      if (effectivePermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      }
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          model,
          effectiveThinkingOptionId,
          effectivePermissionModeId,
        );
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: model,
        selectedThinkingOptionId: effectiveThinkingOptionId,
        thinkingSelectionSupported: true,
      };
    } catch (error) {
      if (!isLiveModelRequest(mounted, generation)) return;
      writeExternalConfiguration(mounted, agent, model, previousThinking, permissionModeId);
      mounted.modelView = {
        status: "error",
        catalog,
        selected: model,
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
        thinkingSelectionSupported: true,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isLiveModelRequest(mounted, generation)) paintComposer(mounted);
    }
  };

  const switchAgentOnComposer = async (
    mounted: ComposerEntry,
    agent: RendererAgent,
  ): Promise<boolean> => {
    if (agent !== "codex" && activeHostState().availability[agent] !== "ready") {
      return false;
    }
    controller.clearPendingSubmission(mounted.composer);
    const composerId = controller.get(mounted.composer).composerId;
    controller.invalidateModelRequests(mounted.composer);
    const switching = controller.switchAgent(mounted.composer, agent, {
      applyAgent(nextAgent) {
        const model = controller.modelForAgent(mounted.composer, nextAgent);
        if (!shouldApplyDraftAgentCarrier(nextAgent, model)) return true;
        return (
          applyAdapterAgent?.(
            nextAgent,
            model,
            nextAgent !== "codex"
              ? controller.thinkingOptionForAgent(mounted.composer, nextAgent)
              : undefined,
            nextAgent !== "codex"
              ? controller.permissionModeForAgent(mounted.composer, nextAgent)
              : undefined,
            mounted.composer,
          ) ?? nextAgent === "codex"
        );
      },
      clearPrewarm: clearPrewarmCarrier,
    });
    paintComposer(mounted);
    try {
      const switched = await switching;
      if (switched && controller.get(mounted.composer).agent !== "codex") {
        void loadExternalConfiguration(mounted);
      } else if (controller.get(mounted.composer).agent === "codex") {
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
        void reloadCommandCatalog(mounted);
      }
      sidebarIcons.refresh();
      return switched;
    } catch {
      // A failed draft-prewarm clear is transient (timers may be throttled in
      // a hidden window). The adapter owns its status lifecycle and recovers
      // through its own recapture path; replacing the live status object here
      // would detach every picker from future status updates and latch
      // "unsupported".
      paintComposer(mounted);
      return false;
    } finally {
      for (const candidate of composerEntries.values()) {
        if (controller.get(candidate.composer).composerId === composerId) paintComposer(candidate);
      }
    }
  };

  const reloadCodexAccounts = async (): Promise<void> => {
    const hostId = activeModelHostId();
    const accounts = codexAccountsForHost(hostId);
    if (!accounts) return;
    await accounts.refresh();
    if (disposed || codexAccountsForHost(hostId) !== accounts) return;
    if (hostId !== null && accounts.accounts.some((account) => account.management === "isolated")) {
      hostState(hostId).codexAccountsIsolated = true;
    }
    // Mirror the effective Codex account selection (explicit override or the
    // active account) onto the draft policy's sticky route marker. Desktop
    // 26.917+ can recreate its request manager mid-draft and issue thread
    // starts that bypass prepareComposer entirely; without this sync the
    // marker stays null and the first submission leaks to the official route
    // as an ephemeral, sidebar-less session.
    const policy = window.__harnessmixDraftPrewarmPolicyV1;
    if (hostId !== null && policy?.hostId === hostId && policy.selectAccount) {
      const routeAccount = codexAccountRouteOverride(
        accounts.accounts,
        accounts.selection.selectedAccountId,
      );
      try {
        policy.selectAccount(routeAccount);
      } catch {
        // Routing falls back to the next explicit account selection.
      }
    }
    for (const mounted of composerEntries.values()) {
      if (mounted.hostId !== hostId) continue;
      paintComposer(mounted);
      void pollDraftCodexUsage(mounted);
    }
  };

  const applyCodexAccountChoice = async (mounted: ComposerEntry, accountId: string): Promise<void> => {
    const hostId = mounted.hostId;
    const accounts = codexAccountsForComposer(mounted.composer);
    if (
      !accounts ||
      accounts.switching ||
      controller.get(mounted.composer).phase === "locked" ||
      !accounts.accounts.some((account) => account.accountId === accountId)
    )
      return;
    const isCurrent = (): boolean =>
      !disposed &&
      mounted.composer.isConnected &&
      composerEntries.get(mounted.composer) === mounted &&
      controller.get(mounted.composer).phase !== "locked" &&
      accounts.accounts.some((account) => account.accountId === accountId) &&
      mounted.hostId === hostId &&
      activeModelHostId() === hostId &&
      codexAccountsForComposer(mounted.composer) === accounts;
    accounts.switching = true;
    for (const candidate of composerEntries.values()) {
      paintComposer(candidate);
      void pollDraftCodexUsage(candidate);
    }
    try {
      if (
        controller.get(mounted.composer).agent !== "codex" &&
        !(await switchAgentOnComposer(mounted, "codex"))
      ) {
        return;
      }
      const policy = await waitForRendererDraftPrewarmPolicy(window);
      if (!isCurrent() || policy.hostId !== hostId) return;
      await policy.clear();
      if (!isCurrent() || window.__harnessmixDraftPrewarmPolicyV1 !== policy) return;
      if (!policy.selectAccount) throw new Error("Codex Account selection is unavailable");
      policy.selectAccount(codexAccountRouteOverride(accounts.accounts, accountId));
      accounts.overrideAccountId =
        accountId === accounts.selection.activeAccountId ? null : accountId;
    } catch {
      if (isCurrent()) void reloadCodexAccounts();
    } finally {
      accounts.switching = false;
      for (const candidate of composerEntries.values()) {
        paintComposer(candidate);
        void pollDraftCodexUsage(candidate);
      }
    }
  };

  const openInstallPage = (agent: ExternalRendererAgent): void => {
    const url = RENDERER_AGENT_INSTALL_URLS[agent];
    window.open(url, "_blank", "noopener,noreferrer");
  };

  function clearAvailabilityRetry(hostId: string): void {
    const state = hostState(hostId);
    if (state.retryTimer !== null) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryAttempt = 0;
  }

  function armAvailabilityRetry(hostId: string): void {
    const state = hostState(hostId);
    if (
      disposed ||
      state.retryTimer !== null ||
      state.retryAttempt >= availabilityRetryDelays.length
    ) {
      return;
    }
    const delay = availabilityRetryDelays[state.retryAttempt];
    state.retryAttempt += 1;
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      void pollHostAvailability(hostId, true, true);
    }, delay);
  }

  function hostClientFrom(
    control: RendererModelClient | null,
    hostId: string | null,
  ): RendererModelClient | null {
    if (!control || !hostId) return null;
    const selected = control.clientForHost?.(hostId);
    if (selected) return selected;
    const currentHostId = control.currentHostId?.() ?? "local";
    return currentHostId === hostId ? control : null;
  }

  function modelClientForHost(hostId: string): RendererModelClient | null {
    return hostClientFrom(modelControl, hostId);
  }

  function pollHostAvailability(
    hostId: string,
    refresh = false,
    retry = false,
    force = false,
  ): Promise<void> {
    const state = hostState(hostId);
    if (!retry) clearAvailabilityRetry(hostId);
    const client = modelClientForHost(hostId);
    if (!client) {
      armAvailabilityRetry(hostId);
      return Promise.resolve();
    }
    if (state.request?.client === client) return state.request.promise;
    const agentsToInspect = force
      ? externalAgents
      : passiveHarnessAvailabilityAgents(state.availability, state.errors);
    if (agentsToInspect.length === 0) {
      clearAvailabilityRetry(hostId);
      return Promise.resolve();
    }
    const nextAvailability = { ...state.availability };
    for (const agent of agentsToInspect) {
      nextAvailability[agent] = harnessAvailabilityDuringInspect(nextAvailability[agent]);
    }
    state.availability = nextAvailability;
    if (hostId === activeAvailabilityHostId) {
      notifyConnectionListeners();
      for (const mounted of composerEntries.values()) paintComposer(mounted);
    }
    const generation = ++state.requestGeneration;
    const promise = (async () => {
      await Promise.all(
        agentsToInspect.map(async (agent) => {
          let status: RendererAgentAvailability = "error";
          let nextError: HarnessMixError | undefined;
          let webUiAvailable = false;
          try {
            const inspection = await client.inspectHarness({
              harnessId: externalHarnessIds[agent],
              refresh,
            });
            status = inspection.status === "ready" ? "ready" : inspection.status;
            webUiAvailable =
              hostId === "local" &&
              inspection.status === "ready" &&
              inspection.webUi?.open === true;
            if (inspection.status !== "ready") {
              const error = inspection.error;
              nextError = {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
                ...(error.stage ? { stage: error.stage } : {}),
                ...(error.durationMs !== undefined ? { durationMs: error.durationMs } : {}),
                ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
              };
            }
          } catch (error) {
            status = "error";
            nextError = {
              code: "internalError",
              message: error instanceof Error ? error.message : String(error),
              retryable: !(error instanceof RendererMethodUnavailableError),
              stage: "request",
            };
          }
          if (generation !== state.requestGeneration || disposed) return;
          const previousStatus = state.availability[agent];
          state.errors[agent] = nextError;
          state.availability = { ...state.availability, [agent]: status };
          state.webUi = { ...state.webUi, [agent]: webUiAvailable };
          if (hostId !== activeAvailabilityHostId) {
            notifyConnectionListeners();
            return;
          }
          for (const mounted of composerEntries.values()) {
            const composerState = controller.get(mounted.composer);
            if (
              adapterStatus.state === "ready" &&
              composerState.phase === "draft" &&
              composerState.agent === agent &&
              status !== "ready"
            ) {
              await switchAgentOnComposer(mounted, "codex");
            }
          }
          for (const mounted of composerEntries.values()) {
            const composerState = controller.get(mounted.composer);
            if (
              composerState.agent === agent &&
              shouldReloadExternalCatalogAfterAvailabilityRefresh(
                previousStatus,
                status,
                externalViewsSettled(mounted.modelView, mounted.permissionModeView),
                refresh && force,
              )
            ) {
              void loadExternalConfiguration(mounted);
            }
            paintComposer(mounted);
          }
          notifyConnectionListeners();
        }),
      );
      if (generation !== state.requestGeneration || disposed) return;
      if (retryableHarnessAvailabilityAgents(state.availability, state.errors).length === 0) {
        clearAvailabilityRetry(hostId);
      } else {
        armAvailabilityRetry(hostId);
      }
    })();
    const request = { client, promise };
    state.request = request;
    void promise.then(
      () => {
        if (state.request === request) state.request = null;
      },
      () => {
        if (state.request === request) state.request = null;
      },
    );
    return promise;
  }

  const reassignComposersToHost = (hostId: string): void => {
    for (const mounted of composerEntries.values()) {
      if (mounted.hostId === hostId) continue;
      if (!threadIdFromComposerModelTarget(mounted.modelTarget)) {
        controller.clearPendingSubmission(mounted.composer);
        mounted.hostId = hostId;
        mounted.usage = null;
        mounted.accountCredits = null;
        mounted.usageRequestGeneration += 1;
        continue;
      }
      const target = controllerTarget(mounted.modelTarget, hostId);
      if (controller.rebindConversation(mounted.composer, target) === null) {
        mounted.ownershipStatus = "error";
        paintComposer(mounted);
        continue;
      }
      mounted.hostId = hostId;
      mounted.composerId = controller.get(mounted.composer).composerId;
      mounted.modelView = { status: "idle" };
      mounted.permissionModeView = { status: "idle" };
      mounted.threadConfiguration = undefined;
      mounted.ownershipStatus = "loading";
      mounted.usage = null;
      mounted.accountCredits = null;
      mounted.usageRequestGeneration += 1;
      usageRefreshAttempts.delete(mounted.composer);
      const timer = usageRefreshTimers.get(mounted.composer);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        usageRefreshTimers.delete(mounted.composer);
      }
      paintComposer(mounted);
      void restoreThreadOwnership(mounted);
    }
    sidebarIcons.refresh();
  };

  function syncActiveHost(): void {
    const hostId = activeModelHostId();
    if (
      !hostId ||
      (hostId === activeAvailabilityHostId &&
        [...composerEntries.values()].every((mounted) => mounted.hostId !== null))
    )
      return;
    // The first composer can mount before the route is ready. The availability
    // cache starts at "local", but that does not establish the composer's Host.
    activeAvailabilityHostId = hostId;
    hostState(hostId);
    reassignComposersToHost(hostId);
    notifyConnectionListeners();
    for (const mounted of composerEntries.values()) paintComposer(mounted);
    void pollHostAvailability(hostId);
  }

  const refreshActiveHostAvailability = (refresh = false): Promise<void> => {
    syncActiveHost();
    return pollHostAvailability(activeAvailabilityHostId, refresh);
  };

  connectionDiagnostics = {
    snapshot(): RendererConnectionSnapshot {
      const hostIds = [
        "local",
        ...[...availabilityByHost.keys()].filter((hostId) => hostId !== "local").sort(),
      ];
      return {
        adapter: { ...adapterStatus },
        hosts: hostIds.map((hostId) => {
          const state = hostState(hostId);
          return {
            hostId,
            active: hostId === activeAvailabilityHostId,
            agents: externalAgents.map((agent) => ({
              agent,
              availability: state.availability[agent] ?? "checking",
              error: state.errors[agent] ?? null,
              ...(state.webUi[agent] ? { webUiAvailable: true as const } : {}),
            })),
          };
        }),
      };
    },
    refresh(): Promise<void> {
      return refreshConnectionHosts(availabilityByHost.keys(), (hostId) =>
        pollHostAvailability(hostId, true, false, true),
      );
    },
    async openWebUi(hostId: string, agent: ExternalRendererAgent): Promise<void> {
      const state = hostState(hostId);
      const client = hostId === "local" ? modelClientForHost(hostId) : null;
      if (
        state.availability[agent] !== "ready" ||
        state.webUi[agent] !== true ||
        !client?.openHarnessWebUi
      ) {
        throw new Error("Harness Web UI is unavailable");
      }
      try {
        await client.openHarnessWebUi({ harnessId: externalHarnessIds[agent] });
      } catch (error) {
        state.webUi = { ...state.webUi, [agent]: false };
        notifyConnectionListeners();
        void pollHostAvailability(hostId, true, false, true).catch(() => undefined);
        throw error;
      }
    },
    inspectHarness(hostId: string, agent: ExternalRendererAgent) {
      const client = modelClientForHost(hostId);
      if (!client?.inspectHarness) throw new Error("Harness inspect is unavailable");
      return client.inspectHarness({ harnessId: externalHarnessIds[agent] });
    },
    async installHarness(hostId: string, agent: ExternalRendererAgent, options?: { terminal?: boolean }) {
      const client = modelClientForHost(hostId);
      if (!client?.installHarness) throw new Error("Harness install is unavailable");
      const result = await client.installHarness({ harnessId: externalHarnessIds[agent], terminal: options?.terminal });
      void pollHostAvailability(hostId, true, false, true).catch(() => undefined);
      return result;
    },
    subscribe(listener: () => void): () => void {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };

  const mountComposer = (composer: Element): void => {
    if (
      composerEntries.has(composer) ||
      !composer.isConnected ||
      !composer.matches(CODEX_COMPOSER_SELECTOR)
    ) {
      return;
    }
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (!sendButton) return;
    const modelTarget = findComposerModelTarget(composer);
    const hostId = activeModelHostId();
    const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (!editor) return;
    const state = controller.mount(
      composer,
      controllerTarget(modelTarget, hostId),
      modelTarget?.[0] === "default" ? readNewThreadAgentPreference(enabledAgentSet) : undefined,
    );
    const inherited = replacementQueue.get(composer)?.source;
    const control = mountComposerAgentControl(
      composer,
      state.composerId,
      sendButton,
      enabledAgents,
      (agent) => {
        const mounted = composerEntries.get(composer);
        if (!composer.isConnected || !mounted) return;
        const current = controller.get(composer);
        if (current.phase === "locked") {
          if (current.agent !== "codex" && agent !== "codex") {
            mounted.control.harnessHandoff.open(current.agent, agent, settingsLifecycle.locale);
          }
          return;
        }
        void switchAgentOnComposer(mounted, agent);
      },
      openInstallPage,
      async (accountId) => {
        const mounted = composerEntries.get(composer);
        if (!composer.isConnected || !mounted) return;
        await applyCodexAccountChoice(mounted, accountId);
      },
      () => {
        void reloadCodexAccounts();
      },
      (modelId) => {
        const mounted = composerEntries.get(composer);
        if (!composer.isConnected || !mounted) return;
        void pickExternalModel(mounted, modelId);
      },
      (thinkingOptionId) => {
        const mounted = composerEntries.get(composer);
        if (!composer.isConnected || !mounted) return;
        void pickExternalThinking(mounted, thinkingOptionId);
      },
      (permissionModeId) => {
        const mounted = composerEntries.get(composer);
        if (!composer.isConnected || !mounted) return;
        void pickPermissionMode(mounted, permissionModeId);
      },
      (command) => {
        const mounted = composerEntries.get(composer);
        if (mounted) chooseCommand(mounted, command);
      },
      (request) => {
        const mounted = composerEntries.get(composer);
        if (!composer.isConnected || !mounted) return;
        void performHarnessHandoff(mounted, request);
      },
    );
    const mounted: ComposerEntry = {
      composer,
      composerId: state.composerId,
      control,
      modelTarget,
      modelView: inherited?.modelView ?? { status: "idle" },
      permissionModeView: inherited?.permissionModeView ?? { status: "idle" },
      ownershipStatus: threadIdFromComposerModelTarget(modelTarget)
        ? inherited
          ? "ready"
          : "loading"
        : "not-required",
      threadConfiguration: inherited?.threadConfiguration,
      usage: inherited?.usage ?? null,
      accountCredits: inherited?.accountCredits ?? null,
      hostId: inherited?.hostId ?? hostId,
      usageRequestGeneration: 0,
      commandRequestGeneration: 0,
      harnessSwitching: false,
    };
    composerEntries.set(composer, mounted);
    if (isComposerModelWriteAllowed(modelTarget)) {
      const model = controller.modelForAgent(composer, state.agent);
      if (shouldApplyDraftAgentCarrier(state.agent, model)) {
        applyAdapterAgent?.(
          state.agent,
          model,
          state.agent !== "codex"
            ? controller.thinkingOptionForAgent(composer, state.agent)
            : undefined,
          state.agent !== "codex"
            ? controller.permissionModeForAgent(composer, state.agent)
            : undefined,
          composer,
        );
      }
    }
    paintComposer(mounted);
    sidebarIcons.refresh();
    if (threadIdFromComposerModelTarget(modelTarget) && !inherited) {
      void restoreThreadOwnership(mounted);
    } else if (
      threadIdFromComposerModelTarget(modelTarget) &&
      inherited &&
      shouldRetryExternalThreadUsage(state.agent, mounted.usage, mounted.accountCredits)
    ) {
      queueThreadUsageRetry(mounted);
    } else if (
      state.agent !== "codex" &&
      !externalViewsSettled(mounted.modelView, mounted.permissionModeView)
    ) {
      void loadExternalConfiguration(mounted);
    }
    if (!threadIdFromComposerModelTarget(modelTarget)) void pollDraftCodexUsage(mounted);
    void reloadCommandCatalog(mounted);
  };

  const runScan = (): void => {
    scanScheduled = false;
    const refreshTargets = refreshTargetsOnNextScan;
    refreshTargetsOnNextScan = false;
    if (disposed) return;
    settingsLifecycle.refresh();
    for (const [target, replacement] of replacementQueue) {
      const sourceState = controller.get(replacement.source.composer);
      const replacementTarget = findComposerModelTarget(target);
      const replacementHostId = activeModelHostId() ?? replacement.source.hostId;
      if (
        !shouldTransferComposerState(
          replacement.sourceModelTarget,
          replacementTarget,
          sourceState.phase,
          controller.isSubmissionPending(replacement.source.composer),
        ) ||
        !controller.transfer(
          replacement.source.composer,
          target,
          controllerTarget(replacementTarget, replacementHostId),
        )
      ) {
        replacementQueue.delete(target);
      }
    }
    for (const [composer, mounted] of composerEntries) {
      if (
        !composer.isConnected ||
        !composer.matches(CODEX_COMPOSER_SELECTOR) ||
        !mounted.control.root.isConnected
      ) {
        mounted.usageRequestGeneration += 1;
        usageRefreshAttempts.delete(composer);
        const timer = usageRefreshTimers.get(composer);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          usageRefreshTimers.delete(composer);
        }
        disposeComposerAgentControl(mounted.control);
        composerEntries.delete(composer);
        continue;
      }
      const state = controller.get(composer);
      const hideCodexControls = controller.isSwitching(composer) || state.agent !== "codex";
      reconcileComposerNativeControls(mounted.control, hideCodexControls, hideCodexControls);
      if (refreshTargets) syncMountedTarget(mounted);
    }
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      const composer = composerForEditor(editor);
      if (composer) mountComposer(composer);
    }
    const localAvailability = hostState("local").availability;
    if (externalAgents.some((agent) => localAvailability[agent] === "checking")) {
      void pollHostAvailability("local");
    }
    syncActiveHost();
    if (
      externalAgents.some(
        (agent) => activeHostState().availability[agent] === "checking",
      )
    ) {
      void refreshActiveHostAvailability();
    }
    replacementQueue.clear();
  };

  const requestScan = (refreshTargets = false): void => {
    refreshTargetsOnNextScan ||= refreshTargets;
    if (scanScheduled || disposed) return;
    scanScheduled = true;
    queueMicrotask(runScan);
  };

  const composerRootsIn = (node: Node): Element[] => {
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const element = node as Element;
    const roots = element.matches(CODEX_COMPOSER_SELECTOR) ? [element] : [];
    roots.push(...element.querySelectorAll(CODEX_COMPOSER_SELECTOR));
    return roots;
  };

  const trackComposerReplacements = (mutations: MutationRecord[]): void => {
    const replacements = new Map<Node, { removed: Set<Element>; added: Set<Element> }>();
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      let replacement = replacements.get(mutation.target);
      if (!replacement) {
        replacement = { removed: new Set(), added: new Set() };
        replacements.set(mutation.target, replacement);
      }
      for (const removedNode of mutation.removedNodes) {
        for (const composer of composerEntries.keys()) {
          if (
            removedNode === composer ||
            (removedNode.nodeType === Node.ELEMENT_NODE &&
              (removedNode as Element).contains(composer))
          ) {
            replacement.removed.add(composer);
          }
        }
      }
      for (const addedNode of mutation.addedNodes) {
        for (const composer of composerRootsIn(addedNode)) replacement.added.add(composer);
      }
    }
    for (const replacement of replacements.values()) {
      if (replacement.removed.size !== 1 || replacement.added.size !== 1) continue;
      const source = replacement.removed.values().next().value as Element;
      const target = replacement.added.values().next().value as Element;
      const mounted = composerEntries.get(source);
      if (source !== target && mounted) {
        replacementQueue.set(target, {
          source: mounted,
          sourceModelTarget: mounted.modelTarget,
        });
      }
    }
  };

  const pushComposerCarrier = (composer: Element): boolean => {
    const state = controller.get(composer);
    const mounted = composerEntries.get(composer);
    if (mounted?.modelTarget?.[0] === "conversation") {
      return state.phase === "locked" && mounted.ownershipStatus === "ready";
    }
    if (!mounted || !isComposerModelWriteAllowed(mounted.modelTarget)) return false;
    const model = controller.modelForAgent(composer, state.agent);
    if (!shouldApplyDraftAgentCarrier(state.agent, model)) return false;
    return applyComposerModelWrite(
      mounted.modelTarget,
      () =>
        applyAdapterAgent?.(
          state.agent,
          model,
          state.agent !== "codex"
            ? controller.thinkingOptionForAgent(composer, state.agent)
            : undefined,
          state.agent !== "codex"
            ? controller.permissionModeForAgent(composer, state.agent)
            : undefined,
          composer,
        ) ?? state.agent === "codex",
    );
  };
  const swallowEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const authorizeSubmission = (composer: Element): boolean | null => {
    const mounted = composerEntries.get(composer);
    if (!mounted) return null;
    const current = controller.get(composer);
    if (
      codexAccountsForComposer(composer)?.switching ||
      controller.isSwitching(composer) ||
      isOwnershipSubmissionBlocked(mounted.ownershipStatus)
    ) {
      return false;
    }
    if (!externalConfigurationReady(mounted)) return false;
    if (current.phase === "locked") return true;
    if (!pushComposerCarrier(composer)) return false;
    if (current.agent === "codex") {
      // A Host switch can replace the policy while keeping this Host's draft
      // override. Apply it to the matching policy at submission time only.
      const accounts = codexAccountsForComposer(composer);
      const policy = window.__harnessmixDraftPrewarmPolicyV1;
      const hostAvailability =
        mounted.hostId === null ? null : hostState(mounted.hostId);
      const selectedAccount = accounts?.accounts.find((account) =>
        account.accountId === accounts.selection.selectedAccountId);
      const needsIsolatedAccountRoute = accounts?.loaded === true
        ? selectedAccount?.management === "isolated"
        : current.codexAccountId !== null && current.codexAccountId !== "official-codex";
      if (
        (window.__harnessmixSidecarModeV1 !== true || needsIsolatedAccountRoute) &&
        shouldBlockCodexDraftSubmission({
          accountsResolved: accounts !== null,
          accountsLoaded: accounts?.loaded === true,
          hostIsolatedAccountsLatched: hostAvailability?.codexAccountsIsolated === true,
          policyHostId: policy?.hostId ?? null,
          composerHostId: mounted.hostId,
        })
      ) {
        // The owned bridge is installed for this Host and the Host is known to
        // carry isolated (routed) Codex accounts, but the composer's account
        // routing state could not be resolved yet — typically the request
        // manager was just recreated (new thread/task) and the replacement
        // has not been captured. Letting the submission through now would
        // drop the account route marker and silently create the thread on the
        // official Codex route (duplicate session). Fail closed, kick a
        // reload, and let the next submission attempt re-run this guard.
        void reloadCodexAccounts();
        return false;
      }
      const selection = accounts?.selection;
      const accountId =
        controller.isSubmissionPending(composer) && current.codexAccountId
          ? current.codexAccountId
          : selection?.selectedAccountId;
      const override = codexAccountRouteOverride(accounts?.accounts ?? [], accountId);
      if (override !== null && (policy?.hostId !== mounted.hostId || !policy.selectAccount)) {
        return false;
      }
      try {
        if (policy?.hostId === mounted.hostId) policy.selectAccount?.(override);
      } catch {
        return false;
      }
    }
    controller.markSubmissionPending(composer);
    paintComposer(mounted);
    return true;
  };
  const composerFromEventTarget = (target: EventTarget | null): Element | null => {
    const element = eventElement(target);
    const editor = element ? editorForElement(element) : null;
    const composer = editor ? composerForEditor(editor) : null;
    return composer && isLiveComposer(composer) ? composer : null;
  };
  const handleBeforeInput = (event: InputEvent): void => {
    const composer = composerFromEventTarget(event.target);
    if (!composer) return;
    controller.clearPendingSubmission(composer);
    const mounted = composerEntries.get(composer);
    if (mounted && isOwnershipSubmissionBlocked(mounted.ownershipStatus)) return;
    // Draft editing must remain available while the native connection recovers;
    // submission itself still goes through authorizeSubmission and fails closed.
    if (!controller.isSwitching(composer)) pushComposerCarrier(composer);
  };
  const handleSubmit = (event: Event): void => {
    const element = eventElement(event.target);
    const candidate = element ? composerForElement(element) : null;
    const composer = candidate && isLiveComposer(candidate) ? candidate : null;
    if (!composer) return;
    const prepared = authorizeSubmission(composer);
    if (prepared === null) return;
    if (!prepared) {
      swallowEvent(event);
      return;
    }
    mentionsBridge.prepareSubmission(composer);
    announceSubmission(composer, "submit");
  };
  const handleKeyDown = (event: KeyboardEvent): void => {
    const composer = isComposerInputIntent(event) ? composerFromEventTarget(event.target) : null;
    const mounted = composer ? composerEntries.get(composer) : undefined;
    if (
      composer &&
      (codexAccountsForComposer(composer)?.switching ||
        controller.isSwitching(composer) ||
        mounted?.harnessSwitching)
    ) {
      if (isComposerSubmissionKey(event)) swallowEvent(event);
      return;
    }
    if (composer && mounted && isOwnershipSubmissionBlocked(mounted.ownershipStatus)) {
      if (isComposerSubmissionKey(event)) swallowEvent(event);
      return;
    }
    if (composer && !pushComposerCarrier(composer)) {
      if (isComposerSubmissionKey(event)) swallowEvent(event);
      return;
    }
    if (!isComposerSubmissionKey(event) || !composer) return;
    if (!authorizeSubmission(composer)) {
      swallowEvent(event);
      return;
    }
    mentionsBridge.prepareSubmission(composer);
    announceSubmission(composer, "enter");
  };
  const handleClick = (event: MouseEvent): void => {
    const element = eventElement(event.target);
    const button = element?.closest<HTMLButtonElement>("button");
    if (!button) return;
    const candidate = composerForElement(button);
    const composer = candidate && isLiveComposer(candidate) ? candidate : null;
    const mounted = composer ? composerEntries.get(composer) : undefined;
    if (!composer || mounted?.control.sendButton !== button || isComposerStopButton(button)) return;
    if (!authorizeSubmission(composer)) {
      swallowEvent(event);
      return;
    }
    mentionsBridge.prepareSubmission(composer);
    announceSubmission(composer, "click");
  };

  const mutationObserver = new MutationObserver((mutations) => {
    trackComposerReplacements(mutations);
    requestScan(mutations.some(mutationTouchesComposerTarget));
  });
  const handleRouteChange = (): void => {
    sidebarIcons.refresh();
    syncActiveHost();
    void reloadCodexAccounts();
    void refreshActiveHostAvailability();
    for (const mounted of composerEntries.values()) {
      const state = controller.get(mounted.composer);
      if (
        state.agent !== "codex" &&
        !threadIdFromComposerModelTarget(mounted.modelTarget) &&
        !externalViewsSettled(mounted.modelView, mounted.permissionModeView)
      ) {
        void loadExternalConfiguration(mounted);
      }
    }
  };
  const handleAdapterStatus = () => {
    notifyConnectionListeners();
    if (shouldRefreshCodexAccountsForAdapterState(adapterStatus.state)) {
      void reloadCodexAccounts();
      sidebarIcons.refresh();
      void pollHostAvailability("local");
      void refreshActiveHostAvailability();
      for (const mounted of composerEntries.values()) {
        if (mounted.modelView.status === "waitingForAdapter" && mounted.composer.isConnected) {
          pushComposerCarrier(mounted.composer);
          void loadExternalConfiguration(mounted);
        }
      }
    }
    for (const mounted of composerEntries.values()) paintComposer(mounted);
  };
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "data-codex-composer-root"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  document.addEventListener("beforeinput", handleBeforeInput, true);
  document.addEventListener("submit", handleSubmit, true);
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("click", handleClick, true);
  const handleWindowFocus = (): void => {
    syncActiveHost();
    void reloadCodexAccounts();
    for (const mounted of composerEntries.values()) {
      if (mounted.hostId === activeModelHostId() && mounted.ownershipStatus === "error") {
        void restoreThreadOwnership(mounted);
      }
    }
    const local = hostState("local");
    if (externalAgents.some((agent) => local.availability[agent] !== "ready")) {
      void pollHostAvailability("local", true);
    }
    const active = activeHostState();
    if (externalAgents.some((agent) => active.availability[agent] !== "ready")) {
      void refreshActiveHostAvailability(true);
    }
  };
  window.addEventListener("harnessmix:draft-prewarm-policy-changed", handleRouteChange);
  window.addEventListener("harnessmix:renderer-adapter-status", handleAdapterStatus);
  window.addEventListener("focus", handleWindowFocus);

  const liveComposers = (): ComposerEntry[] =>
    [...composerEntries.values()].filter(
      (mounted) => mounted.composer.isConnected && mounted.control.root.isConnected,
    );

  const api: RendererBindingProbeApi = {
    status() {
      const selections = liveComposers().map((mounted) => ({
        composerId: mounted.composerId,
        agent: controller.get(mounted.composer).agent,
        phase: controller.get(mounted.composer).phase,
        // Live debugging surface: the raw external model/permission views plus
        // the selection refs held by the controller.
        ownership: mounted.ownershipStatus,
        modelView: {
          status: mounted.modelView.status,
          ...(mounted.modelView.catalog
            ? { catalogModels: mounted.modelView.catalog.models.map((m) => m.ref.id.slice(0, 24)) }
            : {}),
          ...(mounted.modelView.selected ? { selected: mounted.modelView.selected.id.slice(0, 24) } : {}),
          ...(mounted.modelView.error ? { error: mounted.modelView.error.slice(0, 160) } : {}),
        },
        ...(controller.get(mounted.composer).phase === "locked" && mounted.composerId
          ? {
              controllerModel: ((): string | undefined => {
                const agent = controller.get(mounted.composer).agent;
                if (agent === "codex") return undefined;
                const model = controller.modelForAgent(mounted.composer, agent);
                return model ? model.id.slice(0, 24) : undefined;
              })(),
            }
          : {}),
        permissionView: mounted.permissionModeView.status,
      }));
      return {
        version: 2,
        mountedComposers: selections.length,
        enabledAgents: [...enabledAgents],
        availability: { ...activeHostState().availability },
        selections,
        adapter: { ...adapterStatus },
      };
    },
    lockedSelection() {
      const locked = liveComposers()
        .map((mounted) => ({ mounted, state: controller.get(mounted.composer) }))
        .filter(({ state }) => state.phase === "locked");
      const entry = locked[0];
      if (locked.length !== 1 || !entry) return null;
      const { mounted, state: selection } = entry;
      const model = controller.modelForAgent(mounted.composer, selection.agent);
      const thinkingOptionId =
        selection.agent !== "codex"
          ? controller.thinkingOptionForAgent(mounted.composer, selection.agent)
          : undefined;
      const permissionModeId =
        selection.agent !== "codex"
          ? controller.permissionModeForAgent(mounted.composer, selection.agent)
          : undefined;
      return {
        composerId: selection.composerId,
        agent: selection.agent,
        phase: "locked",
        ...(model ? { model } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        ...(permissionModeId ? { permissionModeId } : {}),
      };
    },
    setAdapter(status, dispose, applyAgent, nextModelControl) {
      usageNotificationDispose?.();
      usageNotificationDispose = null;
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      modelControl = nextModelControl ?? null;
      try {
        usageNotificationDispose =
          modelControl?.subscribeThreadUsage?.(onThreadUsageUpdate) ?? null;
      } catch {
        usageNotificationDispose = null;
      }
      adapterStatus = status;
      notifyConnectionListeners();
      const installedModelControl = modelControl;
      queueMicrotask(() => {
        if (disposed || modelControl !== installedModelControl) return;
        try {
          settingsLifecycle.refresh();
        } catch {
          // The auxiliary settings UI must not affect agent routing.
        }
      });
      for (const state of availabilityByHost.values()) {
        state.requestGeneration += 1;
        state.request = null;
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      availabilityByHost.clear();
      activeAvailabilityHostId = "local";
      sidebarIcons.refresh();
      void pollHostAvailability("local");
      syncActiveHost();
      void reloadCodexAccounts();
      const connected = liveComposers();
      if (connected.length === 1) {
        const mounted = connected[0];
        if (mounted) {
          const state = controller.get(mounted.composer);
          if (!threadIdFromComposerModelTarget(mounted.modelTarget)) {
            mounted.hostId = activeModelHostId();
          }
          if (
            threadIdFromComposerModelTarget(mounted.modelTarget) &&
            mounted.ownershipStatus !== "ready"
          ) {
            void restoreThreadOwnership(mounted);
          } else if (state.agent !== "codex") {
            void loadExternalConfiguration(mounted);
          } else if (isComposerModelWriteAllowed(mounted.modelTarget)) {
            pushComposerCarrier(mounted.composer);
          }
        }
      }
      for (const mounted of composerEntries.values()) {
        paintComposer(mounted);
        void reloadCommandCatalog(mounted);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      usageNotificationDispose?.();
      usageNotificationDispose = null;
      adapterDispose?.();
      adapterDispose = null;
      applyAdapterAgent = null;
      modelControl = null;
      mutationObserver.disconnect();
      sidebarIcons.dispose();
      mentionsBridge.dispose();
      collaborationCards.dispose();
      teamCards.dispose();
      settingsLifecycle.dispose();
      document.removeEventListener("beforeinput", handleBeforeInput, true);
      document.removeEventListener("submit", handleSubmit, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("harnessmix:draft-prewarm-policy-changed", handleRouteChange);
      window.removeEventListener("harnessmix:renderer-adapter-status", handleAdapterStatus);
      window.removeEventListener("focus", handleWindowFocus);
      for (const state of availabilityByHost.values()) {
        state.requestGeneration += 1;
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      availabilityByHost.clear();
      for (const timer of usageRefreshTimers.values()) window.clearTimeout(timer);
      usageRefreshTimers.clear();
      for (const mounted of composerEntries.values()) {
        mounted.usageRequestGeneration += 1;
        usageRefreshAttempts.delete(mounted.composer);
        disposeComposerAgentControl(mounted.control);
      }
      composerEntries.clear();
      replacementQueue.clear();
      connectionListeners.clear();
      connectionDiagnostics = null;
      delete window.__harnessmixRendererBindingProbeV1;
    },
  };
  window.__harnessmixRendererBindingProbeV1 = api;
  runScan();
  return api;
}
