/**
 * Switches Codex Desktop's official (account-level) pet from the Harness Mix
 * pet market by driving the app's own UI — nothing but real DOM events on the
 * app's own elements:
 *
 *   1. open the profile menu (the avatar button docked at the sidebar's
 *      bottom-left corner),
 *   2. activate its Settings item (recognized by the locale-independent
 *      "Ctrl+," shortcut hint in its text),
 *   3. enter the pets settings section (`data-settings-panel-slug="pets"`),
 *   4. click the pet card (`[data-avatar-id]` inside `button[aria-pressed]`),
 *   5. treat `aria-pressed="true"` on that card as confirmation,
 *   6. leave via the settings header back button, closing only surfaces we
 *      opened ourselves.
 *
 * Hard boundary: no account APIs, no tokens, no credential access, and no
 * `accessory_id` proxying — the app's own click handler performs the account
 * mutation with the app's own auth.
 *
 * All selectors below were verified live against Codex Desktop 26.908.4834.0
 * through CDP in the app webview. Radix opens the profile menu on pointerdown,
 * so menu interactions send a full pointer event sequence rather than a bare
 * click. This build has no working Ctrl/Cmd+K command menu (the earlier
 * cmdk-based approach never opened anything in the live DOM) — do not
 * reintroduce it without re-verifying against the installed app.
 */

export interface RendererPetSwitchTarget {
  /** Harness Mix market id (directory name under ~/.codex/pets for custom pets). */
  readonly id: string;
  readonly displayName: string;
}

export interface RendererPetSwitchResult {
  /** The official `data-avatar-id` that ended up selected. */
  readonly avatarId: string;
  /** True when the pet was already the selected one (no click was needed). */
  readonly alreadySelected: boolean;
}

export interface RendererPetSwitcherTiming {
  /** Poll interval for all waits. */
  readonly pollMs: number;
  /** Waiting for the profile menu / settings surface to open. */
  readonly openTimeoutMs: number;
  /** Waiting for the pets grid after navigation. */
  readonly gridTimeoutMs: number;
  /** Waiting for aria-pressed confirmation after the click. */
  readonly confirmTimeoutMs: number;
  /** Best-effort wait for surfaces to close during cleanup. */
  readonly closeTimeoutMs: number;
  /** Settle delay after opening the profile menu before reading its items. */
  readonly menuSettleMs: number;
}

export interface RendererPetSwitcherOptions {
  readonly ownerDocument?: Document;
  readonly timing?: Partial<RendererPetSwitcherTiming>;
}

const DEFAULT_TIMING: RendererPetSwitcherTiming = {
  pollMs: 120,
  openTimeoutMs: 3500,
  gridTimeoutMs: 5000,
  confirmTimeoutMs: 5000,
  closeTimeoutMs: 2000,
  menuSettleMs: 350,
};

const PROFILE_MENU_TRIGGER = 'button[aria-haspopup="menu"]';
const MENU_ITEM = '[role="menuitem"]';
const SETTINGS_NAV_ITEM = "[data-settings-panel-slug]";
const PETS_NAV_ITEM = '[data-settings-panel-slug="pets"]';
const AVATAR_ARTWORK = "[data-avatar-id]";
/** The Settings menu item is identified by its locale-independent Ctrl+, hint. */
const SETTINGS_SHORTCUT_HINT = /ctrl\s*\+\s*,/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  probe: () => boolean,
  timeoutMs: number,
  pollMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await sleep(pollMs);
  }
}

/**
 * Radix menus expand on pointerdown, so menu clicks go out as a complete
 * pointer sequence. Prefer the page's own PointerEvent and fall back to a
 * plain Event where the environment provides none.
 */
function dispatchPointerSequence(element: HTMLElement): void {
  const view = element.ownerDocument?.defaultView;
  const pointerCtor = view?.PointerEvent;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
    const event = pointerCtor
      ? new pointerCtor(type, { bubbles: true, cancelable: true, view, button: 0, buttons: 1 })
      : new Event(type, { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  }
}

/**
 * The profile trigger: an aria-haspopup="menu" button wrapping an avatar <img>,
 * docked at the sidebar's left edge. Structural matching only — the model
 * picker also carries an img but sits at the bottom-right.
 */
function findProfileMenuButton(ownerDocument: Document): HTMLElement | null {
  let leftmost: { element: HTMLElement; x: number } | null = null;
  for (const button of ownerDocument.querySelectorAll<HTMLElement>(PROFILE_MENU_TRIGGER)) {
    if (button.querySelector("img") === null) continue;
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (leftmost === null || rect.x < leftmost.x) leftmost = { element: button, x: rect.x };
  }
  return leftmost?.element ?? null;
}

/** The profile menu's Settings entry: its text carries the language-agnostic Ctrl+, hint. */
function findSettingsMenuItem(ownerDocument: Document): HTMLElement | null {
  for (const item of ownerDocument.querySelectorAll<HTMLElement>(MENU_ITEM)) {
    if (SETTINGS_SHORTCUT_HINT.test(item.textContent ?? "")) return item;
  }
  return null;
}

/** The official settings back button: the first labelled button in main > header. */
function findSettingsBackButton(ownerDocument: Document): HTMLElement | null {
  const main = ownerDocument.querySelector("main");
  const header = main?.querySelector("header");
  return header?.querySelector<HTMLElement>("button[aria-label]") ?? null;
}

/** Official pet cards: button[aria-pressed] elements wrapping [data-avatar-id] artwork. */
function petCardButtons(ownerDocument: Document): HTMLElement[] {
  const cards: HTMLElement[] = [];
  for (const artwork of ownerDocument.querySelectorAll(AVATAR_ARTWORK)) {
    const button = artwork.closest("button");
    if (button?.hasAttribute("aria-pressed")) cards.push(button as HTMLElement);
  }
  return cards;
}

function findTargetCard(
  ownerDocument: Document,
  target: RendererPetSwitchTarget,
): { button: HTMLElement; avatarId: string } | null {
  // Built-in pets use their bare id; local pets from ~/.codex/pets/<dir>/ show
  // up in the official grid as custom:<dir>.
  for (const avatarId of [`custom:${target.id}`, target.id]) {
    const artwork = ownerDocument.querySelector(`[data-avatar-id="${avatarId}"]`);
    const button = artwork?.closest("button");
    if (button) return { button: button as HTMLElement, avatarId };
  }
  // Last resort: match by display name (the official card label is the name).
  const wanted = target.displayName.trim().toLowerCase();
  if (wanted) {
    for (const button of petCardButtons(ownerDocument)) {
      if ((button.textContent ?? "").trim().toLowerCase().includes(wanted)) {
        const artwork = button.querySelector(AVATAR_ARTWORK);
        return { button, avatarId: artwork?.getAttribute("data-avatar-id") ?? target.id };
      }
    }
  }
  return null;
}

function cardIsSelected(ownerDocument: Document, target: RendererPetSwitchTarget): boolean {
  return findTargetCard(ownerDocument, target)?.button.getAttribute("aria-pressed") === "true";
}

let activeSwitch: Promise<RendererPetSwitchResult> | null = null;

/**
 * Switch Codex Desktop's official pet by driving the app's own settings UI.
 * Rejects while another switch is still running (the market page also disables
 * its buttons for the duration).
 */
export function switchOfficialCodexPet(
  target: RendererPetSwitchTarget,
  options: RendererPetSwitcherOptions = {},
): Promise<RendererPetSwitchResult> {
  if (activeSwitch) {
    return Promise.reject(new Error("An official pet switch is already in progress"));
  }
  const run = runOfficialCodexPetSwitch(target, options).finally(() => {
    activeSwitch = null;
  });
  activeSwitch = run;
  return run;
}

async function runOfficialCodexPetSwitch(
  target: RendererPetSwitchTarget,
  options: RendererPetSwitcherOptions,
): Promise<RendererPetSwitchResult> {
  const ownerDocument = options.ownerDocument ?? document;
  const timing: RendererPetSwitcherTiming = { ...DEFAULT_TIMING, ...options.timing };
  const settingsAlreadyOpen = ownerDocument.querySelector(SETTINGS_NAV_ITEM) !== null;
  let openedSettings = false;
  try {
    if (!settingsAlreadyOpen) {
      // Open the profile menu (bottom-left avatar button) and pick the item
      // whose text carries the Ctrl+, shortcut hint.
      const profileButton = findProfileMenuButton(ownerDocument);
      if (!profileButton) throw new Error("Codex profile menu button not found");
      dispatchPointerSequence(profileButton);
      let settingsItem: HTMLElement | null = null;
      try {
        await pollUntil(
          () => {
            settingsItem = findSettingsMenuItem(ownerDocument);
            return settingsItem !== null;
          },
          timing.openTimeoutMs,
          timing.pollMs,
          "the Codex profile menu did not open",
        );
      } catch (error) {
        // The menu may already be open (left over from an earlier failure):
        // toggle once more and only fail if the retry also comes up empty.
        dispatchPointerSequence(profileButton);
        await pollUntil(
          () => {
            settingsItem = findSettingsMenuItem(ownerDocument);
            return settingsItem !== null;
          },
          timing.menuSettleMs,
          timing.pollMs,
          (error as Error).message,
        );
      }
      dispatchPointerSequence(settingsItem as unknown as HTMLElement);
      await pollUntil(
        () => ownerDocument.querySelector(SETTINGS_NAV_ITEM) !== null,
        timing.openTimeoutMs,
        timing.pollMs,
        "the Codex settings did not open",
      );
      openedSettings = true;
    }
    if (!findTargetCard(ownerDocument, target)) {
      // Settings are open but not on the pets page: use the settings sidebar
      // item (selector is locale-independent).
      const navItem = ownerDocument.querySelector<HTMLElement>(PETS_NAV_ITEM);
      if (navItem) navItem.click();
    }

    await pollUntil(
      () => petCardButtons(ownerDocument).length > 0,
      timing.gridTimeoutMs,
      timing.pollMs,
      "the official Pets grid did not render",
    );
    const found = findTargetCard(ownerDocument, target);
    if (!found) {
      throw new Error(
        `Pet "${target.displayName}" (${target.id}) was not found in the official Codex Pets settings`,
      );
    }
    if (found.button.getAttribute("aria-pressed") === "true") {
      return { avatarId: found.avatarId, alreadySelected: true };
    }
    found.button.click();
    await pollUntil(
      // React may re-render the card into a fresh node, so re-locate it on
      // every poll instead of watching a stale element.
      () => cardIsSelected(ownerDocument, target),
      timing.confirmTimeoutMs,
      timing.pollMs,
      `selecting "${target.displayName}" was not confirmed by the official Pets settings`,
    );
    return { avatarId: found.avatarId, alreadySelected: false };
  } finally {
    // Cleanup: close only the official settings this run opened; settings the
    // user had open stay untouched. Escape is deliberately avoided — the
    // Harness Mix settings dialog is also a modal <dialog> and would close
    // first.
    if (openedSettings && ownerDocument.querySelector(SETTINGS_NAV_ITEM) !== null) {
      const backButton = findSettingsBackButton(ownerDocument);
      if (backButton) {
        backButton.click();
        try {
          await pollUntil(
            () => ownerDocument.querySelector(SETTINGS_NAV_ITEM) === null,
            timing.closeTimeoutMs,
            timing.pollMs,
            "the official settings did not close",
          );
        } catch {
          // A failed close must not mask the main result; the user can still
          // navigate back manually.
        }
      }
    }
  }
}
