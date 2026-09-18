import { describe, expect, it } from "vitest";
import { switchOfficialCodexPet } from "../src/renderer-pet-switcher.js";

const FAST_TIMING = {
  pollMs: 10,
  openTimeoutMs: 400,
  gridTimeoutMs: 400,
  confirmTimeoutMs: 250,
  closeTimeoutMs: 300,
  menuSettleMs: 40,
} as const;

/** Minimal DOM node covering exactly what the switcher touches. */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  parent: FakeElement | null = null;
  text = "";
  rect = { x: 0, y: 0, width: 12, height: 12, top: 0, left: 0, right: 12, bottom: 12 };

  constructor(readonly tagName: string) {}

  get ownerDocument(): FakeDocument | null {
    let node: FakeElement | null = this;
    while (node) {
      if (node instanceof FakeDocument) return node;
      node = node.parent;
    }
    return null;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  getBoundingClientRect(): FakeElement["rect"] {
    return this.rect;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    if (event.bubbles && this.parent) this.parent.dispatchEvent(event);
    return true;
  }

  click(): void {
    this.dispatchEvent(new Event("click", { bubbles: true }));
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector.split(",").some((part) => {
    const trimmed = part.trim();
    const attrMatch = /^(?:([a-z]+))?\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(trimmed);
    if (attrMatch) {
      const [, tag, attr, value] = attrMatch;
      if (tag && element.tagName !== tag) return false;
      if (!element.hasAttribute(attr!)) return false;
      if (value !== undefined && element.getAttribute(attr!) !== value) return false;
      return true;
    }
    return element.tagName === trimmed;
  });
}

class FakeDocument extends FakeElement {
  readonly defaultView = { navigator: { platform: "Win32" }, PointerEvent: undefined };

  constructor() {
    super("#document");
  }
}

let fakeDocument: FakeDocument;

interface FakeAppOptions {
  /** Pet avatar ids in the official grid (already mapped form, e.g. custom:rush / bsod). */
  readonly petIds: readonly string[];
  /** Whether clicking a pet card confirms the selection (the app's account mutation). */
  readonly confirmOnClick?: boolean;
  /** Avatar id that starts out selected. */
  readonly initiallySelected?: string;
  /** Whether the profile menu exists at all. */
  readonly withProfileMenu?: boolean;
}

/**
 * Simulates the official Codex app's reactions to the switcher's genuine DOM
 * events, mirroring the live-verified structure: profile menu (Radix) with a
 * "…Ctrl+," settings item → settings surface with data-settings-panel-slug
 * nav + main>header back button → pet grid of button[aria-pressed] cards.
 */
function installFakeOfficialApp(options: FakeAppOptions) {
  const state = {
    profileMenuOpen: false,
    settingsOpen: false,
    settingsSection: null as string | null,
    selectedPetId: options.initiallySelected ?? null,
    profileClicks: 0,
    clickedPetIds: [] as string[],
    backClicks: 0,
  };

  const menuRoot = new FakeElement("div");
  const settingsRoot = new FakeElement("div");

  const openProfileMenu = () => {
    state.profileMenuOpen = true;
    const menu = new FakeElement("div");
    const settingsItem = new FakeElement("div");
    settingsItem.setAttribute("role", "menuitem");
    settingsItem.text = "设置Ctrl+,";
    settingsItem.addEventListener("click", () => {
      closeProfileMenu();
      openSettings("general-settings");
    });
    const usageItem = new FakeElement("div");
    usageItem.setAttribute("role", "menuitem");
    usageItem.text = "剩余用量";
    menu.append(settingsItem, usageItem);
    menuRoot.append(menu);
  };
  const closeProfileMenu = () => {
    state.profileMenuOpen = false;
    menuRoot.children.splice(0);
  };

  const openSettings = (section: string) => {
    state.settingsOpen = true;
    state.settingsSection = section;
    renderSettings();
  };
  const closeSettings = () => {
    state.settingsOpen = false;
    state.settingsSection = null;
    settingsRoot.children.splice(0);
  };

  const renderSettings = () => {
    settingsRoot.children.splice(0);
    const main = new FakeElement("main");
    const header = new FakeElement("header");
    const back = new FakeElement("button");
    back.setAttribute("aria-label", "返回 ChatGPT");
    back.addEventListener("click", () => {
      state.backClicks += 1;
      closeSettings();
    });
    header.append(back);
    main.append(header);
    const nav = new FakeElement("nav");
    for (const slug of ["general-settings", "pets"]) {
      const item = new FakeElement("button");
      item.setAttribute("data-settings-panel-slug", slug);
      item.text = slug;
      item.addEventListener("click", () => openSettings(slug));
      nav.append(item);
    }
    main.append(nav);
    if (state.settingsSection === "pets") {
      const grid = new FakeElement("div");
      for (const petId of options.petIds) {
        const card = new FakeElement("button");
        card.setAttribute("aria-pressed", String(state.selectedPetId === petId));
        card.text = petId;
        const artwork = new FakeElement("div");
        artwork.setAttribute("data-avatar-id", petId);
        card.append(artwork);
        card.addEventListener("click", () => {
          state.clickedPetIds.push(petId);
          if (options.confirmOnClick !== false) {
            state.selectedPetId = petId;
            renderSettings(); // the app re-renders after the account mutation
          }
        });
        grid.append(card);
      }
      main.append(grid);
    }
    settingsRoot.append(main);
  };

  if (options.withProfileMenu !== false) {
    const profileButton = new FakeElement("button");
    profileButton.setAttribute("aria-haspopup", "menu");
    profileButton.rect = { x: 8, y: 680, width: 40, height: 40, top: 680, left: 8, right: 48, bottom: 720 };
    const avatarImg = new FakeElement("img");
    profileButton.append(avatarImg);
    profileButton.addEventListener("click", () => {
      state.profileClicks += 1;
      if (state.profileMenuOpen) closeProfileMenu();
      else openProfileMenu();
    });
    // 另一个带 img 的菜单按钮（模型选择器），停靠在右下：必须不被误选
    const modelButton = new FakeElement("button");
    modelButton.setAttribute("aria-haspopup", "menu");
    modelButton.rect = { x: 748, y: 666, width: 90, height: 32, top: 666, left: 748, right: 838, bottom: 698 };
    modelButton.append(new FakeElement("img"));
    fakeDocument.append(profileButton, modelButton);
  }

  fakeDocument.append(menuRoot, settingsRoot);
  return state;
}

const runSwitch = (target: { id: string; displayName: string }) =>
  switchOfficialCodexPet(target, {
    ownerDocument: fakeDocument as unknown as Document,
    timing: FAST_TIMING,
  });

describe("switchOfficialCodexPet", () => {
  it("drives the official UI: profile menu → Settings item → pets nav → pet card → confirmed → settings closed", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({ petIds: ["custom:rush", "bsod"] });

    const result = await runSwitch({ id: "rush", displayName: "Rush" });

    expect(result).toEqual({ avatarId: "custom:rush", alreadySelected: false });
    expect(app.profileClicks).toBe(1); // opened the profile menu once
    expect(app.clickedPetIds).toEqual(["custom:rush"]); // genuine click on the official card
    expect(app.selectedPetId).toBe("custom:rush"); // confirmed by aria-pressed
    expect(app.settingsOpen).toBe(false); // settings left closed afterwards
    expect(app.backClicks).toBe(1);
  });

  it("maps built-in pets to their bare avatar id", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({ petIds: ["bsod", "codex"] });
    const result = await runSwitch({ id: "bsod", displayName: "BSOD" });
    expect(result).toEqual({ avatarId: "bsod", alreadySelected: false });
    expect(app.selectedPetId).toBe("bsod");
  });

  it("picks the left-most avatar menu button (not the model picker)", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({ petIds: ["custom:rush"] });
    await runSwitch({ id: "rush", displayName: "Rush" });
    expect(app.profileClicks).toBe(1); // only the profile button was triggered
    expect(app.selectedPetId).toBe("custom:rush");
  });

  it("does not click when the pet is already selected", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({
      petIds: ["custom:rush"],
      initiallySelected: "custom:rush",
    });
    const result = await runSwitch({ id: "rush", displayName: "Rush" });
    expect(result).toEqual({ avatarId: "custom:rush", alreadySelected: true });
    expect(app.clickedPetIds).toEqual([]);
  });

  it("fails cleanly when the pet is missing from the official grid", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({ petIds: ["bsod"] });
    await expect(runSwitch({ id: "ghost", displayName: "Ghost" })).rejects.toThrow(
      /not found in the official Codex Pets settings/,
    );
    expect(app.settingsOpen).toBe(false); // settings closed on failure
    expect(app.profileMenuOpen).toBe(false);
  });

  it("times out with a clear error when the click is never confirmed", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({ petIds: ["custom:rush"], confirmOnClick: false });
    await expect(runSwitch({ id: "rush", displayName: "Rush" })).rejects.toThrow(/not confirmed/);
    expect(app.settingsOpen).toBe(false);
  });

  it("rejects when the profile menu button is absent", async () => {
    fakeDocument = new FakeDocument();
    installFakeOfficialApp({ petIds: ["custom:rush"], withProfileMenu: false });
    await expect(runSwitch({ id: "rush", displayName: "Rush" })).rejects.toThrow(
      /profile menu button not found/,
    );
  });

  it("recovers when the profile menu was already open (toggle-and-retry)", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({ petIds: ["custom:rush"] });
    // 手动点开菜单模拟残留状态：第一次 pointer 序列会把它关掉，重试路径再打开
    const profileButton = fakeDocument.querySelector('button[aria-haspopup="menu"]') as FakeElement;
    profileButton.click();
    expect(app.profileMenuOpen).toBe(true);
    const result = await runSwitch({ id: "rush", displayName: "Rush" });
    expect(result.alreadySelected).toBe(false);
    expect(app.profileClicks).toBeGreaterThan(1);
    expect(app.selectedPetId).toBe("custom:rush");
  });

  it("guards against concurrent switch runs", async () => {
    fakeDocument = new FakeDocument();
    installFakeOfficialApp({ petIds: ["custom:rush"], confirmOnClick: false });
    const first = runSwitch({ id: "rush", displayName: "Rush" });
    await expect(runSwitch({ id: "bsod", displayName: "BSOD" })).rejects.toThrow(/already in progress/);
    await expect(first).rejects.toThrow(/not confirmed/);
  });

  it("uses the settings sidebar when the official settings are already open and leaves them open", async () => {
    fakeDocument = new FakeDocument();
    const app = installFakeOfficialApp({ petIds: ["custom:rush"] });
    // 用户自己开着官方设置（停在别的分组）：直接走 data-settings-panel-slug 导航
    const main = new FakeElement("main");
    const header = new FakeElement("header");
    const back = new FakeElement("button");
    back.setAttribute("aria-label", "返回 ChatGPT");
    header.append(back);
    main.append(header);
    const nav = new FakeElement("nav");
    const generalItem = new FakeElement("button");
    generalItem.setAttribute("data-settings-panel-slug", "general-settings");
    const petsItem = new FakeElement("button");
    petsItem.setAttribute("data-settings-panel-slug", "pets");
    nav.append(generalItem, petsItem);
    main.append(nav);
    const gridHolder = new FakeElement("div");
    main.append(gridHolder);
    fakeDocument.append(main);
    petsItem.addEventListener("click", () => {
      const card = new FakeElement("button");
      card.setAttribute("aria-pressed", "false");
      const artwork = new FakeElement("div");
      artwork.setAttribute("data-avatar-id", "custom:rush");
      card.append(artwork);
      card.addEventListener("click", () => {
        app.clickedPetIds.push("custom:rush");
        card.setAttribute("aria-pressed", "true");
      });
      gridHolder.append(card);
    });

    const result = await runSwitch({ id: "rush", displayName: "Rush" });
    expect(result.alreadySelected).toBe(false);
    expect(app.clickedPetIds).toEqual(["custom:rush"]);
    expect(app.profileClicks).toBe(0); // 没有动用个人菜单
    expect(app.backClicks).toBe(0); // 用户自己开着的设置保持原样
  });
});
