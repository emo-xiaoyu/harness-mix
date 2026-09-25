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
  const headers = [
    ...ownerDocument.querySelectorAll<HTMLElement>(SETTINGS_APPLICATION_HEADER_SELECTOR),
  ];
  const visibleHeaders = headers.filter((header) => isVisiblyLaidOut(measuredBounds(header)));
  const insertionPointCount = visibleHeaders.filter((header) =>
    [...header.querySelectorAll<HTMLElement>(SETTINGS_HEADER_SLOT_SELECTOR)].some((slot) =>
      isVisiblyLaidOut(measuredBounds(slot)),
    ),
  ).length;
  return {
    headerCount: headers.length,
    visibleHeaderCount: visibleHeaders.length,
    insertionPointCount,
  };
}

// Locates where the trigger belongs: the rightmost visible direct slot child
// of the visible application header. The trigger is inserted before that slot.
function findRendererSettingsHeaderInsertionPoint(
  ownerDocument: Document,
): RendererSettingsHeaderInsertionPoint | null {
  const header = ownerDocument.querySelector<HTMLElement>(SETTINGS_APPLICATION_HEADER_SELECTOR);
  if (!header) return null;

  const headerBounds = measuredBounds(header);
  if (!isVisiblyLaidOut(headerBounds)) return null;

  const visibleSlots = [...header.querySelectorAll<HTMLElement>(SETTINGS_HEADER_SLOT_SELECTOR)]
    .filter((slot) => isVisiblyLaidOut(measuredBounds(slot)));
  const endSlot = visibleSlots.toSorted(
    (left, right) => measuredBounds(right).left - measuredBounds(left).left,
  )[0];
  return endSlot ? { parent: header, before: endSlot } : null;
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
    return true;
  };

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
      trigger?.dispose();
      trigger = null;
    },
  };
}
