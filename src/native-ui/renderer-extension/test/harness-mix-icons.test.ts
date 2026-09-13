import { afterEach, describe, expect, it } from "vitest";

import { projectIcon } from "../src/harness-mix-icons.js";

function createImage() {
  return {
    src: "",
    alt: "unset",
    draggable: true,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
  } as unknown as HTMLImageElement;
}

function createDocument(image: HTMLImageElement): Document {
  return {
    createElement(tagName: string) {
      expect(tagName).toBe("img");
      return image;
    },
  } as unknown as Document;
}

describe("project icons", () => {
  const previousIcons = (globalThis as any).__HARNESS_MIX_ICONS__;

  afterEach(() => {
    (globalThis as any).__HARNESS_MIX_ICONS__ = previousIcons;
  });

  it("preserves explicit brand colors in multi-color SVGs", () => {
    const image = createImage();
    (globalThis as any).__HARNESS_MIX_ICONS__ = {
      harnesses: {
        qoder: { svg: '<svg fill="currentColor"><path fill="#2ADB5C"/><path/></svg>' },
      },
    };

    expect(projectIcon("harnesses", "qoder", 20, createDocument(image))).toBe(image);
    expect(image.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(image.style.maskImage).toBeUndefined();
    expect(image.style.backgroundColor).toBeUndefined();
  });

  it("masks truly monochrome currentColor SVGs", () => {
    const image = createImage();
    (globalThis as any).__HARNESS_MIX_ICONS__ = {
      harnesses: {
        pi: { svg: '<svg fill="currentColor"><path/></svg>' },
      },
    };

    expect(projectIcon("harnesses", "pi", 20, createDocument(image))).toBe(image);
    expect(image.src).toMatch(/^data:image\/svg\+xml,%3Csvg xmlns=/);
    expect(image.style.maskImage).toContain("data:image/svg+xml;charset=utf-8,");
    expect(image.style.backgroundColor).toBe("currentColor");
  });
});
