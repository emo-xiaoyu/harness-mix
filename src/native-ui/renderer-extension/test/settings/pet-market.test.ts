import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
  isRendererSettingsIconName: () => true,
}));

// The market page drives the official Codex pet UI through this module; tests mock it.
const switchCalls: Array<{ id: string; displayName: string }> = [];
let switchBehavior: (target: { id: string; displayName: string }) => Promise<void> = async () => {};
vi.mock("../../src/renderer-pet-switcher.js", () => ({
  switchOfficialCodexPet: (target: { id: string; displayName: string }) => {
    switchCalls.push(target);
    return switchBehavior(target);
  },
}));

import { createPetSettingsPage } from "../../src/settings/pet-market.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import type { RendererPetsClient } from "../../src/settings/pets-client.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => void>>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  placeholder = "";
  value = "";
  disabled = false;
  parent: FakeElement | null = null;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node?.parent) node = node.parent;
    return node === this.ownerDocument.contentRoot || node === this;
  }

  append(...children: unknown[]): void {
    for (const child of children) {
      if (child instanceof FakeElement) child.parent = this;
    }
    this.children.push(...children);
  }

  replaceChildren(...children: unknown[]): void {
    for (const child of this.children) {
      if (child instanceof FakeElement && child.parent === this) child.parent = null;
    }
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  addEventListener(name: string, listener: () => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  removeEventListener(name: string, listener: () => void): void {
    const list = this.listeners.get(name) ?? [];
    this.listeners.set(
      name,
      list.filter((candidate) => candidate !== listener),
    );
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }

  closest(selector: string): FakeElement | null {
    const classNames = selector.split(",").map((part) => part.trim().replace(/^\./, ""));
    let node: FakeElement | null = this;
    while (node) {
      const nodeClasses = node.className.split(" ");
      if (classNames.some((className) => nodeClasses.includes(className))) return node;
      node = node.parent;
    }
    return null;
  }
}

class FakeDocument {
  readonly defaultView = {
    navigator: { platform: "Win32", clipboard: { writeText: async () => undefined } },
  };
  contentRoot: FakeElement | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function elementsWithClass(root: FakeElement, className: string): FakeElement[] {
  return descendants(root).filter((candidate) =>
    candidate.className.split(" ").includes(className),
  );
}

function buttonsWithLabel(root: FakeElement, label: string): FakeElement[] {
  return descendants(root).filter(
    (candidate) => candidate.tagName === "button" && candidate.textContent === label,
  );
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface FakeClient extends RendererPetsClient {
  readonly selectCalls: Array<string | null>;
}

function createFakeClient(
  initialSelection: { id: string | null; displayName?: string; spriteVersionNumber?: number } = {
    id: null,
  },
): FakeClient {
  const selectCalls: Array<string | null> = [];
  let selection = initialSelection;
  const names: Record<string, string> = { rush: "Rush", bsod: "BSOD" };
  return {
    selectCalls,
    catalog: async () => ({
      officialAvailable: true,
      petsDir: "/tmp/pets",
      data: [
        {
          id: "rush",
          displayName: "Rush",
          description: "installed pet",
          source: "installed",
          installed: true,
          spriteVersionNumber: 2,
        },
        {
          id: "bsod",
          displayName: "BSOD",
          description: "official preload",
          source: "official",
          installed: false,
        },
      ],
    }),
    community: async () => ({ data: [], total: 0, source: "online" }),
    preview: async (id: string) => ({ id, mime: "image/webp", dataBase64: "QUJD" }),
    install: async (params: { id: string }) => ({
      id: params.id,
      path: `/tmp/pets/${params.id}`,
      installed: true,
    }),
    uninstall: async (id: string) => ({ id, removed: true }),
    selection: async () => selection,
    select: async (id: string | null) => {
      selectCalls.push(id);
      selection = id === null ? { id: null } : { id, displayName: names[id] ?? id, spriteVersionNumber: 2 };
      return selection;
    },
  };
}

function mountPetPage(client: RendererPetsClient) {
  const document = new FakeDocument();
  const content = document.createElement("div");
  document.contentRoot = content;
  const page = createPetSettingsPage(rendererSettingsMessages("en"), () => client);
  const dispose = page.mount({
    content: content as unknown as HTMLElement,
    signal: new AbortController().signal,
    runLatest: async (operation, handlers) => {
      try {
        handlers.success(await operation(new AbortController().signal));
      } catch (error) {
        handlers.failure(error);
      }
    },
  });
  return { document, content, dispose };
}

describe("Pet market page official-pet switch flow", () => {
  it("switches the official pet from a card and mirrors it in the panel immediately", async () => {
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
    switchCalls.length = 0;
    switchBehavior = async () => {};
    try {
      const client = createFakeClient();
      const { content, dispose } = mountPetPage(client);
      await flush();

      // 初始：空态提示，无选中
      const panel = elementsWithClass(content, "pet-current")[0]!;
      expect(panel.dataset.active).toBe("false");
      expect(
        descendants(panel).some((el) => el.textContent.includes("No pet selected yet")),
      ).toBe(true);

      // 已安装的 rush 卡片上有 Use 按钮，未安装的 bsod 卡片上是 Install
      const rushCard = descendants(content).find((el) => el.dataset.petId === "rush")!;
      const bsodCard = descendants(content).find((el) => el.dataset.petId === "bsod")!;
      expect(buttonsWithLabel(rushCard, "Use")).toHaveLength(1);
      expect(buttonsWithLabel(bsodCard, "Use")).toHaveLength(0);
      expect(buttonsWithLabel(bsodCard, "Install Pet")).toHaveLength(1);

      // 点击 Use：先驱动官方设置切换，确认后写本地记录，面板立即更新并出现 Active 徽标
      buttonsWithLabel(rushCard, "Use")[0]!.dispatch("click");
      await flush();
      expect(switchCalls).toEqual([{ id: "rush", displayName: "Rush" }]);
      expect(client.selectCalls).toEqual(["rush"]);
      expect(panel.dataset.active).toBe("true");
      expect(descendants(panel).some((el) => el.textContent === "Rush")).toBe(true);
      // 面板注明它镜像的是 Codex 官方桌宠
      expect(
        descendants(panel).some((el) => el.textContent.includes("official pet")),
      ).toBe(true);

      const rushCardAfter = descendants(content).find((el) => el.dataset.petId === "rush")!;
      expect(
        elementsWithClass(rushCardAfter, "pet-card__badge--active").some(
          (el) => el.textContent === "Active",
        ),
      ).toBe(true);
      expect(buttonsWithLabel(rushCardAfter, "Use")).toHaveLength(0);

      // 清除本地记录（不影响官方 mascot 显隐，文案指向官方开关）
      buttonsWithLabel(panel, "Clear")[0]!.dispatch("click");
      await flush();
      expect(client.selectCalls).toEqual(["rush", null]);
      expect(panel.dataset.active).toBe("false");
      dispose?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a switch failure in the card when the official UI automation fails and allows retry", async () => {
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
    switchCalls.length = 0;
    let failNext = true;
    switchBehavior = async () => {
      if (failNext) {
        failNext = false;
        throw new Error("Pets entry not found in the Codex command menu");
      }
    };
    try {
      const client = createFakeClient();
      const { content, dispose } = mountPetPage(client);
      await flush();

      const rushCard = descendants(content).find((el) => el.dataset.petId === "rush")!;
      buttonsWithLabel(rushCard, "Use")[0]!.dispatch("click");
      await flush();

      // 官方 UI 自动化失败：本地记录不落盘，错误显示在卡片内
      const failedCard = descendants(content).find((el) => el.dataset.petId === "rush")!;
      expect(client.selectCalls).toEqual([]);
      expect(failedCard.dataset.state).toBe("failed");
      expect(
        descendants(failedCard).some((el) =>
          el.textContent.includes("Pets entry not found in the Codex command menu"),
        ),
      ).toBe(true);
      expect(descendants(failedCard).some((el) => el.textContent === "Switch failed")).toBe(true);

      // 重试成功后面板切换
      buttonsWithLabel(failedCard, "Retry")[0]!.dispatch("click");
      await flush();
      const panel = elementsWithClass(content, "pet-current")[0]!;
      expect(panel.dataset.active).toBe("true");
      expect(descendants(panel).some((el) => el.textContent === "Rush")).toBe(true);
      dispose?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears the panel when the active pet is uninstalled", async () => {
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
    switchCalls.length = 0;
    switchBehavior = async () => {};
    try {
      const client = createFakeClient();
      const { content, dispose } = mountPetPage(client);
      await flush();

      // 先选中 rush
      const rushCard = descendants(content).find((el) => el.dataset.petId === "rush")!;
      buttonsWithLabel(rushCard, "Use")[0]!.dispatch("click");
      await flush();
      expect(client.selectCalls).toEqual(["rush"]);
      const panel = elementsWithClass(content, "pet-current")[0]!;
      expect(panel.dataset.active).toBe("true");

      // 卸载当前选中的 rush：面板立即清空（本地记录被清除），卡片回到未安装态
      const selectedCard = descendants(content).find((el) => el.dataset.petId === "rush")!;
      buttonsWithLabel(selectedCard, "Uninstall")[0]!.dispatch("click");
      await flush();
      expect(panel.dataset.active).toBe("false");
      expect(
        descendants(panel).some((el) => el.textContent.includes("No pet selected yet")),
      ).toBe(true);
      const uninstalledCard = descendants(content).find((el) => el.dataset.petId === "rush")!;
      expect(uninstalledCard.dataset.installed).toBe("false");
      expect(elementsWithClass(uninstalledCard, "pet-card__badge--active")).toHaveLength(0);
      expect(buttonsWithLabel(uninstalledCard, "Use")).toHaveLength(0);
      dispose?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the Active badge on first paint when a selection already exists", async () => {
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
    switchCalls.length = 0;
    switchBehavior = async () => {};
    try {
      // catalog() 先于 selection() 返回时，卡片首次渲染必须随选择到位重渲染
      const client = createFakeClient({ id: "rush", displayName: "Rush", spriteVersionNumber: 2 });
      const { content, dispose } = mountPetPage(client);
      await flush();

      const panel = elementsWithClass(content, "pet-current")[0]!;
      expect(panel.dataset.active).toBe("true");
      expect(descendants(panel).some((el) => el.textContent === "Rush")).toBe(true);

      const rushCard = descendants(content).find((el) => el.dataset.petId === "rush")!;
      expect(
        elementsWithClass(rushCard, "pet-card__badge--active").some(
          (el) => el.textContent === "Active",
        ),
      ).toBe(true);
      expect(buttonsWithLabel(rushCard, "Use")).toHaveLength(0);
      expect(buttonsWithLabel(rushCard, "Uninstall")).toHaveLength(1);
      dispose?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
