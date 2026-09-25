import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  type ExternalThreadForkParams,
  type HarnessInspectParams,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostThreadId,
  type ThreadCommandExecuteParams,
  type HarnessCommandsInspectParams,
  type ThreadCommandsInspectParams,
  type ThreadInspectionParams,
  type ThreadModelSelectParams,
  type ThreadPermissionModeSelectParams,
  type ThreadHarnessSwitchParams,
  type ThreadThinkingSelectParams,
  type ThreadOwnershipListParams,
  type ThreadUsageInspection,
  type ThreadUsageInspectionParams,
} from "@harnessmix/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { installRendererForkControl } from "./renderer-fork-control.js";
import { installRendererExternalSteering } from "./renderer-external-steering.js";
import {
  createRendererModelClient,
  createThreadUsageSubscriptionRelay,
  type RendererModelClient,
} from "./renderer-model-client.js";

// ---------------------------------------------------------------------------
// Transport model carriers
//
// Codex Desktop treats "which model is active" as a plain string carried
// through its request layer. Harness Mix hides each foreign harness inside a
// reserved carrier id; the segments after the carrier describe the selected
// model / permission mode / thinking effort for that harness. These strings are
// a wire contract with the main process and persisted sessions: never rename.
// ---------------------------------------------------------------------------

export const PI_TRANSPORT_MODEL_ID = "harnessmix/pi-native";
export const PI_TRANSPORT_MODEL_PREFIX = `${PI_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_TRANSPORT_MODEL_ID = "harnessmix/claude-code-native";
export const CLAUDE_CODE_TRANSPORT_MODEL_PREFIX = `${CLAUDE_CODE_TRANSPORT_MODEL_ID}@`;
export const DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID = "harnessmix/deepseek-harness-native";
export const DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX = `${DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID}@`;
export const OPENCODE_TRANSPORT_MODEL_ID = "harnessmix/opencode-native";
export const OPENCODE_TRANSPORT_MODEL_PREFIX = `${OPENCODE_TRANSPORT_MODEL_ID}@`;
export const GROK_TRANSPORT_MODEL_ID = "harnessmix/grok-native";
export const GROK_TRANSPORT_MODEL_PREFIX = `${GROK_TRANSPORT_MODEL_ID}@`;
export const OMP_TRANSPORT_MODEL_ID = "harnessmix/omp-native";
export const OMP_TRANSPORT_MODEL_PREFIX = `${OMP_TRANSPORT_MODEL_ID}@`;
export const ANTIGRAVITY_TRANSPORT_MODEL_ID = "harnessmix/antigravity-native";
export const ANTIGRAVITY_TRANSPORT_MODEL_PREFIX = `${ANTIGRAVITY_TRANSPORT_MODEL_ID}@`;

export type RendererAdapterState = "installing" | "ready" | "unsupported";

export interface LockedComposerSelection {
  agent: RendererAgent;
  composerId: string;
  phase: "locked";
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

export interface RendererAdapterStatus {
  state: RendererAdapterState;
  reason:
    | "installing"
    | "ready"
    | "asset-import-failed"
    | "installation-failed"
    | "draft-prewarm-clear-failed"
    | "draft-routing-policy-unavailable";
  modelUpdates: number;
  hook: "request-bridge" | null;
}

export function transitionRendererAdapterStatus(
  current: RendererAdapterStatus,
  next: Pick<RendererAdapterStatus, "state" | "reason" | "hook">,
  publish: () => void,
): boolean {
  const unchanged =
    current.state === next.state && current.reason === next.reason && current.hook === next.hook;
  if (unchanged) return false;
  current.state = next.state;
  current.reason = next.reason;
  current.hook = next.hook;
  publish();
  return true;
}

// --- carrier encode helpers -------------------------------------------------

function carrierWithThinking(prefix: string, modelId: string, thinking: string | undefined) {
  return `${prefix}${modelId}${thinking ? `@${thinking}` : ""}`;
}

function carrierWithPermission(prefix: string, modelId: string, permission: string | undefined) {
  return `${prefix}${modelId}${permission ? `@${permission}` : ""}`;
}

function carrierWithPermissionThenThinking(
  prefix: string,
  modelId: string,
  permission: string | undefined,
  thinking: string | undefined,
) {
  if (thinking) return `${prefix}${modelId}@${permission ?? ""}@${thinking}`;
  return carrierWithPermission(prefix, modelId, permission);
}

function carrierWithThinkingThenPermission(
  prefix: string,
  modelId: string,
  thinking: string | undefined,
  permission: string | undefined,
) {
  if (permission) return `${prefix}${modelId}@${permission}@${thinking ?? ""}`;
  return carrierWithThinking(prefix, modelId, thinking);
}

// --- carrier decode helpers -------------------------------------------------

/**
 * Splits a carrier into its raw `@`-separated components. `[]` means the bare
 * carrier id; `null` means the value does not belong to this carrier family or
 * carries an unsupported number of segments.
 */
function carrierComponents(value: unknown, baseId: string, prefix: string, max: number) {
  if (value === baseId) return [] as string[];
  if (typeof value !== "string" || !value.startsWith(prefix)) return null;
  const components = value.slice(prefix.length).split("@");
  return components.length >= 1 && components.length <= max ? components : null;
}

function parseCarrierModel(modelId: string | undefined): HarnessModelRef | null {
  if (modelId === undefined) return null;
  const parsed = harnessModelRefSchema.safeParse({ id: modelId });
  return parsed.success ? parsed.data : null;
}

function parsePermissionSegment(segment: string | undefined) {
  return segment ? harnessPermissionModeIdSchema.safeParse(segment) : null;
}

function parseThinkingSegment(segment: string | undefined) {
  return segment ? harnessThinkingOptionIdSchema.safeParse(segment) : null;
}

function rejected<T extends { success: boolean }>(result: T | null): boolean {
  return result !== null && !result.success;
}

/** model[@permission][@thinking] — Claude Code, Grok, OpenCode, Antigravity. */
function decodePermissionThenThinkingCarrier(value: unknown, baseId: string, prefix: string): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  const components = carrierComponents(value, baseId, prefix, 3);
  if (!components) return null;
  if (components.length === 0) return {};
  const [modelId, permissionSegment, thinkingSegment] = components;
  if (components.length === 2 && !permissionSegment) return null;
  if (components.length === 3 && !thinkingSegment) return null;
  const model = parseCarrierModel(modelId);
  if (!model) return null;
  const permission = parsePermissionSegment(permissionSegment);
  if (rejected(permission)) return null;
  const thinking = parseThinkingSegment(thinkingSegment);
  if (rejected(thinking)) return null;
  return {
    model,
    ...(permission?.success ? { permissionModeId: permission.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

// --- per-harness codecs ------------------------------------------------------

export function piTransportModelId(
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (thinkingOptionId) throw new Error("Pi transport Thinking requires a Model Ref");
    return PI_TRANSPORT_MODEL_ID;
  }
  const modelId = harnessModelRefSchema.parse(model).id;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return carrierWithThinking(PI_TRANSPORT_MODEL_PREFIX, modelId, thinking);
}

export function decodePiTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
} | null {
  const components = carrierComponents(value, PI_TRANSPORT_MODEL_ID, PI_TRANSPORT_MODEL_PREFIX, 2);
  if (!components) return null;
  if (components.length === 0) return {};
  const [modelId, thinkingSegment] = components;
  if (components.length === 2 && !thinkingSegment) return null;
  const model = parseCarrierModel(modelId);
  if (!model) return null;
  const thinking = parseThinkingSegment(thinkingSegment);
  if (rejected(thinking)) return null;
  return {
    model,
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function isPiTransportModelId(value: unknown): value is string {
  return decodePiTransportModelId(value) !== null;
}

export function claudeTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Claude Code transport configuration requires a Model Ref");
    }
    return CLAUDE_CODE_TRANSPORT_MODEL_ID;
  }
  const modelId = harnessModelRefSchema.parse(model).id;
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return carrierWithPermissionThenThinking(CLAUDE_CODE_TRANSPORT_MODEL_PREFIX, modelId, permission, thinking);
}

export function decodeClaudeTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  return decodePermissionThenThinkingCarrier(
    value,
    CLAUDE_CODE_TRANSPORT_MODEL_ID,
    CLAUDE_CODE_TRANSPORT_MODEL_PREFIX,
  );
}

export function isClaudeTransportModelId(value: unknown): value is string {
  return decodeClaudeTransportModelId(value) !== null;
}

export function grokTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Grok transport configuration requires a Model Ref");
    }
    return GROK_TRANSPORT_MODEL_ID;
  }
  const modelId = harnessModelRefSchema.parse(model).id;
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return carrierWithPermissionThenThinking(GROK_TRANSPORT_MODEL_PREFIX, modelId, permission, thinking);
}

export function decodeGrokTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  return decodePermissionThenThinkingCarrier(
    value,
    GROK_TRANSPORT_MODEL_ID,
    GROK_TRANSPORT_MODEL_PREFIX,
  );
}

export function isGrokTransportModelId(value: unknown): value is string {
  return decodeGrokTransportModelId(value) !== null;
}

export function openCodeTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("OpenCode transport configuration requires a Model Ref");
    }
    return OPENCODE_TRANSPORT_MODEL_ID;
  }
  const modelId = harnessModelRefSchema.parse(model).id;
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return carrierWithPermissionThenThinking(OPENCODE_TRANSPORT_MODEL_PREFIX, modelId, permission, thinking);
}

export function decodeOpenCodeTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  return decodePermissionThenThinkingCarrier(
    value,
    OPENCODE_TRANSPORT_MODEL_ID,
    OPENCODE_TRANSPORT_MODEL_PREFIX,
  );
}

export function isOpenCodeTransportModelId(value: unknown): value is string {
  return decodeOpenCodeTransportModelId(value) !== null;
}

export function antigravityTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Antigravity transport configuration requires a Model Ref");
    }
    return ANTIGRAVITY_TRANSPORT_MODEL_ID;
  }
  const modelId = harnessModelRefSchema.parse(model).id;
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return carrierWithPermissionThenThinking(
    ANTIGRAVITY_TRANSPORT_MODEL_PREFIX,
    modelId,
    permission,
    thinking,
  );
}

export function decodeAntigravityTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  return decodePermissionThenThinkingCarrier(
    value,
    ANTIGRAVITY_TRANSPORT_MODEL_ID,
    ANTIGRAVITY_TRANSPORT_MODEL_PREFIX,
  );
}

export function isAntigravityTransportModelId(value: unknown): value is string {
  return decodeAntigravityTransportModelId(value) !== null;
}

export function deepSeekHarnessTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
): string {
  if (!model) {
    if (permissionModeId) {
      throw new Error("DeepSeek Harness transport Permission Mode requires a Model Ref");
    }
    return DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID;
  }
  const modelId = harnessModelRefSchema.parse(model).id;
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  return carrierWithPermission(DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX, modelId, permission);
}

export function decodeDeepSeekHarnessTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  const components = carrierComponents(
    value,
    DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID,
    DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX,
    2,
  );
  if (!components) return null;
  if (components.length === 0) return {};
  const [modelId, permissionSegment] = components;
  if (components.length === 2 && !permissionSegment) return null;
  const model = parseCarrierModel(modelId);
  if (!model) return null;
  const permission = parsePermissionSegment(permissionSegment);
  if (rejected(permission)) return null;
  return {
    model,
    ...(permission?.success ? { permissionModeId: permission.data } : {}),
  };
}

export function isDeepSeekHarnessTransportModelId(value: unknown): value is string {
  return decodeDeepSeekHarnessTransportModelId(value) !== null;
}

export function ompTransportModelId(
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("OMP transport configuration requires a Model Ref");
    }
    return OMP_TRANSPORT_MODEL_ID;
  }
  const modelId = harnessModelRefSchema.parse(model).id;
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return carrierWithThinkingThenPermission(OMP_TRANSPORT_MODEL_PREFIX, modelId, thinking, permission);
}

export function decodeOmpTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  permissionModeId?: HarnessPermissionModeId;
  thinkingOptionId?: HarnessThinkingOptionId;
} | null {
  const components = carrierComponents(value, OMP_TRANSPORT_MODEL_ID, OMP_TRANSPORT_MODEL_PREFIX, 3);
  if (!components) return null;
  if (components.length === 0) return {};
  const [modelId, middleSegment, thinkingSegment] = components;
  if (components.length !== 1 && !middleSegment) return null;
  const model = parseCarrierModel(modelId);
  if (!model) return null;
  // OMP's two-segment form is model@thinking; three segments mean the middle
  // slot is the permission mode.
  const permission = components.length === 3 ? parsePermissionSegment(middleSegment) : null;
  if (rejected(permission)) return null;
  const thinking =
    components.length === 2
      ? parseThinkingSegment(middleSegment)
      : parseThinkingSegment(thinkingSegment);
  if (rejected(thinking)) return null;
  return {
    model,
    ...(permission?.success ? { permissionModeId: permission.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function isOmpTransportModelId(value: unknown): value is string {
  return decodeOmpTransportModelId(value) !== null;
}

export function threadIdFromComposerModelTarget(
  target: readonly unknown[] | null,
): HostThreadId | null {
  if (
    target?.[0] !== "conversation" ||
    typeof target[1] !== "string" ||
    target[1].trim().length === 0
  ) {
    return null;
  }
  return hostThreadIdSchema.parse(target[1]);
}

// ---------------------------------------------------------------------------
// Adapter-adjacent shared types
// ---------------------------------------------------------------------------

export interface ModelPowerSelection {
  model: unknown;
  reasoningEffort: unknown;
  [key: string]: unknown;
}

export interface RendererDraftPrewarmPolicy {
  state: "ready";
  hostId: string;
  readonly requestTarget?: () => unknown;
  select(model: string | null): boolean;
  readonly selectAccount?: (accountId: string | null) => boolean;
  clear(): Promise<void>;
}

interface RendererDraftPrewarmPolicyTarget {
  __harnessmixDraftPrewarmPolicyV1?: RendererDraftPrewarmPolicy;
  setTimeout(handler: TimerHandler, timeout?: number): number;
}

declare global {
  interface Window {
    __harnessmixMainProcessTitlePolicyV1?: { state: "ready" };
    __harnessmixDraftPrewarmPolicyV1?: RendererDraftPrewarmPolicy;
  }
}

const POLICY_READY_TIMEOUT_MS = 10_000;
const POLICY_POLL_INTERVAL_MS = 25;

// ---------------------------------------------------------------------------
// Composer / React fiber discovery
//
// Everything below reaches into Codex Desktop's React fiber tree to find the
// current request manager and the composer's thread identity. The structural
// expectations (fiber key prefix, hook slot layouts, portal markers, depth
// budgets) are pinned to specific Desktop builds — treat them as protocol.
// ---------------------------------------------------------------------------

interface PrewarmTarget {
  addNotificationCallback?: (
    method: string | readonly string[],
    callback: (notification: unknown) => void,
  ) => () => void;
  enqueueRequest?: (...args: unknown[]) => unknown;
  prewarmThreadStart?: (params: unknown, options?: unknown) => Promise<unknown> | unknown;
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
  requestClient?: PrewarmTarget;
  hostId?: unknown;
  getHostId?: () => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMPOSER_EDITOR_SELECTOR = '[data-codex-composer], [contenteditable="true"][role="textbox"]';
const REACT_FIBER_KEY_PREFIX = "__reactFiber$";

function reactFiberKey(element: Element): string | undefined {
  return Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith(REACT_FIBER_KEY_PREFIX),
  );
}

function reactFiberOf(element: Element): unknown {
  const key = reactFiberKey(element);
  return key ? Object.getOwnPropertyDescriptor(element, key)?.value : undefined;
}

function looksLikeRequestBridge(value: unknown): value is PrewarmTarget {
  return (
    isRecord(value) &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    typeof value.sendRequest === "function" &&
    typeof value.prewarmThreadStart === "function" &&
    typeof value.enqueueRequest === "function"
  );
}

export function findActivePrewarmTargets(root: ParentNode): PrewarmTarget[] {
  const editor = root.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR);
  if (!editor) return [];

  // Find the closest DOM node that actually carries a React fiber: the editor
  // itself, any descendant, then any ancestor.
  let fiberHost: Element | undefined = [editor, ...editor.querySelectorAll("*")].find((element) =>
    reactFiberKey(element) !== undefined,
  );
  if (!fiberHost) {
    for (let ancestor = editor.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (reactFiberKey(ancestor) !== undefined) {
        fiberHost = ancestor;
        break;
      }
    }
  }
  const firstFiber = fiberHost ? reactFiberOf(fiberHost) : undefined;
  if ((typeof firstFiber !== "object" && typeof firstFiber !== "function") || !firstFiber) {
    return [];
  }

  const targets = new Set<PrewarmTarget>();
  let fiber = firstFiber as { return?: unknown; memoizedState?: unknown };
  for (let depth = 0; depth < 200 && fiber; depth += 1) {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
    for (let hookIndex = 0; hook && hookIndex < 100; hookIndex += 1) {
      const hookState = hook.memoizedState;
      if (isRecord(hookState)) {
        // The request manager may sit on the hook state directly or behind a
        // requestClient indirection; prefer whichever object is the bridge.
        const bridge = looksLikeRequestBridge(hookState.requestClient)
          ? hookState.requestClient
          : looksLikeRequestBridge(hookState)
            ? hookState
            : null;
        if (bridge) {
          targets.add(
            typeof hookState.sendRequest === "function"
              ? (hookState as unknown as PrewarmTarget)
              : bridge,
          );
        }
      }
      hook =
        typeof hook.next === "object" && hook.next !== null
          ? (hook.next as { memoizedState?: unknown; next?: unknown })
          : null;
    }
    const parent = fiber.return;
    if ((typeof parent !== "object" && typeof parent !== "function") || parent === null) break;
    fiber = parent as typeof fiber;
  }
  return [...targets];
}

interface ComposerFiber {
  return?: unknown;
  updateQueue?: unknown;
  memoizedProps?: unknown;
}

function findComposerFiber(composer?: Element): ComposerFiber | null {
  const editor =
    composer?.matches(COMPOSER_EDITOR_SELECTOR) === true
      ? composer
      : (composer ?? document).querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR);
  let fiberHost: Element | null = editor ?? null;
  for (let depth = 0; fiberHost && depth < 12; depth += 1) {
    if (reactFiberKey(fiberHost) !== undefined) {
      return (reactFiberOf(fiberHost) as ComposerFiber | null) ?? null;
    }
    fiberHost = fiberHost.parentElement;
  }
  return null;
}

function climbComposerFibers(
  start: ComposerFiber | null,
  visit: (fiber: ComposerFiber) => void,
): void {
  let fiber: ComposerFiber | null = start;
  for (let hop = 0; fiber && hop < 120; hop += 1) {
    visit(fiber);
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as ComposerFiber)
        : null;
  }
}

function findComposerConversationThreadId(composer?: Element): HostThreadId | null | undefined {
  let threadId: HostThreadId | null | undefined;
  climbComposerFibers(findComposerFiber(composer), (fiber) => {
    const props = fiber.memoizedProps;
    if (isRecord(props) && "conversationId" in props && props.conversationId != null) {
      const candidate = hostThreadIdSchema.safeParse(props.conversationId);
      if (!candidate.success || (threadId !== undefined && threadId !== candidate.data)) {
        threadId = null;
        return;
      }
      threadId = candidate.data;
    }
  });
  return threadId;
}

function isLegacyDraftWrapper(value: unknown): value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[3] !== value[5] ||
    value[3] !== value[6] ||
    !isRecord(value[3]) ||
    typeof value[3].get !== "function" ||
    (typeof value[2] !== "string" && value[2] !== null)
  ) {
    return false;
  }
  try {
    const draft = value[3].get();
    return isRecord(draft) && "modelSettings" in draft && "isManuallyChanged" in draft;
  } catch {
    return false;
  }
}

type ComposerDomIdentity =
  | { kind: "unsupported" }
  | { kind: "draft" }
  | { kind: "conversation"; threadId: HostThreadId }
  | { kind: "ambiguous" };

function findComposerDomIdentity(composer: Element): ComposerDomIdentity {
  // Newer Desktop builds stamp exactly one portal marker child on the composer
  // root. Without a conversation id it marks an unsubmitted client draft; with
  // one it marks a thread-bound composer. Anything else is ambiguous and must
  // fail closed rather than trusting unrelated ancestor props.
  const portals = Array.from(composer.children ?? []).filter((child) =>
    child.hasAttribute("data-above-composer-portal"),
  );
  if (portals.length === 0) return { kind: "unsupported" };
  if (portals.length !== 1) return { kind: "ambiguous" };

  const value = portals[0]?.getAttribute("data-above-composer-conversation-id");
  if (value === null) return { kind: "draft" };
  const candidate = hostThreadIdSchema.safeParse(value);
  return candidate.success
    ? { kind: "conversation", threadId: candidate.data }
    : { kind: "ambiguous" };
}

function findComposerDraftIds(composer: Element): Set<string> {
  const draftIds = new Set<string>();
  climbComposerFibers(findComposerFiber(composer), (fiber) => {
    const updateQueue = fiber.updateQueue;
    const memoCache = isRecord(updateQueue) ? updateQueue.memoCache : null;
    const data = isRecord(memoCache) && Array.isArray(memoCache.data) ? memoCache.data : [];
    for (const entry of data) {
      // 26.908 stores the draft-settings hook as a 13-slot memo whose slot 5
      // holds the route-derived draft id and slot 12 the public result object.
      if (Array.isArray(entry) && entry.length === 13 &&
        typeof entry[5] === "string" && entry[5].startsWith("client-new-thread:") &&
        entry[5] === entry[6] && entry[10] === true && typeof entry[11] === "function" &&
        isRecord(entry[9]) && "modelSettings" in entry[9] && "isManuallyChanged" in entry[9] &&
        isRecord(entry[12]) && entry[12].draftSettings === entry[9] &&
        entry[12].isNewThreadDraft === true && entry[12].updateDraftSettings === entry[11]) {
        draftIds.add(entry[5]);
      }
      // Older builds used the seven-slot draft atom wrapper instead.
      if (
        isLegacyDraftWrapper(entry) &&
        typeof entry[2] === "string" &&
        entry[2].startsWith("client-new-thread:")
      ) {
        draftIds.add(entry[2]);
      }
    }
  });
  return draftIds;
}

export function findComposerModelTarget(composer: Element): readonly unknown[] | null {
  const draftIds = findComposerDraftIds(composer);
  const domIdentity = findComposerDomIdentity(composer);
  if (domIdentity.kind === "ambiguous") return null;
  if (domIdentity.kind === "conversation") {
    return ["conversation", domIdentity.threadId];
  }
  if (domIdentity.kind === "draft") {
    return draftIds.size === 1 ? ["default", draftIds.values().next().value] : null;
  }

  // Legacy fallback for Desktop builds without the scoped portal marker: walk
  // ancestor props, still failing closed on ambiguity.
  const conversationThreadId = findComposerConversationThreadId(composer);
  if (conversationThreadId === null) return null;
  if (conversationThreadId !== undefined) return ["conversation", conversationThreadId];

  if (draftIds.size !== 1) return null;
  return ["default", draftIds.values().next().value];
}

export type RendererComposerModelContractState = "draft" | "conversation" | "missing" | "ambiguous";

export function inspectComposerModelContract(
  composer: Element,
): RendererComposerModelContractState {
  const target = findComposerModelTarget(composer);
  if (target?.[0] === "default") return "draft";
  if (target?.[0] === "conversation") return "conversation";
  const domIdentity = findComposerDomIdentity(composer);
  if (domIdentity.kind === "ambiguous") return "ambiguous";
  return "missing";
}

// ---------------------------------------------------------------------------
// Draft routing policy plumbing
// ---------------------------------------------------------------------------

export function isMainProcessTitlePolicyReady(value: unknown): boolean {
  return isRecord(value) && value.state === "ready";
}

export function isDraftPrewarmPolicyReady(value: unknown): value is RendererDraftPrewarmPolicy {
  return (
    isRecord(value) &&
    value.state === "ready" &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    typeof value.select === "function" &&
    typeof value.clear === "function"
  );
}

function prewarmTargetHostId(target: PrewarmTarget): string | null {
  const bridge = target.requestClient ?? target;
  const hostId = target.getHostId?.() ?? bridge.hostId;
  return typeof hostId === "string" && hostId.length > 0 ? hostId : null;
}

function isRendererRequestTarget(value: unknown): value is PrewarmTarget {
  if (!isRecord(value) || typeof value.sendRequest !== "function") return false;
  return looksLikeRequestBridge(value.requestClient ?? value);
}

function declaresRequestTarget(policy: RendererDraftPrewarmPolicy): boolean {
  return "requestTarget" in policy;
}

function policyOwnedTargets(policy: RendererDraftPrewarmPolicy): readonly PrewarmTarget[] | null {
  if (typeof policy.requestTarget !== "function") return null;
  try {
    const target = policy.requestTarget();
    if (!isRendererRequestTarget(target) || prewarmTargetHostId(target) !== policy.hostId) {
      return null;
    }
    return [target];
  } catch {
    return null;
  }
}

export function rendererRequestTargetsForHost(
  targets: readonly PrewarmTarget[],
  hostId: string,
): readonly PrewarmTarget[] | null {
  const matching = targets.filter((target) => prewarmTargetHostId(target) === hostId);
  return matching.length === 1 ? matching : null;
}

function activePrewarmTargetsForPolicy(
  policy: unknown,
  targets: readonly PrewarmTarget[],
): readonly PrewarmTarget[] | null {
  if (!isDraftPrewarmPolicyReady(policy)) return null;
  if (declaresRequestTarget(policy)) return policyOwnedTargets(policy);
  return rendererRequestTargetsForHost(targets, policy.hostId);
}

export function activeRendererDraftPrewarmPolicy(
  policy: unknown,
  targets: readonly PrewarmTarget[],
): RendererDraftPrewarmPolicy | null {
  if (!isDraftPrewarmPolicyReady(policy)) return null;
  return activePrewarmTargetsForPolicy(policy, targets) ? policy : null;
}

export interface RendererRequestRoute {
  readonly policy: RendererDraftPrewarmPolicy;
  readonly targets: readonly PrewarmTarget[];
}

export function resolveRendererRequestRoute(
  policy: unknown,
  discoveredTargets: readonly PrewarmTarget[],
  previous: RendererRequestRoute | null,
): RendererRequestRoute | null {
  const activeTargets = activePrewarmTargetsForPolicy(policy, discoveredTargets);
  if (isDraftPrewarmPolicyReady(policy) && activeTargets) {
    return { policy, targets: activeTargets };
  }

  // A policy that owns its exact target never falls back to discovery.
  if (isDraftPrewarmPolicyReady(policy) && declaresRequestTarget(policy)) return null;

  // Composer swaps and overlay portals can briefly hide the only fiber path to
  // the request manager. Keep the previously confirmed route only while
  // discovery stays empty and the policy object itself is unchanged; any
  // positive discovery for a different host, or a policy replacement,
  // invalidates the cached route immediately.
  return discoveredTargets.length === 0 &&
    isDraftPrewarmPolicyReady(policy) &&
    previous?.policy === policy
    ? previous
    : null;
}

export function createRendererRequestRouteResolver(
  readPolicy: () => unknown,
  discoverTargets: () => readonly PrewarmTarget[],
): {
  resolve(): RendererRequestRoute | null;
  clear(): void;
} {
  let route: RendererRequestRoute | null = null;
  return {
    resolve() {
      // Cache null results as well; otherwise a later empty-discovery gap could
      // resurrect a request manager that belonged to the previous host.
      const policy = readPolicy();
      const discoveredTargets =
        isDraftPrewarmPolicyReady(policy) && declaresRequestTarget(policy)
          ? []
          : discoverTargets();
      route = resolveRendererRequestRoute(policy, discoveredTargets, route);
      return route;
    },
    clear() {
      route = null;
    },
  };
}

export async function waitForRendererDraftPrewarmPolicy(
  target: RendererDraftPrewarmPolicyTarget,
): Promise<RendererDraftPrewarmPolicy> {
  const deadline = Date.now() + POLICY_READY_TIMEOUT_MS;
  while (true) {
    const policy = target.__harnessmixDraftPrewarmPolicyV1;
    if (isDraftPrewarmPolicyReady(policy)) return policy;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Renderer draft prewarm policy is unavailable");
    await new Promise<void>((resolve) => {
      target.setTimeout(resolve, Math.min(POLICY_POLL_INTERVAL_MS, remaining));
    });
  }
}

// ---------------------------------------------------------------------------
// Agent → carrier mapping
// ---------------------------------------------------------------------------

const KIRO_CLI_HARNESS_ID = harnessIdSchema.parse("kiro-cli");
const OPENCLAW_HARNESS_ID = harnessIdSchema.parse("openclaw");
const HERMES_HARNESS_ID = harnessIdSchema.parse("hermes");

function transportModelIdForAgent(agent: RendererAgent): string | null {
  if (agent === "pi") return PI_TRANSPORT_MODEL_ID;
  if (agent === "claude-code") return CLAUDE_CODE_TRANSPORT_MODEL_ID;
  if (agent === "deepseek-harness") return DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID;
  if (agent === "opencode") return OPENCODE_TRANSPORT_MODEL_ID;
  if (agent === "grok") return GROK_TRANSPORT_MODEL_ID;
  if (agent === "omp") return OMP_TRANSPORT_MODEL_ID;
  if (agent === "antigravity") return ANTIGRAVITY_TRANSPORT_MODEL_ID;
  if (agent === "kiro-cli") return encodeHarnessPluginRoute({ harnessId: KIRO_CLI_HARNESS_ID });
  if (agent === "openclaw") return encodeHarnessPluginRoute({ harnessId: OPENCLAW_HARNESS_ID });
  if (agent === "hermes") return encodeHarnessPluginRoute({ harnessId: HERMES_HARNESS_ID });
  if (agent === "qoder") return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("qoder") });
  if (agent === "codebuddy") return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("codebuddy") });
  if (agent === "zcode") return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("zcode") });
  if (agent === "trae") return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("trae") });
  if (agent === "cursor-cli") return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("cursor-cli") });
  if (agent === "cline") return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("cline") });
  if (agent === 'codex-harness') return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse(agent) });
  return null;
}

function pluginRouteCarrier(
  harnessId: Parameters<typeof encodeHarnessPluginRoute>[0]["harnessId"],
  model: HarnessModelRef | undefined,
  thinkingOptionId: HarnessThinkingOptionId | undefined,
  permissionModeId: HarnessPermissionModeId | undefined,
): string {
  return encodeHarnessPluginRoute({
    harnessId,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(permissionModeId ? { permissionModeId } : {}),
  });
}

export function modelSelectionForAgent(
  officialSelection: ModelPowerSelection | null,
  reasoningEffort: unknown,
  agent: RendererAgent,
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
): ModelPowerSelection | null {
  let transportModelId: string | null;
  switch (agent) {
    case "pi":
      transportModelId = piTransportModelId(model, thinkingOptionId);
      break;
    case "claude-code":
      transportModelId = claudeTransportModelId(model, permissionModeId, thinkingOptionId);
      break;
    case "deepseek-harness":
      transportModelId = deepSeekHarnessTransportModelId(model, permissionModeId);
      break;
    case "opencode":
      transportModelId = openCodeTransportModelId(model, permissionModeId, thinkingOptionId);
      break;
    case "grok":
      transportModelId = grokTransportModelId(model, permissionModeId, thinkingOptionId);
      break;
    case "omp":
      transportModelId = ompTransportModelId(model, thinkingOptionId, permissionModeId);
      break;
    case "antigravity":
      transportModelId = antigravityTransportModelId(model, permissionModeId, thinkingOptionId);
      break;
    case "kiro-cli":
      transportModelId = pluginRouteCarrier(
        KIRO_CLI_HARNESS_ID,
        model,
        thinkingOptionId,
        permissionModeId,
      );
      break;
    case "openclaw":
    case "hermes":
    case "qoder":
    case "codebuddy":
    case "zcode":
    case "trae":
    case "cursor-cli":
    case "cline":
    case "codex-harness":
      transportModelId = pluginRouteCarrier(
        harnessIdSchema.parse(agent),
        model,
        thinkingOptionId,
        permissionModeId,
      );
      break;
    default:
      transportModelId = transportModelIdForAgent(agent);
      break;
  }
  return transportModelId ? { model: transportModelId, reasoningEffort } : officialSelection;
}

// ---------------------------------------------------------------------------
// Current-adapter installation
// ---------------------------------------------------------------------------

export function installCurrentRendererAdapter(): {
  status: RendererAdapterStatus;
  modelControl: RendererModelClient | null;
  applyAgent(
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
    composer?: Element,
  ): boolean;
  dispose(): void;
} {
  let disposed = false;
  let modelUpdates = 0;
  const adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    modelUpdates: 0,
    hook: null,
  };
  const publishStatus = (
    state: RendererAdapterState,
    reason: RendererAdapterStatus["reason"],
    hook: RendererAdapterStatus["hook"],
  ): void => {
    adapterStatus.modelUpdates = modelUpdates;
    transitionRendererAdapterStatus(adapterStatus, { state, reason, hook }, () => {
      window.dispatchEvent(new CustomEvent("harnessmix:renderer-adapter-status"));
    });
  };

  const usageRelay = createThreadUsageSubscriptionRelay();
  const routeResolver = createRendererRequestRouteResolver(
    () => window.__harnessmixDraftPrewarmPolicyV1,
    () => findActivePrewarmTargets(document),
  );
  const clientCache = new WeakMap<
    PrewarmTarget,
    {
      client: RendererModelClient;
      policy: RendererDraftPrewarmPolicy | null;
      requestClient: PrewarmTarget["requestClient"];
    }
  >();
  const steeringTeardowns = new Set<() => void>();
  const clientForTargets = (
    targets: readonly PrewarmTarget[],
    policy: RendererDraftPrewarmPolicy | null = null,
  ): RendererModelClient | null => {
    const target = targets[0];
    if (targets.length !== 1 || !target) return null;
    const cached = clientCache.get(target);
    if (cached?.policy === policy && cached.requestClient === target.requestClient)
      return cached.client;
    const client = createRendererModelClient([target]);
    if (client) {
      // A fresh connection must not inherit observations that a method is
      // unsupported. Steering hangs off the manager itself, so hook it only on
      // the first client for a given target.
      if (!cached) {
        const cleanup = installRendererExternalSteering(target);
        if (cleanup) steeringTeardowns.add(cleanup);
      }
      clientCache.set(target, { client, policy, requestClient: target.requestClient });
    }
    return client;
  };
  let routePolicy: RendererDraftPrewarmPolicy | null = null;
  let routeClient: RendererModelClient | null = null;
  const syncActiveRoute = (route: RendererRequestRoute | null): RendererModelClient | null => {
    const policy = route?.policy ?? null;
    const client = route ? clientForTargets(route.targets, route.policy) : null;
    if (routePolicy === policy && routeClient === client) return client;
    routePolicy = policy;
    routeClient = client;
    return client;
  };
  const resolveRoute = (): RendererRequestRoute | null => {
    const route = routeResolver.resolve();
    syncActiveRoute(route);
    return route;
  };
  const requireModelClient = (): RendererModelClient => {
    const client = resolveRoute() ? routeClient : null;
    if (!client) throw new Error("Renderer Model request manager is unavailable");
    usageRelay.connect(client);
    return client;
  };
  const modelControl: RendererModelClient = Object.freeze({
    currentHostId: () => resolveRoute()?.policy.hostId ?? null,
    clientForHost(hostId: string): RendererModelClient | null {
      const route = resolveRoute();
      if (route?.policy.hostId === hostId) return clientForTargets(route.targets, route.policy);
      const policy = window.__harnessmixDraftPrewarmPolicyV1;
      if (isDraftPrewarmPolicyReady(policy) && declaresRequestTarget(policy)) return null;
      const targets = rendererRequestTargetsForHost(findActivePrewarmTargets(document), hostId);
      return clientForTargets(targets ?? []);
    },
    listHarnessPlugins: async () => {
      const client = requireModelClient();
      if (!client.listHarnessPlugins) throw new Error("Harness plugin directory is unavailable");
      return client.listHarnessPlugins();
    },
    forkThread: (input: ExternalThreadForkParams) => requireModelClient().forkThread(input),
    switchHarness: (input: ThreadHarnessSwitchParams) => requireModelClient().switchHarness(input),
    inspectHarness: (input: HarnessInspectParams) => requireModelClient().inspectHarness(input),
    inspectThread: (input: ThreadInspectionParams) => requireModelClient().inspectThread(input),
    inspectHarnessCommands: (input: HarnessCommandsInspectParams) =>
      requireModelClient().inspectHarnessCommands(input),
    inspectThreadCommands: (input: ThreadCommandsInspectParams) =>
      requireModelClient().inspectThreadCommands(input),
    executeThreadCommand: (input: ThreadCommandExecuteParams) =>
      requireModelClient().executeThreadCommand(input),
    inspectThreadUsage: (input: ThreadUsageInspectionParams) =>
      requireModelClient().inspectThreadUsage(input),
    subscribeThreadUsage: (listener: (update: ThreadUsageInspection) => void) =>
      usageRelay.subscribe(listener),
    listThreadOwnership: (input: ThreadOwnershipListParams) =>
      requireModelClient().listThreadOwnership(input),
    selectThreadModel: (input: ThreadModelSelectParams) =>
      requireModelClient().selectThreadModel(input),
    selectThreadThinking: (input: ThreadThinkingSelectParams) =>
      requireModelClient().selectThreadThinking(input),
    selectThreadPermissionMode: (input: ThreadPermissionModeSelectParams) =>
      requireModelClient().selectThreadPermissionMode(input),
    checkUpdate: () => requireModelClient().checkUpdate(),
    startUpdate: () => requireModelClient().startUpdate(),
    readUpdateStatus: () => requireModelClient().readUpdateStatus(),
    inspectCodexAccountUsage: (
      input: Parameters<NonNullable<RendererModelClient["inspectCodexAccountUsage"]>>[0],
    ) => {
      const client = requireModelClient();
      if (!client.inspectCodexAccountUsage) throw new Error("Codex Account Usage is unavailable");
      return client.inspectCodexAccountUsage(input);
    },
    consumeCodexAccountResetCredit: (
      input: Parameters<NonNullable<RendererModelClient["consumeCodexAccountResetCredit"]>>[0],
    ) => {
      const client = requireModelClient();
      if (!client.consumeCodexAccountResetCredit) {
        throw new Error("Codex Account reset-credit consume is unavailable");
      }
      return client.consumeCodexAccountResetCredit(input);
    },
    listHarnessAccounts: () => {
      const client = requireModelClient();
      if (!client.listHarnessAccounts) throw new Error("Harness account inspection is unavailable");
      return client.listHarnessAccounts();
    },
    listCodexAccounts: () => requireModelClient().listCodexAccounts(),
    refreshCodexAccounts: () => {
      const client = requireModelClient();
      return client.refreshCodexAccounts?.() ?? client.listCodexAccounts();
    },
    createCodexAccount: (input: Parameters<RendererModelClient["createCodexAccount"]>[0]) =>
      requireModelClient().createCodexAccount(input),
    deleteCodexAccount: (input: Parameters<RendererModelClient["deleteCodexAccount"]>[0]) =>
      requireModelClient().deleteCodexAccount(input),
    activateCodexAccount: (input: Parameters<RendererModelClient["activateCodexAccount"]>[0]) =>
      requireModelClient().activateCodexAccount(input),
    startCodexAccountLogin: (input: Parameters<RendererModelClient["startCodexAccountLogin"]>[0]) =>
      requireModelClient().startCodexAccountLogin(input),
    cancelCodexAccountLogin: (
      input: Parameters<RendererModelClient["cancelCodexAccountLogin"]>[0],
    ) => requireModelClient().cancelCodexAccountLogin(input),
    subscribeCodexAccountLogin: (
      listener: Parameters<RendererModelClient["subscribeCodexAccountLogin"]>[0],
    ) => requireModelClient().subscribeCodexAccountLogin(listener),
  });
  const forkControl = installRendererForkControl({
    getClient: () => modelControl,
    reportError: (error) => {
      console.error(
        "harnessmix external Thread Fork failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    },
  });

  // Routing-policy capture: hold the composer's draft carrier on the policy
  // object exposed by the Desktop integration, re-capturing whenever Desktop
  // swaps its request manager out from under us.
  let routingPolicy: RendererDraftPrewarmPolicy | null = null;
  let captureTimer: number | null = null;
  let recaptureObserver: MutationObserver | null = null;
  let hasCapturedRoutingPolicy = false;
  let appliedPolicy: RendererDraftPrewarmPolicy | null = null;
  let appliedCarrier: string | null = null;
  let desiredCarrier: string | null = null;
  const stopCaptureTimer = (): void => {
    if (captureTimer === null) return;
    window.clearInterval(captureTimer);
    captureTimer = null;
  };
  const stopRecaptureObserver = (): void => {
    recaptureObserver?.disconnect();
    recaptureObserver = null;
  };
  const captureRoutingPolicy = (): boolean => {
    const route = resolveRoute();
    if (!route) return false;
    routingPolicy = route.policy;
    stopRecaptureObserver();
    if (appliedPolicy !== routingPolicy || appliedCarrier !== desiredCarrier) {
      try {
        routingPolicy.select(desiredCarrier);
      } catch {
        publishStatus("installing", "draft-routing-policy-unavailable", null);
        return false;
      }
      appliedPolicy = routingPolicy;
      appliedCarrier = desiredCarrier;
    }
    hasCapturedRoutingPolicy = true;
    stopCaptureTimer();
    publishStatus("ready", "ready", "request-bridge");
    return true;
  };
  const startCaptureTimer = (): void => {
    stopCaptureTimer();
    captureTimer = window.setInterval(captureRoutingPolicy, POLICY_POLL_INTERVAL_MS);
  };
  const startRecaptureObserver = (): void => {
    stopRecaptureObserver();
    recaptureObserver = new MutationObserver(() => {
      captureRoutingPolicy();
    });
    recaptureObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "data-codex-composer-root"],
      characterData: true,
      childList: true,
      subtree: true,
    });
  };
  if (!captureRoutingPolicy()) {
    publishStatus("installing", "draft-routing-policy-unavailable", null);
    const policy = window.__harnessmixDraftPrewarmPolicyV1;
    if (!isDraftPrewarmPolicyReady(policy) || !declaresRequestTarget(policy)) {
      startCaptureTimer();
    }
  }
  const handleRoutingPolicyChange = (): void => {
    stopRecaptureObserver();
    if (captureRoutingPolicy()) return;
    const policy = window.__harnessmixDraftPrewarmPolicyV1;
    if (isDraftPrewarmPolicyReady(policy) && declaresRequestTarget(policy)) {
      stopCaptureTimer();
    }
    if (!hasCapturedRoutingPolicy) return;
    publishStatus("installing", "draft-routing-policy-unavailable", null);
    if (isDraftPrewarmPolicyReady(policy) && !declaresRequestTarget(policy)) {
      startRecaptureObserver();
    }
  };
  window.addEventListener("harnessmix:draft-prewarm-policy-changed", handleRoutingPolicyChange);

  const applyAgent = (
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): boolean => {
    if (disposed) return false;
    const selection = modelSelectionForAgent(
      null,
      null,
      agent,
      model,
      thinkingOptionId,
      permissionModeId,
    );
    const carrier = selection?.model;
    if (carrier !== null && carrier !== undefined && typeof carrier !== "string") return false;
    desiredCarrier = carrier ?? null;
    const route = resolveRoute();
    if (!route) return false;
    routingPolicy = route.policy;
    try {
      if (route.policy.select(desiredCarrier)) {
        modelUpdates += 1;
        adapterStatus.modelUpdates = modelUpdates;
      }
      appliedPolicy = route.policy;
      appliedCarrier = desiredCarrier;
    } catch {
      publishStatus("installing", "draft-routing-policy-unavailable", null);
      return false;
    }
    return true;
  };
  return {
    status: adapterStatus,
    modelControl,
    applyAgent,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopCaptureTimer();
      stopRecaptureObserver();
      window.removeEventListener(
        "harnessmix:draft-prewarm-policy-changed",
        handleRoutingPolicyChange,
      );
      const activeRoutingPolicy = routingPolicy;
      routingPolicy = null;
      routeResolver.clear();
      const cleanups = [
        () => activeRoutingPolicy?.select(null),
        () => syncActiveRoute(null),
        () => forkControl.dispose(),
        ...steeringTeardowns,
        () => usageRelay.dispose(),
      ];
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // Release every remaining owned resource even if one teardown fails.
        }
      }
    },
  };
}
