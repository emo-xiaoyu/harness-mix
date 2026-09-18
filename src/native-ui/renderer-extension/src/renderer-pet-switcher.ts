/**
 * Drives Codex Desktop's OFFICIAL pet selection from the Harness Mix pet market.
 *
 * The official pet is the account-level mascot (the app's own Settings → Pets
 * grid). This module performs pure in-page UI automation — genuine DOM clicks
 * on the app's own elements only:
 *
 *   1. open the app's profile menu (avatar button, bottom-left of the sidebar),
 *   2. click its Settings item (the one carrying the Ctrl+, shortcut hint),
 *   3. click the "pets" settings nav (`data-settings-panel-slug="pets"`),
 *   4. click the target pet card (`[data-avatar-id]` inside `button[aria-pressed]`),
 *   5. confirm via the card's `aria-pressed="true"` state,
 *   6. click the settings header back button, leaving every surface it opened closed.
 *
 * HARD CONSTRAINT: this never calls account APIs, never reads tokens or
 * credentials, and never proxies `accessory_id` — the app's own click handler
 * performs the account mutation with the app's own auth.
 *
 * Selector facts LIVE-VERIFIED against the installed Codex Desktop
 * 26.908.4834.0 (via CDP Runtime.evaluate in the app webview):
 *   - profile menu trigger: `button[aria-haspopup="menu"]` wrapping an avatar
 *     `<img>`, docked at the left edge of the sidebar; opens a Radix menu on
 *     pointerdown (hence the pointer sequence, not a bare .click());
 *   - the Settings menu item is a `[role="menuitem"]` whose text carries the
 *     locale-independent shortcut hint `Ctrl+,`;
 *   - settings sections render nav buttons with `data-settings-panel-slug`
 *     ("general-settings", "pets", …) — locale-independent;
 *   - pet cards are `<button aria-pressed="…">` wrapping artwork with
 *     `data-avatar-id="<id>"`; built-in ids are bare (`codex`, `bsod`, …)
 *     while pets installed under ~/.codex/pets/<dir>/ appear as `custom:<dir>`;
 *   - the settings surface is a `main > header` layout whose first
 *     `button[aria-label]` is the back button; clicking it returns to the app.
 *   - NOTE: there is NO working Ctrl/Cmd+K command menu in this build — an
 *     earlier revision of this module relied on it after static app.asar
 *     analysis; live verification proved it never opens (cmdk nodes do not
 *     exist in the DOM). Do not reintroduce it without re-verifying live.
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
/** 设置菜单项：文本里带与语言无关的快捷键提示 Ctrl+, */
const SETTINGS_SHORTCUT_HINT = /ctrl\s*\+\s*,/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
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
 * Radix 下拉菜单在 pointerdown 上展开，因此菜单交互用完整的指针事件序列；
 * 事件构造优先用页面自己的 PointerEvent（测试环境没有就退回普通 Event）。
 */
function dispatchPointerSequence(element: HTMLElement): void {
  const view = element.ownerDocument?.defaultView;
  const PointerCtor = view?.PointerEvent;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
    const event = PointerCtor
      ? new PointerCtor(type, { bubbles: true, cancelable: true, view, button: 0, buttons: 1 })
      : new Event(type, { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  }
}

/**
 * 个人菜单按钮：侧栏左下角带头像 <img> 的 aria-haspopup="menu" 按钮。
 * 结构特征定位，不依赖任何语言文案（模型选择器同样带 img，但停靠在右下）。
 */
function findProfileMenuButton(ownerDocument: Document): HTMLElement | null {
  let best: { element: HTMLElement; x: number } | null = null;
  for (const button of ownerDocument.querySelectorAll<HTMLElement>(PROFILE_MENU_TRIGGER)) {
    if (button.querySelector("img") === null) continue;
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (best === null || rect.x < best.x) best = { element: button, x: rect.x };
  }
  return best?.element ?? null;
}

/** 个人菜单里的设置项：文本带 Ctrl+, 快捷键提示（与语言无关） */
function findSettingsMenuItem(ownerDocument: Document): HTMLElement | null {
  for (const item of ownerDocument.querySelectorAll<HTMLElement>(MENU_ITEM)) {
    if (SETTINGS_SHORTCUT_HINT.test(item.textContent ?? "")) return item;
  }
  return null;
}

/** 官方设置页的返回按钮：main > header 里的第一个带 aria-label 的按钮 */
function findSettingsBackButton(ownerDocument: Document): HTMLElement | null {
  const main = ownerDocument.querySelector("main");
  const header = main?.querySelector("header");
  return header?.querySelector<HTMLElement>("button[aria-label]") ?? null;
}

/** 官方宠物卡片：button[aria-pressed] 包裹 [data-avatar-id] 的 artwork */
function petCardButtons(ownerDocument: Document): HTMLElement[] {
  const buttons: HTMLElement[] = [];
  for (const artwork of ownerDocument.querySelectorAll(AVATAR_ARTWORK)) {
    const button = artwork.closest("button");
    if (button?.hasAttribute("aria-pressed")) buttons.push(button as HTMLElement);
  }
  return buttons;
}

function findTargetCard(
  ownerDocument: Document,
  target: RendererPetSwitchTarget,
): { button: HTMLElement; avatarId: string } | null {
  // 官方预载宠物用裸 id；~/.codex/pets/<dir>/ 下的本地宠物在官方网格里是 custom:<dir>
  for (const avatarId of [`custom:${target.id}`, target.id]) {
    const artwork = ownerDocument.querySelector(`[data-avatar-id="${avatarId}"]`);
    const button = artwork?.closest("button");
    if (button) return { button: button as HTMLElement, avatarId };
  }
  // 兜底：按显示名匹配（官方网格的卡片 label 是 displayName）
  const name = target.displayName.trim().toLowerCase();
  if (name) {
    for (const button of petCardButtons(ownerDocument)) {
      if ((button.textContent ?? "").trim().toLowerCase().includes(name)) {
        const artwork = button.querySelector(AVATAR_ARTWORK);
        return { button, avatarId: artwork?.getAttribute("data-avatar-id") ?? target.id };
      }
    }
  }
  return null;
}

function cardIsSelected(ownerDocument: Document, target: RendererPetSwitchTarget): boolean {
  const found = findTargetCard(ownerDocument, target);
  return found?.button.getAttribute("aria-pressed") === "true";
}

let activeSwitch: Promise<RendererPetSwitchResult> | null = null;

/**
 * Switch Codex Desktop's official pet by driving the app's own settings UI.
 * Rejects when another switch is still running (the market page additionally
 * disables its buttons while a switch is in flight).
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
      // 打开个人菜单（侧栏左下角头像按钮），点击其中带 Ctrl+, 快捷键提示的设置项
      const profileButton = findProfileMenuButton(ownerDocument);
      if (!profileButton) throw new Error("Codex profile menu button not found");
      dispatchPointerSequence(profileButton);
      let settingsItem: HTMLElement | null = null;
      try {
        await waitFor(
          () => {
            settingsItem = findSettingsMenuItem(ownerDocument);
            return settingsItem !== null;
          },
          timing.openTimeoutMs,
          timing.pollMs,
          "the Codex profile menu did not open",
        );
      } catch (error) {
        // 菜单可能本就已展开（上次失败残留）：再触发一次尝试恢复后仍失败才报错
        dispatchPointerSequence(profileButton);
        await waitFor(
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
      await waitFor(
        () => ownerDocument.querySelector(SETTINGS_NAV_ITEM) !== null,
        timing.openTimeoutMs,
        timing.pollMs,
        "the Codex settings did not open",
      );
      openedSettings = true;
    }
    if (!findTargetCard(ownerDocument, target)) {
      // 设置已打开但不在桌宠页：走设置侧边栏的桌宠项（选择器与语言无关）
      const navItem = ownerDocument.querySelector<HTMLElement>(PETS_NAV_ITEM);
      if (navItem) navItem.click();
    }

    await waitFor(
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
    await waitFor(
      // React 可能重渲染出新节点，每次轮询都重新定位卡片
      () => cardIsSelected(ownerDocument, target),
      timing.confirmTimeoutMs,
      timing.pollMs,
      `selecting "${target.displayName}" was not confirmed by the official Pets settings`,
    );
    return { avatarId: found.avatarId, alreadySelected: false };
  } finally {
    // 收场：只关闭本次由我们打开的官方设置（用户自己开着的设置保持原样）。
    // 不用 Escape —— Harness Mix 设置对话框也是 modal <dialog>，Escape 会先关掉我们自己的界面。
    if (openedSettings && ownerDocument.querySelector(SETTINGS_NAV_ITEM) !== null) {
      const backButton = findSettingsBackButton(ownerDocument);
      if (backButton) {
        backButton.click();
        try {
          await waitFor(
            () => ownerDocument.querySelector(SETTINGS_NAV_ITEM) === null,
            timing.closeTimeoutMs,
            timing.pollMs,
            "the official settings did not close",
          );
        } catch {
          // 关闭失败不掩盖主流程结果（设置页留在官方桌宠页，用户可手动返回）
        }
      }
    }
  }
}
