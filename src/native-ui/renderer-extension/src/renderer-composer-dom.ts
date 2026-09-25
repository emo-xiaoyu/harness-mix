import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import type {
  AccountCreditsSnapshot,
  CodexAccountSummary,
  HarnessCommandDescriptor,
  ThreadUsageSnapshot,
} from "@harnessmix/shared-contracts";
import {
  CONTROL_ATTRIBUTE,
  mountRendererAgentPicker,
  renderRendererAgentPicker,
  type RendererAgentPickerControl,
} from "./renderer-agent-picker.js";
import {
  mountRendererModelPicker,
  renderRendererModelPicker,
  syncRendererModelTriggerClass,
  thinkingOptionsForModel,
  type RendererModelControlView,
  type RendererModelPickerControl,
} from "./renderer-model-picker.js";
import {
  isPermissionModeControlReady,
  mountRendererPermissionModePicker,
  renderRendererPermissionModePicker,
  syncRendererPermissionModeTriggerClass,
  type RendererPermissionModeControlView,
  type RendererPermissionModePickerControl,
} from "./renderer-permission-mode-picker.js";
import {
  mountRendererCreditsControl,
  renderRendererCreditsControl,
  type RendererCreditsControl,
} from "./renderer-credits-control.js";
import {
  mountRendererUsageControl,
  renderRendererUsageControl,
  type RendererUsageControl,
} from "./renderer-usage-control.js";
import type { RendererSettingsLocale } from "./settings/localization.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";
import {
  mountRendererHarnessCommandControl,
  type RendererHarnessCommandControl,
} from "./renderer-harness-command-control.js";
import {
  mountRendererHarnessHandoff,
  type RendererHarnessHandoffControl,
  type RendererHarnessHandoffRequest,
} from "./renderer-harness-handoff.js";

export { CONTROL_ATTRIBUTE };
export type ExternalModelControlView = RendererModelControlView;
export type ExternalPermissionModeControlView = RendererPermissionModeControlView;
export type PiModelControlView = ExternalModelControlView;
export const CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]";
export const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

/** How a native control looked before we hid it, so it can be restored. */
interface HiddenControlSnapshot {
  element: HTMLElement;
  hidden: HTMLElement["hidden"];
  ariaHidden: string | null;
}

type NativeModelControlState = HiddenControlSnapshot;
type NativePermissionModeControlState = HiddenControlSnapshot;

export interface RendererComposerContractInspection {
  composerCount: number;
  visibleComposerCount: number;
  activeComposerCount: number;
  modelCandidateCount: number;
  verifiedModelCandidateCount: number;
  permissionCandidateCount: number;
  verifiedPermissionCandidateCount: number;
  contextUsageCandidateCount: number;
  verifiedContextUsageCandidateCount: number;
  sendButtonCount: number;
  trailingActionOwnerCount: number;
}

export interface ComposerAgentControl {
  composer: Element;
  root: HTMLElement;
  picker: RendererAgentPickerControl;
  modelPicker: RendererModelPickerControl;
  permissionModePicker: RendererPermissionModePickerControl;
  nativeModelControl: NativeModelControlState | null;
  nativePermissionModeControl: NativePermissionModeControlState | null;
  nativeContextUsageControl?: HiddenControlSnapshot | null;
  nativePermissionModeControlVerified: boolean;
  credits: RendererCreditsControl;
  usage: RendererUsageControl | null;
  composerId: string;
  harnessCommands: RendererHarnessCommandControl;
  harnessHandoff: RendererHarnessHandoffControl;
  sendButton: HTMLButtonElement;
  sendDisabledBeforeSwitch: boolean | null;
}

export function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lowercased "type aria-label title data-testid" fingerprint of a control. */
function describeControl(element: Element): string {
  const typed = element as HTMLButtonElement;
  const attribute = (name: string): string | null =>
    typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
  return [typed.type, attribute("aria-label"), attribute("title"), attribute("data-testid")]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isRendererOwnedControl(element: Element): boolean {
  return (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-harnessmix-model-control") ||
    element.hasAttribute("data-harnessmix-permission-mode-control") ||
    element.hasAttribute("data-harnessmix-usage-control") ||
    element.hasAttribute("data-harnessmix-credits-control") ||
    element.hasAttribute("data-harnessmix-harness-command-control")
  );
}

export function isComposerSubmitButton(button: HTMLButtonElement): boolean {
  if (isComposerStopButton(button)) return false;
  if (button.type === "submit") return true;
  return /(^|\s)(send|submit|发送|提交)(\s|$)/u.test(describeControl(button));
}

export function isComposerStopButton(button: HTMLButtonElement): boolean {
  return /^(停止|stop)$/iu.test((button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent ?? "").trim());
}

const VOICE_CONTROL_PATTERN =
  /(dictat|microphone|speech(?:[-_\s]?to[-_\s]?text)?|voice[-_\s]?input|(^|\s)voice(\s|$)|composer[-_](?:speech|dictat|mic)|语音|听写|麦克风|pause|暂停|stop recording|stop dictation|停止录音|停止听写|(^|\s)stop(\s|$))/iu;
const CANCEL_CONTROL_PATTERN = /(cancel|discard|close|dismiss|取消|关闭|丢弃)/iu;
const TRAILING_ACTION_WALK_DEPTH = 3;

function isCancelControl(element: Element): boolean {
  if (isRendererOwnedControl(element)) return false;
  return CANCEL_CONTROL_PATTERN.test(describeControl(element));
}

export function isComposerVoiceButton(element: Element): boolean {
  if (isRendererOwnedControl(element) || isCancelControl(element)) return false;
  const description = describeControl(element);
  if (/(^|\s)(send|submit|发送|提交)(\s|$)/u.test(description)) return false;
  return VOICE_CONTROL_PATTERN.test(description);
}

function isTrailingButton(element: Element): boolean {
  return isComposerVoiceButton(element) || isComposerSubmitButton(element as HTMLButtonElement);
}

function isTrailingClusterNode(element: Element): boolean {
  if (isCancelControl(element)) return false;
  if (isTrailingButton(element)) return true;
  if (typeof element.querySelectorAll !== "function") return false;
  const buttons = [...element.querySelectorAll("button")];
  return buttons.length > 0 && buttons.every((button) => isTrailingButton(button));
}

export function sendButtonWithin(root: Element): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      isComposerSubmitButton(button),
    ) ?? null
  );
}

/** Leftmost sibling before `boundary` that belongs to the trailing cluster. */
function leadingTrailingSiblingIn(container: Element, boundary: Element): HTMLElement | null {
  for (const child of container.children) {
    if (child === boundary) break;
    if (typeof (child as HTMLElement).hasAttribute !== "function") continue;
    const element = child as HTMLElement;
    if (isRendererOwnedControl(element) || isCancelControl(element)) continue;
    if (isTrailingClusterNode(element)) return element;
  }
  return null;
}

export function trailingActionAnchor(sendButton: HTMLButtonElement): HTMLElement {
  let container: HTMLElement | null = sendButton.parentElement;
  let boundary: HTMLElement = sendButton;
  for (let depth = 0; container && depth < TRAILING_ACTION_WALK_DEPTH; depth += 1) {
    if (typeof container.matches === "function" && container.matches(CODEX_COMPOSER_SELECTOR)) {
      break;
    }
    const candidate = leadingTrailingSiblingIn(container, boundary);
    if (candidate) return candidate;
    boundary = container;
    container = container.parentElement;
  }
  return sendButton;
}

export function editorForElement(element: Element): Element | null {
  return element.matches(EDITOR_SELECTOR) ? element : element.closest(EDITOR_SELECTOR);
}

export function isComposerInputIntent(event: KeyboardEvent): boolean {
  if (event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") return true;
  if (event.key === "Process") return true;
  if ((event.ctrlKey || event.metaKey) && ["v", "x"].includes(event.key.toLowerCase())) return true;
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isComposerSubmissionKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function composerForEditor(editor: Element): Element | null {
  return editor.closest(CODEX_COMPOSER_SELECTOR);
}

export function composerForElement(element: Element): Element | null {
  return element.closest(CODEX_COMPOSER_SELECTOR);
}

// ---------------------------------------------------------------------------
// React fiber inspection: the Desktop composer's native controls are the only
// stable signal for "this button is the real model/permission trigger".
// ---------------------------------------------------------------------------

interface FiberLike {
  return?: unknown;
  memoizedProps?: unknown;
}

function reactFiberOf(element: Element): FiberLike | null {
  const propertyName = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  if (!propertyName) return null;
  return (Object.getOwnPropertyDescriptor(element, propertyName)?.value as FiberLike) ?? null;
}

function parentFiberOf(fiber: FiberLike | null): FiberLike | null {
  const parent = fiber?.return;
  return typeof parent === "object" || typeof parent === "function"
    ? (parent as FiberLike)
    : null;
}

const FIBER_WALK_LIMIT = 60;

export function isNativeModelControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-harnessmix-model-control") ||
    !element.matches('button[aria-haspopup="menu"]')
  ) {
    return false;
  }
  if (
    element.getAttribute("data-codex-intelligence-trigger") === "true" &&
    element.getAttribute("data-composer-navigation-target") === "reasoning"
  ) {
    return true;
  }
  let fiber = reactFiberOf(element);
  for (let depth = 0; fiber && depth < FIBER_WALK_LIMIT; depth += 1) {
    const props = fiber.memoizedProps;
    if (
      isRecord(props) &&
      typeof props.onSelectModel === "function" &&
      typeof props.onSelectReasoningEffort === "function" &&
      "reasoningEffort" in props &&
      isRecord(props.fallbackPowerSelection)
    ) {
      return true;
    }
    fiber = parentFiberOf(fiber);
  }
  return false;
}

export function isNativePermissionModeControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-harnessmix-permission-mode-control") ||
    !element.matches('button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]')
  ) {
    return false;
  }
  let ownsTrigger = false;
  let ownsComposerPermissionState = false;
  let fiber = reactFiberOf(element);
  for (let depth = 0; fiber && depth < FIBER_WALK_LIMIT; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      if (
        props["data-composer-navigation-target"] === "permissions" &&
        props["aria-haspopup"] === "menu"
      ) {
        ownsTrigger = true;
      }
      if (
        typeof props.showPermissionsModeDropdown === "boolean" &&
        typeof props.permissionsHostId === "string" &&
        "permissionsCwdOverride" in props
      ) {
        ownsComposerPermissionState = true;
      }
    }
    fiber = parentFiberOf(fiber);
  }
  return ownsTrigger && ownsComposerPermissionState;
}

/** The single non-owned permission trigger in this composer, fiber-verified. */
function uniquePermissionTriggerIn(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>(
      'button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]',
    ),
  ].filter((element) => !element.hasAttribute("data-harnessmix-permission-mode-control"));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function verifiedPermissionControlIn(composer: Element): HTMLElement | null {
  const candidate = uniquePermissionTriggerIn(composer);
  return candidate && isNativePermissionModeControlCandidate(candidate) ? candidate : null;
}

function verifiedModelControlIn(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'),
  ].filter((element) => isNativeModelControlCandidate(element));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function isNativeContextUsageControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute("data-harnessmix-usage-control") ||
    element.hasAttribute("data-harnessmix-credits-control")
  ) {
    return false;
  }
  // The Composer footer renders Context Usage as this exact accessible radial
  // gauge; the DOM shape outlives localized labels and hashed CSS classes.
  return (
    element.matches('span[role="img"][aria-label]') &&
    element.querySelectorAll("svg > circle").length === 2
  );
}

export function nativeContextUsageControlForComposer(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>('span[role="img"][aria-label]'),
  ].filter(isNativeContextUsageControlCandidate);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function visibleForContract(element: Element): boolean {
  const typed = element as HTMLElement;
  const bounds = typed.getBoundingClientRect?.();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  if (typed.hidden || typed.getAttribute?.("aria-hidden") === "true") return false;
  const view = element.ownerDocument?.defaultView;
  const style = view?.getComputedStyle?.(typed);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

export function inspectRendererComposerContract(
  root: ParentNode = document,
): RendererComposerContractInspection {
  const composers = [...root.querySelectorAll<Element>(CODEX_COMPOSER_SELECTOR)];
  const result: RendererComposerContractInspection = {
    composerCount: composers.length,
    visibleComposerCount: 0,
    activeComposerCount: 0,
    modelCandidateCount: 0,
    verifiedModelCandidateCount: 0,
    permissionCandidateCount: 0,
    verifiedPermissionCandidateCount: 0,
    contextUsageCandidateCount: 0,
    verifiedContextUsageCandidateCount: 0,
    sendButtonCount: 0,
    trailingActionOwnerCount: 0,
  };
  for (const composer of composers) {
    if (visibleForContract(composer)) result.visibleComposerCount += 1;
    const editors = [...composer.querySelectorAll<HTMLElement>(EDITOR_SELECTOR)].filter(
      visibleForContract,
    );
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (editors.length === 1 && sendButton !== null) result.activeComposerCount += 1;
    if (sendButton) {
      result.sendButtonCount += 1;
      if (trailingActionAnchor(sendButton).parentElement !== null) {
        result.trailingActionOwnerCount += 1;
      }
    }
    const modelCandidates = [
      ...composer.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'),
    ].filter((element) => !isRendererOwnedControl(element));
    result.modelCandidateCount += modelCandidates.length;
    result.verifiedModelCandidateCount += modelCandidates.filter(
      isNativeModelControlCandidate,
    ).length;
    const permissionCandidates = [
      ...composer.querySelectorAll<HTMLElement>(
        'button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]',
      ),
    ].filter((element) => !element.hasAttribute("data-harnessmix-permission-mode-control"));
    result.permissionCandidateCount += permissionCandidates.length;
    result.verifiedPermissionCandidateCount += permissionCandidates.filter(
      isNativePermissionModeControlCandidate,
    ).length;
    const contextCandidates = [
      ...composer.querySelectorAll<HTMLElement>('span[role="img"][aria-label]'),
    ].filter((element) => !isRendererOwnedControl(element));
    result.contextUsageCandidateCount += contextCandidates.length;
    result.verifiedContextUsageCandidateCount += contextCandidates.filter(
      isNativeContextUsageControlCandidate,
    ).length;
  }
  return result;
}

function snapshotNativeControl(element: HTMLElement | null): HiddenControlSnapshot | null {
  return element
    ? {
        element,
        hidden: element.hidden,
        ariaHidden: element.getAttribute("aria-hidden"),
      }
    : null;
}

function restoreNativeControl(snapshot: HiddenControlSnapshot | null | undefined): void {
  if (!snapshot) return;
  snapshot.element.hidden = snapshot.hidden;
  if (snapshot.ariaHidden === null) snapshot.element.removeAttribute("aria-hidden");
  else snapshot.element.setAttribute("aria-hidden", snapshot.ariaHidden);
}

function retargetContextUsageControl(control: ComposerAgentControl): void {
  const candidate = nativeContextUsageControlForComposer(control.composer);
  if (candidate === control.nativeContextUsageControl?.element) return;
  restoreNativeControl(control.nativeContextUsageControl);
  control.nativeContextUsageControl = snapshotNativeControl(candidate);
}

function retargetModelControl(control: ComposerAgentControl): void {
  const candidate = verifiedModelControlIn(control.composer);
  if (!candidate) return;
  if (candidate !== control.nativeModelControl?.element) {
    restoreNativeControl(control.nativeModelControl);
    control.nativeModelControl = snapshotNativeControl(candidate);
    syncRendererModelTriggerClass(control.modelPicker);
  }
}

function usagePlacementAnchor(control: ComposerAgentControl): HTMLElement | null {
  const context = control.nativeContextUsageControl?.element;
  // The radial gauge sits inside a line-height wrapper span in
  // FooterInlineControls. Usage goes next to that wrapper so its 28px control
  // lines up with the footer flex row rather than the 18px line box.
  const contextWrapper = context?.parentElement;
  if (contextWrapper?.parentElement) return contextWrapper;
  // External Harnesses can publish Usage before the native Context control
  // exists. The renderer-owned Model control is a dependable footer anchor
  // then, so early Usage is visible instead of waiting for a later
  // Context sighting.
  const modelRoot = control.modelPicker?.root;
  return modelRoot?.parentElement ? modelRoot : null;
}

/**
 * Credits hangs off the renderer-owned permission-mode slot. It deliberately
 * ignores the native context indicator: Credits describes account limits,
 * not the current Thread's context window.
 */
export function creditsPlacementAnchor(control: ComposerAgentControl): HTMLElement | null {
  const root = control.permissionModePicker?.root;
  return root?.parentElement ? root : null;
}

function repositionTrailingCluster(control: ComposerAgentControl): void {
  const sendButton = control.sendButton;
  const modelRoot = control.modelPicker?.root;
  const agentRoot = control.root ?? control.picker?.root;
  if (!sendButton || !modelRoot || !agentRoot) return;
  const anchor = trailingActionAnchor(sendButton);
  const parent = anchor.parentElement;
  if (!parent || typeof parent.insertBefore !== "function") return;
  if (
    modelRoot.parentElement === parent &&
    agentRoot.parentElement === parent &&
    modelRoot.nextElementSibling === agentRoot &&
    agentRoot.nextElementSibling === anchor
  ) {
    return;
  }
  parent.insertBefore(modelRoot, anchor);
  parent.insertBefore(agentRoot, anchor);
}

function repositionUsage(control: ComposerAgentControl): void {
  const anchor = usagePlacementAnchor(control);
  if (!anchor || !control.usage) {
    if (control.usage?.anchor) control.usage.root.remove();
    if (control.usage) control.usage.anchor = null;
    return;
  }
  const previousParent = control.usage.root.parentElement;
  const previousSibling = control.usage.root.nextElementSibling;
  control.usage.place(anchor);
  const moved =
    previousParent !== control.usage.root.parentElement ||
    previousSibling !== control.usage.root.nextElementSibling;
  if (moved) control.harnessCommands?.placeBefore(control.usage.root);
}

// Intentionally separate from `repositionUsage`: Credits must not move when
// Usage's anchor is still resolving (or absent), so its position stays stable.
function repositionCredits(control: ComposerAgentControl): void {
  const anchor = creditsPlacementAnchor(control);
  if (!anchor) {
    if (control.credits.anchor) control.credits.root.remove();
    control.credits.anchor = null;
    return;
  }
  control.credits.place(anchor);
}

function retargetPermissionModeControl(control: ComposerAgentControl): void {
  const semanticCandidate = uniquePermissionTriggerIn(control.composer);
  if (semanticCandidate !== control.nativePermissionModeControl?.element) {
    restoreNativeControl(control.nativePermissionModeControl);
    control.nativePermissionModeControl = snapshotNativeControl(semanticCandidate);
  }
  const verifiedCandidate = verifiedPermissionControlIn(control.composer);
  control.nativePermissionModeControlVerified =
    verifiedCandidate === semanticCandidate && verifiedCandidate !== null;
  if (!verifiedCandidate) return;
  syncRendererPermissionModeTriggerClass(control.permissionModePicker);
  const parent = verifiedCandidate.parentElement;
  if (
    parent &&
    (control.permissionModePicker.root.parentElement !== parent ||
      control.permissionModePicker.root.nextElementSibling !== verifiedCandidate)
  ) {
    parent.insertBefore(control.permissionModePicker.root, verifiedCandidate);
  }
}

function setNativeControlHidden(
  snapshot: HiddenControlSnapshot | null | undefined,
  hidden: boolean,
): void {
  if (!snapshot) return;
  if (!hidden) {
    restoreNativeControl(snapshot);
    return;
  }
  if (snapshot.element.hidden && snapshot.element.getAttribute("aria-hidden") === "true") return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (
    active &&
    typeof (active as HTMLElement).blur === "function" &&
    snapshot.element.contains(active)
  ) {
    (active as HTMLElement).blur();
  }
  if (snapshot.element.getAttribute("aria-expanded") === "true") snapshot.element.click();
  snapshot.element.hidden = true;
  snapshot.element.setAttribute("aria-hidden", "true");
}

export function reconcileComposerNativeControls(
  control: ComposerAgentControl,
  hideModel: boolean,
  hidePermissionMode: boolean,
): void {
  retargetContextUsageControl(control);
  retargetModelControl(control);
  // Place the permission-mode picker before Credits anchors against it, so
  // Credits never latches onto a stale mount-time position within this pass.
  retargetPermissionModeControl(control);
  repositionTrailingCluster(control);
  repositionUsage(control);
  repositionCredits(control);
  setNativeControlHidden(control.nativeModelControl, hideModel);
  // Context usage is shared: external Usage data is projected into the same
  // native indicator, so it stays visible while the Model control is swapped.
  setNativeControlHidden(control.nativeContextUsageControl, false);
  setNativeControlHidden(control.nativePermissionModeControl, hidePermissionMode);
}

export function mountComposerAgentControl(
  composer: Element,
  composerId: string,
  sendButton: HTMLButtonElement,
  enabledAgents: readonly RendererAgent[],
  onSelect: (agent: RendererAgent) => void,
  onDownload: (agent: ExternalRendererAgent) => void,
  onSelectCodexAccount: (accountId: string) => Promise<void> | void,
  onOpenProviderPicker: () => void,
  onSelectModel: (modelId: string) => void,
  onSelectThinking: (thinkingOptionId: string) => void,
  onSelectPermissionMode: (permissionModeId: string) => void,
  onSelectCommand: (command: HarnessCommandDescriptor) => void,
  onConfirmHandoff: (request: RendererHarnessHandoffRequest) => void,
): ComposerAgentControl {
  const nativeModelControl = snapshotNativeControl(verifiedModelControlIn(composer));
  const nativeContextUsageControl = snapshotNativeControl(
    nativeContextUsageControlForComposer(composer),
  );
  const permissionTrigger = uniquePermissionTriggerIn(composer);
  const nativePermissionModeControl = snapshotNativeControl(permissionTrigger);
  const nativePermissionModeControlVerified =
    permissionTrigger !== null && verifiedPermissionControlIn(composer) === permissionTrigger;
  const picker = mountRendererAgentPicker(
    composerId,
    enabledAgents,
    onSelect,
    onDownload,
    onSelectCodexAccount,
    onOpenProviderPicker,
  );
  const modelPicker = mountRendererModelPicker(composerId, onSelectModel, onSelectThinking);
  const permissionModePicker = mountRendererPermissionModePicker(
    composerId,
    onSelectPermissionMode,
  );
  const credits = mountRendererCreditsControl(composerId);

  const toolbar = sendButton.parentElement;
  const harnessCommands = mountRendererHarnessCommandControl(
    toolbar ?? composer,
    trailingActionAnchor(sendButton),
    onSelectCommand,
  );
  const harnessHandoff = mountRendererHarnessHandoff(composerId, onConfirmHandoff);

  const permissionParent = nativePermissionModeControl?.element.parentElement;
  if (permissionParent && nativePermissionModeControl && nativePermissionModeControlVerified) {
    permissionParent.insertBefore(permissionModePicker.root, nativePermissionModeControl.element);
  } else {
    composer.append(permissionModePicker.root);
  }

  if (!toolbar) composer.append(modelPicker.root, picker.root);
  const control = {
    composer,
    composerId,
    root: picker.root,
    picker,
    modelPicker,
    permissionModePicker,
    nativeModelControl,
    nativePermissionModeControl,
    nativeContextUsageControl,
    nativePermissionModeControlVerified,
    credits,
    usage: null,
    harnessCommands,
    harnessHandoff,
    sendButton,
    sendDisabledBeforeSwitch: null,
  } satisfies ComposerAgentControl;
  repositionTrailingCluster(control);
  repositionUsage(control);
  repositionCredits(control);
  return control;
}

export function renderComposerAgentControl(
  control: ComposerAgentControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  availability: Partial<Record<ExternalRendererAgent, RendererAgentAvailability>> = {},
  modelView: ExternalModelControlView = { status: "idle" },
  permissionModeView: RendererPermissionModeControlView = { status: "idle" },
  usage: ThreadUsageSnapshot | null = null,
  accountCredits: AccountCreditsSnapshot | null = null,
  locale: RendererSettingsLocale = "en",
  codexAccounts: readonly CodexAccountSummary[] = [],
  ownershipError = false,
): void {
  if (control.usage === null) {
    control.usage = mountRendererUsageControl(control.composerId, locale);
  }

  const selectedModel = modelView.selected;
  const selectedCatalogModel = modelView.catalog?.models.find(
    (model) => model.ref.id === selectedModel?.id,
  );
  const availableThinkingOptions =
    modelView.thinkingSelectionSupported === false
      ? []
      : thinkingOptionsForModel(modelView.catalog, selectedModel);
  const thinkingReady =
    availableThinkingOptions.length === 0 ||
    availableThinkingOptions.some(({ id }) => id === modelView.selectedThinkingOptionId);
  const modelReady = selectedModel !== undefined && selectedCatalogModel !== undefined;
  const modelBlocked =
    state.agent !== "codex" && (modelView.status === "selecting" || !modelReady || !thinkingReady);
  const permissionModeBlocked =
    state.agent !== "codex" &&
    (!isPermissionModeControlReady(permissionModeView) ||
      (permissionModeView.status !== "unsupported" &&
        !control.nativePermissionModeControlVerified));
  const submissionBlocked = switching || ownershipError || modelBlocked || permissionModeBlocked;
  if (isComposerStopButton(control.sendButton)) {
    // The native composer reuses its send slot for Stop while a turn runs;
    // renderer gating must never disable the native interrupt.
    control.sendButton.disabled = false;
  } else if (submissionBlocked && control.sendDisabledBeforeSwitch === null) {
    control.sendDisabledBeforeSwitch = control.sendButton.disabled;
    control.sendButton.disabled = true;
  } else if (!submissionBlocked && control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
    control.sendDisabledBeforeSwitch = null;
  }
  const pickerView = renderRendererAgentPicker(
    control.picker,
    state,
    adapterState,
    switching,
    availability,
    codexAccounts,
    ownershipError,
  );
  reconcileComposerNativeControls(
    control,
    pickerView.nativeModelHidden,
    switching || state.agent !== "codex",
  );
  renderRendererModelPicker(control.modelPicker, modelView, state.agent !== "codex");
  const permissionModeVisible =
    state.agent !== "codex" &&
    permissionModeView.status !== "idle" &&
    permissionModeView.status !== "loading" &&
    permissionModeView.status !== "unsupported" &&
    control.nativePermissionModeControlVerified;
  renderRendererPermissionModePicker(
    control.permissionModePicker,
    permissionModeView,
    permissionModeVisible,
    locale,
  );
  const selectedCodexAccount =
    state.agent === "codex" && !ownershipError
      ? codexAccounts.find((account) => account.active)
      : undefined;
  if (control.usage) {
    renderRendererUsageControl(
      control.usage,
      usage,
      locale,
      selectedCodexAccount?.email ?? selectedCodexAccount?.label ?? null,
    );
  }
  control.harnessCommands.setLocale(locale);
  control.harnessCommands.root.hidden = state.agent === "codex";
  control.harnessCommands.root.style.display = state.agent === "codex" ? "none" : "inline-flex";
  if (state.agent === "codex") control.harnessCommands.close();
  renderRendererCreditsControl(control.credits, accountCredits, locale);
}

export function disposeComposerAgentControl(control: ComposerAgentControl): void {
  if (control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
  }
  restoreNativeControl(control.nativeModelControl);
  restoreNativeControl(control.nativeContextUsageControl);
  restoreNativeControl(control.nativePermissionModeControl);
  control.credits.dispose();
  control.usage?.dispose();
  control.usage = null;
  control.harnessCommands.dispose();
  control.harnessHandoff.dispose();
  control.permissionModePicker.dispose();
  control.modelPicker.dispose();
  control.picker.dispose();
}
