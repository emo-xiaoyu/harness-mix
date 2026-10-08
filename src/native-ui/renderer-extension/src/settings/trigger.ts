// Entry point that injects the "Harness Mix" settings launcher into the
// Codex Desktop application header, right before the header's trailing slot.
// Also exports the pure header-slot geometry picker used by contract tests.
import { createRendererSettingsBrandIcon, createRendererSettingsIcon } from "./icons.js";
import {
  DEFAULT_RENDERER_SETTINGS_MESSAGES,
  type RendererSettingsMessages,
} from "./localization.js";

export const SETTINGS_TRIGGER_ATTRIBUTE = "data-harnessmix-settings-trigger";
export const SETTINGS_HEADER_SURFACE_SELECTOR =
  '[data-testid="app-shell-header-context-menu-surface"]';
const SETTINGS_APPLICATION_HEADER_SELECTOR = 'header[data-pip-obstacle="app-shell-header"]';
const SETTINGS_HEADER_SLOT_SELECTOR = ':scope > [data-test-id="header-shell-slot"]';
const SETTINGS_PAGE_HEADER_SELECTOR = '[data-app-shell-page-header]';
const SETTINGS_PAGE_TOOLBAR_SELECTOR = ':scope > [data-app-shell-header-toolbar]';

export interface RendererSettingsTriggerControl {
  root: HTMLElement;
  button: HTMLButtonElement;
  updateButton: HTMLButtonElement;
  setUpdateAvailable(available: boolean): void;
  dispose(): void;
}

export interface RendererSettingsBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface RendererSettingsHeaderSlotCandidate<T> {
  value: T;
  bounds: RendererSettingsBounds;
  visibleButtonCount: number;
  structuralActionGroup?: boolean;
}

export interface RendererSettingsHeaderTriggerControl {
  readonly root: HTMLElement | null;
  refresh(): boolean;
  setUpdateAvailable(available: boolean): void;
  dispose(): void;
}

interface RendererSettingsHeaderInsertionPoint {
  parent: HTMLElement;
  before: ChildNode | null;
  /**
   * Desktop 26.1002+ titlebar: the header is a fixed drag strip whose only
   * in-flow children are zero-width anchor slots plus a full-width absolute
   * title surface. A flex-item trigger lands on top of the thread title, so
   * the trigger is pinned absolutely to the header's right edge instead.
   */
  pinnedRight?: string;
}

export interface RendererSettingsContractInspection {
  headerCount: number;
  visibleHeaderCount: number;
  insertionPointCount: number;
}

function measuredBounds(element: Element): RendererSettingsBounds {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function isVisiblyLaidOut(bounds: RendererSettingsBounds): boolean {
  return bounds.width > 0 && bounds.height > 0;
}

// Picks the header slot that should carry the trigger: candidates must sit in
// the right half of the header, hold more than one button (or be a structural
// action group), and stay within the header box (1px tolerance on the edges).
// The winner hugs the header's right edge most closely.
export function selectRendererSettingsHeaderSlot<T>(
  header: RendererSettingsBounds,
  candidates: readonly RendererSettingsHeaderSlotCandidate<T>[],
): T | null {
  const midpoint = header.left + header.width / 2;
  const maximumWidth = Math.min(320, header.width / 2);
  const eligible = candidates.filter(
    ({ bounds, visibleButtonCount, structuralActionGroup }) =>
      (visibleButtonCount > 1 || structuralActionGroup === true) &&
      bounds.width >= 0 &&
      bounds.height >= 0 &&
      bounds.width <= maximumWidth &&
      bounds.left >= midpoint &&
      bounds.right <= header.right + 1 &&
      bounds.top >= header.top - 1 &&
      bounds.bottom <= header.bottom + 1,
  );
  eligible.sort(
    (left, right) =>
      Math.abs(header.right - left.bounds.right) - Math.abs(header.right - right.bounds.right) ||
      right.visibleButtonCount - left.visibleButtonCount ||
      left.bounds.left - right.bounds.left,
  );
  return eligible[0]?.value ?? null;
}

export function inspectRendererSettingsContract(
  ownerDocument: Document = document,
): RendererSettingsContractInspection {
  const headers = [...ownerDocument.querySelectorAll<HTMLElement>(
    `${SETTINGS_APPLICATION_HEADER_SELECTOR}, ${SETTINGS_PAGE_HEADER_SELECTOR}`,
  )];
  const visibleHeaders = headers.filter((header) => isVisiblyLaidOut(measuredBounds(header)));
  const insertionPointCount = visibleHeaders.filter((header) =>
    [...header.querySelectorAll<HTMLElement>(`${SETTINGS_HEADER_SLOT_SELECTOR}, ${SETTINGS_PAGE_TOOLBAR_SELECTOR}`)].some((slot) =>
      isVisiblyLaidOut(measuredBounds(slot)),
    ),
  ).length;
  return {
    headerCount: headers.length,
    visibleHeaderCount: visibleHeaders.length,
    insertionPointCount,
  };
}

// Prefer the visible page toolbar, retaining the application header end slot
// for older Desktop versions and pages without a chat toolbar.
function findRendererSettingsHeaderInsertionPoint(
  ownerDocument: Document,
): RendererSettingsHeaderInsertionPoint | null {
  // Recent Desktop versions put chat actions in the page toolbar instead of
  // the old application-header slots. Do not depend on button labels or icons.
  for (const header of ownerDocument.querySelectorAll<HTMLElement>(SETTINGS_PAGE_HEADER_SELECTOR)) {
    if (!isVisiblyLaidOut(measuredBounds(header))) continue;
    const toolbar = header.querySelector<HTMLElement>(SETTINGS_PAGE_TOOLBAR_SELECTOR);
    if (!toolbar || !isVisiblyLaidOut(measuredBounds(toolbar))) continue;
    const before = [...toolbar.children].find(child => !child.hasAttribute(SETTINGS_TRIGGER_ATTRIBUTE)) ?? null;
    return { parent: toolbar, before };
  }
  for (const header of ownerDocument.querySelectorAll<HTMLElement>(SETTINGS_APPLICATION_HEADER_SELECTOR)) {
    if (!isVisiblyLaidOut(measuredBounds(header))) continue;
    const titleSurface = header.querySelector<HTMLElement>(SETTINGS_HEADER_SURFACE_SELECTOR);
    if (titleSurface && titleSurface.parentElement === header) {
      return { parent: header, before: findHeaderEndSlot(header), pinnedRight: `${measureHeaderTrailingReserve(header) + 8}px` };
    }
    const visibleSlots = [...header.querySelectorAll<HTMLElement>(SETTINGS_HEADER_SLOT_SELECTOR)]
      .filter((slot) => isVisiblyLaidOut(measuredBounds(slot)));
    const endSlot = visibleSlots.toSorted(
      (left, right) => measuredBounds(right).left - measuredBounds(left).left,
    )[0];
    if (endSlot) return { parent: header, before: endSlot };
  }
  return null;
}

function findHeaderEndSlot(header: HTMLElement): HTMLElement | null {
  const slots = [...header.querySelectorAll<HTMLElement>(SETTINGS_HEADER_SLOT_SELECTOR)];
  return (
    slots.find((slot) => slot.getAttribute?.("data-app-shell-header-slot") === "end") ?? null
  );
}

/**
 * The new titlebar keeps its right edge clear for native chrome via a
 * clip-path overlay child (`inset(0px 47px 0px 6px)`); the second inset
 * component is the reserved band. Falls back to a conservative default.
 */
function measureHeaderTrailingReserve(header: HTMLElement): number {
  const bounds = measuredBounds(header);
  let reserve = 48;
  for (const child of header.children) {
    const style = (child as HTMLElement).getAttribute?.("style") ?? "";
    const clipped = style.match(/clip-path:\s*inset\(([^)]*)\)/);
    const inset = clipped?.[1];
    if (!inset) continue;
    const parts = inset.match(/-?\d+(?:\.\d+)?px/g);
    const rightPx = parts?.[1];
    if (rightPx !== undefined) {
      const right = Number.parseFloat(rightPx);
      if (Number.isFinite(right) && right >= 0) { reserve = right; break; }
    }
  }
  // The clip only reserves the end slot. Chat actions are inside the full-width
  // title surface, so include their real boxes rather than covering them.
  for (const control of header.querySelectorAll<HTMLElement>('button, [role="button"], a')) {
    if (control.closest(`[${SETTINGS_TRIGGER_ATTRIBUTE}]`)) continue;
    const box = measuredBounds(control);
    if (!isVisiblyLaidOut(box) || box.left < bounds.left + bounds.width / 2 ||
        box.right > bounds.right + 1 || box.top >= bounds.bottom || box.bottom <= bounds.top) continue;
    reserve = Math.max(reserve, bounds.right - box.left);
  }
  return reserve;
}

function makeFlexAndNonDrag(element: HTMLElement): void {
  element.style.alignItems = "center";
  element.style.justifyContent = "center";
  element.style.setProperty("-webkit-app-region", "no-drag");
}

export function mountRendererSettingsTrigger(
  triggerId: string,
  available: boolean,
  onOpen: (opener: HTMLButtonElement, pageId?: "updates") => void,
  ownerDocument: Document = document,
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
): RendererSettingsTriggerControl {
  const root = ownerDocument.createElement("div");
  root.setAttribute(SETTINGS_TRIGGER_ATTRIBUTE, triggerId);
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.alignSelf = "center";
  root.style.flex = "0 0 auto";
  root.style.marginRight = "0";
  root.style.color = "inherit";
  root.style.pointerEvents = "auto";
  root.style.setProperty("-webkit-app-region", "no-drag");

  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.disabled = !available;
  button.setAttribute("aria-label", messages.openSettings);
  button.setAttribute("aria-haspopup", "dialog");
  button.title = available ? messages.settingsButtonTitle : messages.settingsUnavailableTitle;
  button.style.display = "inline-flex";
  makeFlexAndNonDrag(button);
  button.style.height = "28px";
  button.style.padding = "0 12px";
  button.style.gap = "6px";
  button.style.border = "0";
  button.style.borderRadius = "8px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.cursor = available ? "pointer" : "not-allowed";
  button.style.opacity = available ? "1" : "0.5";
  button.style.outlineOffset = "2px";
  button.append(createRendererSettingsBrandIcon(24, ownerDocument));

  const brandLabel = ownerDocument.createElement("span");
  brandLabel.textContent = "Harness Mix";
  brandLabel.style.fontSize = "13px";
  brandLabel.style.fontWeight = "600";
  brandLabel.style.lineHeight = "1";
  brandLabel.style.whiteSpace = "nowrap";
  button.append(brandLabel);

  const updateButton = ownerDocument.createElement("button");
  updateButton.type = "button";
  updateButton.disabled = !available;
  updateButton.setAttribute("aria-label", messages.updateAvailable);
  updateButton.setAttribute("aria-haspopup", "dialog");
  updateButton.title = messages.updateAvailable;
  updateButton.style.display = "none";
  makeFlexAndNonDrag(updateButton);
  updateButton.style.height = "28px";
  updateButton.style.padding = "0 10px";
  updateButton.style.gap = "6px";
  updateButton.style.border = "1px solid #1d4ed8";
  updateButton.style.borderRadius = "7px";
  updateButton.style.background = "#2563eb";
  updateButton.style.color = "#ffffff";
  updateButton.style.cursor = available ? "pointer" : "not-allowed";
  updateButton.style.opacity = available ? "1" : "0.5";
  updateButton.style.boxShadow = "0 1px 2px rgba(15, 23, 42, 0.18)";
  updateButton.style.outlineOffset = "2px";
  updateButton.append(createRendererSettingsIcon("updates", 15));

  const updateLabel = ownerDocument.createElement("span");
  updateLabel.textContent = messages.pageLabels.updates;
  updateLabel.style.fontSize = "12px";
  updateLabel.style.fontWeight = "600";
  updateLabel.style.lineHeight = "1";
  updateLabel.style.whiteSpace = "nowrap";
  updateButton.append(updateLabel);

  const onPointerEnter = (): void => {
    if (!button.disabled) button.style.background = "rgba(127, 127, 127, 0.16)";
  };
  const onPointerLeave = (): void => {
    button.style.background = "transparent";
  };
  const onClick = (event: MouseEvent): void => {
    event.stopPropagation();
    if (!button.disabled) onOpen(button);
  };
  const onUpdatePointerEnter = (): void => {
    if (!updateButton.disabled) {
      updateButton.style.background = "#1d4ed8";
      updateButton.style.boxShadow = "0 2px 4px rgba(15, 23, 42, 0.22)";
    }
  };
  const onUpdatePointerLeave = (): void => {
    updateButton.style.background = "#2563eb";
    updateButton.style.boxShadow = "0 1px 2px rgba(15, 23, 42, 0.18)";
  };
  const onUpdateClick = (event: MouseEvent): void => {
    event.stopPropagation();
    if (!updateButton.disabled) onOpen(updateButton, "updates");
  };
  button.addEventListener("pointerenter", onPointerEnter);
  button.addEventListener("pointerleave", onPointerLeave);
  button.addEventListener("click", onClick);
  updateButton.addEventListener("pointerenter", onUpdatePointerEnter);
  updateButton.addEventListener("pointerleave", onUpdatePointerLeave);
  updateButton.addEventListener("click", onUpdateClick);
  root.append(button, updateButton);

  return {
    root,
    button,
    updateButton,
    setUpdateAvailable(updateAvailable) {
      root.toggleAttribute("data-update-available", updateAvailable);
      updateButton.style.display = updateAvailable ? "inline-flex" : "none";
    },
    dispose() {
      button.removeEventListener("pointerenter", onPointerEnter);
      button.removeEventListener("pointerleave", onPointerLeave);
      button.removeEventListener("click", onClick);
      updateButton.removeEventListener("pointerenter", onUpdatePointerEnter);
      updateButton.removeEventListener("pointerleave", onUpdatePointerLeave);
      updateButton.removeEventListener("click", onUpdateClick);
      root.remove();
    },
  };
}

export function installRendererSettingsHeaderTrigger(options: {
  available: boolean;
  onOpen(opener: HTMLButtonElement, pageId?: "updates"): void;
  messages?: RendererSettingsMessages;
  ownerDocument?: Document;
}): RendererSettingsHeaderTriggerControl {
  const ownerDocument = options.ownerDocument ?? document;
  let trigger: RendererSettingsTriggerControl | null = null;
  let updateAvailable = false;
  let disposed = false;

  // Re-scans the header for a usable insertion slot, (re)creating and
  // repositioning the trigger as the Desktop layout settles.
  const refresh = (): boolean => {
    if (disposed) return false;
    const insertionPoint = findRendererSettingsHeaderInsertionPoint(ownerDocument);
    if (!insertionPoint) {
      trigger?.root.remove();
      return false;
    }
    if (!trigger) {
      for (const duplicate of ownerDocument.querySelectorAll(`[${SETTINGS_TRIGGER_ATTRIBUTE}]`)) {
        duplicate.remove();
      }
      trigger = mountRendererSettingsTrigger(
        "application-header",
        options.available,
        options.onOpen,
        ownerDocument,
        options.messages,
      );
      trigger.setUpdateAvailable(updateAvailable);
    }
    if (
      trigger.root.parentElement !== insertionPoint.parent ||
      trigger.root.nextSibling !== insertionPoint.before
    ) {
      insertionPoint.parent.insertBefore(trigger.root, insertionPoint.before);
    }
    const position = insertionPoint.pinnedRight
      ? { position: 'absolute', top: '50%', transform: 'translateY(-50%)', right: insertionPoint.pinnedRight }
      : { position: '', top: '', transform: '', right: '' };
    for (const [name, value] of Object.entries(position)) {
      const property = name as 'position' | 'top' | 'transform' | 'right';
      if (trigger.root.style[property] !== value) trigger.root.style[property] = value;
    }
    return true;
  };

  const ownerWindow = ownerDocument.defaultView;
  let refreshFrame: number | null = null;
  const scheduleRefresh = (): void => {
    if (disposed || !ownerWindow || refreshFrame !== null) return;
    refreshFrame = ownerWindow.requestAnimationFrame(() => {
      refreshFrame = null;
      refresh();
    });
  };
  const observer = ownerWindow?.MutationObserver ? new ownerWindow.MutationObserver((records) => {
    if (records.some(record => !(record.target as Element).closest?.(`[${SETTINGS_TRIGGER_ATTRIBUTE}]`))) scheduleRefresh();
  }) : null;
  observer?.observe(ownerDocument.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'data-app-shell-page-header', 'data-app-shell-header-toolbar'],
  });
  ownerWindow?.addEventListener('resize', scheduleRefresh);
  refresh();
  return {
    get root() {
      return trigger?.root ?? null;
    },
    refresh,
    setUpdateAvailable(available) {
      updateAvailable = available;
      trigger?.setUpdateAvailable(available);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      ownerWindow?.removeEventListener('resize', scheduleRefresh);
      if (refreshFrame !== null) ownerWindow?.cancelAnimationFrame(refreshFrame);
      trigger?.dispose();
      trigger = null;
    },
  };
}
