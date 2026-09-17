import { describe, expect, it } from "vitest";

import {
  RENDERER_SKIN_ATTRIBUTE,
  RENDERER_SKIN_STORAGE_KEY,
  RENDERER_SKIN_STYLE_ID,
  RENDERER_SKINS,
  applyRendererSkin,
  readRendererSkin,
} from "../../src/settings/skin-runtime.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function fakeDocument() {
  const attributes = new Map<string, string>();
  let style: { id: string; textContent: string; remove(): void } | null = null;
  const document = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
    },
    head: {
      append(next: typeof style) {
        style = next;
      },
    },
    getElementById(id: string) {
      return style?.id === id ? style : null;
    },
    createElement() {
      const element = {
        id: "",
        textContent: "",
        remove() {
          style = null;
        },
      };
      return element;
    },
  } as unknown as Document;
  return { document, attributes, getStyle: () => style };
}

describe("renderer skin runtime", () => {
  it("ships a native escape hatch and visual-only attributed references", () => {
    expect(RENDERER_SKINS.map(({ id }) => id)).toEqual([
      "native",
      "miku-488137",
      "genshin-dawn",
      "genshin-night",
      "wuthering-echo",
      "wuthering-tide",
      "naruto-hokage",
      "naruto-sasuke",
      "deepspace-dawn",
      "deepspace-star",
      "dragonball-nimbus",
      "dragonball-super-saiyan",
      "dalao-dianyan",
      "styler-gilded-grandeur",
      "styler-merry-big-top",
      "styler-nocturne-studio",
      "styler-quiet-garden",
      "dream-gothic-void-crusade",
      "palette-catppuccin-latte",
      "palette-catppuccin-mocha",
      "palette-claude-desktop-dark",
      "palette-claude-desktop-light",
      "palette-gruvbox-dark",
      "palette-gruvbox-light",
      "palette-nord-dark",
      "palette-nord-light",
      "palette-one-dark",
      "palette-one-light",
      "palette-tokyo-night-dark",
      "palette-tokyo-night-light",
    ]);
    expect(RENDERER_SKINS[0]?.sourceUrl).toBeNull();
    expect(RENDERER_SKINS.slice(1).every(({ sourceUrl }) => sourceUrl?.startsWith("https://github.com/"))).toBe(true);
    expect(RENDERER_SKINS.slice(1).every((skin) => Boolean(skin.heroUrl) || skin.id.startsWith("palette-"))).toBe(true);
    expect(RENDERER_SKINS.filter((skin) => skin.id.startsWith("palette-")).every((skin) => skin.preview.startsWith("linear-gradient"))).toBe(true);
    const miku = RENDERER_SKINS.find(({ id }) => id === "miku-488137");
    expect(miku?.logoUrl).toContain("logo.webp");
    expect(miku?.polaroidUrl).toContain("polaroid.webp");
  });

  it("applies, persists, and fully removes a skin override", () => {
    const storage = new MemoryStorage();
    const fixture = fakeDocument();

    applyRendererSkin("miku-488137", fixture.document, storage);
    expect(fixture.attributes.get(RENDERER_SKIN_ATTRIBUTE)).toBe("miku-488137");
    expect(fixture.getStyle()?.id).toBe(RENDERER_SKIN_STYLE_ID);
    expect(fixture.getStyle()?.textContent).toContain("--sidebar-background");
    expect(fixture.getStyle()?.textContent).not.toContain("<script");
    expect(fixture.getStyle()?.textContent).toContain("background-image");
    expect(fixture.getStyle()?.textContent).toContain('main[class*="_MainContentSurface_"]');
    expect(fixture.getStyle()?.textContent).toContain('.main-surface');
    expect(fixture.getStyle()?.textContent).toContain('[data-app-shell-main-surface="default"]');
    expect(fixture.getStyle()?.textContent).toContain("[data-response-annotation-conversation]");
    expect(fixture.getStyle()?.textContent).toContain("96%, transparent");
    expect(fixture.getStyle()?.textContent).toContain("backdrop-filter: blur");
    expect(fixture.getStyle()?.textContent).not.toContain("background: transparent !important; border-color: transparent");
    expect(fixture.getStyle()?.textContent).toContain("--color-text-primary");
    expect(fixture.getStyle()?.textContent).toContain("--color-token-foreground");
    expect(fixture.getStyle()?.textContent).toContain("--app-color-text-foreground");
    expect(fixture.getStyle()?.textContent).toContain("--wb-text-primary");
    expect(fixture.getStyle()?.textContent).toContain("--color-surface-elevated-secondary");
    expect(fixture.getStyle()?.textContent).toContain("--color-background-primary-soft-alpha");
    expect(fixture.getStyle()?.textContent).toContain("--app-color-background-elevated-secondary");
    expect(fixture.getStyle()?.textContent).toContain("--color-codex-diff-surface");
    expect(fixture.getStyle()?.textContent).toContain("--vscode-editor-background");
    expect(fixture.getStyle()?.textContent).toContain("logo.webp");
    expect(fixture.getStyle()?.textContent).toContain("polaroid.webp");
    expect(fixture.getStyle()?.textContent).toContain("body::after");
    expect(fixture.getStyle()?.textContent).not.toContain("background-attachment: fixed");
    expect(fixture.getStyle()?.textContent).toContain("--codex-titlebar-tint: transparent");
    expect(fixture.getStyle()?.textContent).toContain("[data-tab-id]");
    expect(fixture.getStyle()?.textContent).toContain("[data-app-shell-header-obstacle] button");
    expect(fixture.getStyle()?.textContent).toContain("[data-app-shell-main-content-top-fade]");
    expect(fixture.getStyle()?.textContent).toContain("[data-app-shell-page-header] > [data-app-shell-header-toolbar] > div:first-child");
    expect(fixture.getStyle()?.textContent).toContain('button[aria-haspopup="menu"]:hover');
    expect(fixture.getStyle()?.textContent).toContain("@container home-main-content");
    expect(fixture.getStyle()?.textContent).toContain('[data-composer-placement="home"]');
    expect(fixture.getStyle()?.textContent).toContain("--thread-content-max-width: min(72rem");
    expect(fixture.getStyle()?.textContent).toContain("hero.webp");
    expect(storage.getItem(RENDERER_SKIN_STORAGE_KEY)).toBe("miku-488137");
    expect(readRendererSkin(storage)).toBe("miku-488137");

    applyRendererSkin("native", fixture.document, storage);
    expect(fixture.attributes.has(RENDERER_SKIN_ATTRIBUTE)).toBe(false);
    expect(fixture.getStyle()).toBeNull();
    expect(storage.getItem(RENDERER_SKIN_STORAGE_KEY)).toBeNull();
  });

  it("falls back to native for stale persisted values", () => {
    const storage = new MemoryStorage();
    storage.setItem(RENDERER_SKIN_STORAGE_KEY, "removed-theme");
    expect(readRendererSkin(storage)).toBe("native");
  });

  it("applies shared transparent header chrome and readable user messages to every custom skin", () => {
    const storage = new MemoryStorage();
    const fixture = fakeDocument();

    for (const skin of RENDERER_SKINS.slice(1)) {
      applyRendererSkin(skin.id, fixture.document, storage);
      const css = fixture.getStyle()?.textContent ?? "";
      expect(fixture.attributes.get(RENDERER_SKIN_ATTRIBUTE)).toBe(skin.id);
      expect(css).toContain("--color-text-user-message:");
      expect(css).toContain('[data-user-message-bubble] :where(');
      expect(css).toContain('[data-markdown-text-tone="user-message"]');
      expect(css).toContain('[data-app-shell-header-toolbar] > div:first-child {');
      expect(css).toContain('> button[aria-haspopup="menu"][data-state="open"]');
      expect(css).toContain("background: transparent !important;");
    }
  });
});
