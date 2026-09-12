import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ setAttribute: vi.fn(), append: vi.fn() }),
  createRendererSettingsBrandIcon: () => ({ setAttribute: vi.fn(), append: vi.fn() }),
  isRendererSettingsIconName: () => true,
}));
import {
  HARNESS_INSTALL_COMMANDS,
  createConnectionsSettingsPage,
  type RendererConnectionDiagnostics,
  type RendererConnectionSnapshot,
} from "../../src/settings/connections-page.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { KNOWN_RENDERER_AGENTS, type ExternalRendererAgent } from "../../src/agent-selection-state.js";
import { installRendererSettingsLifecycle } from "../../src/harness-mix-settings.js";

describe("Harness Mix Settings & Model Configuration", () => {
  it("provides known install commands without guessing npm packages for native CLIs", () => {
    const externalAgents = KNOWN_RENDERER_AGENTS.filter(
      (agent): agent is ExternalRendererAgent => agent !== "codex",
    );
    for (const agent of externalAgents) {
      if (['kiro-cli', 'cursor-cli', 'codebuddy', 'zcode', 'trae'].includes(agent)) {
        expect(HARNESS_INSTALL_COMMANDS[agent]).toBeUndefined();
        continue;
      }
      expect(HARNESS_INSTALL_COMMANDS[agent]).toBeDefined();
      expect(typeof HARNESS_INSTALL_COMMANDS[agent]?.command).toBe("string");
      expect(HARNESS_INSTALL_COMMANDS[agent]?.command.length).toBeGreaterThan(0);
    }
  });

  it("installs settings lifecycle and registers keyboard shortcut Ctrl+,", () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const ownerWindow = {
      navigator: { languages: ["zh-CN"] },
      document: {
        body: { append: vi.fn() },
        createElement: (tag: string) => {
          const el = {
            tagName: tag,
            style: {},
            dataset: {},
            children: [] as unknown[],
            setAttribute: vi.fn(),
            removeAttribute: vi.fn(),
            append: vi.fn(),
            appendChild: vi.fn(),
            replaceChildren: vi.fn(),
            attachShadow: vi.fn(() => ({ append: vi.fn() })),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            remove: vi.fn(),
          };
          return el;
        },
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn(() => []),
        defaultView: undefined as unknown as Window,
      },
      addEventListener: vi.fn((event: string, cb: (event: KeyboardEvent) => void) => {
        listeners.set(event, cb);
      }),
      removeEventListener: vi.fn((event: string) => {
        listeners.delete(event);
      }),
    } as unknown as Window;
    (ownerWindow.document as unknown as { defaultView: Window }).defaultView = ownerWindow;

    const lifecycle = installRendererSettingsLifecycle(ownerWindow, {});
    expect(lifecycle.locale).toBe("zh-CN");
    expect(ownerWindow.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));

    lifecycle.dispose();
    expect(ownerWindow.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("includes model configuration and one-click install in messages", () => {
    const zh = rendererSettingsMessages("zh-CN");
    const en = rendererSettingsMessages("en");

    expect(zh.modelConfigurationTitle).toBe("模型与思考档位配置");
    expect(zh.oneClickInstall).toBe("一键安装");
    expect(zh.saveModelPreference).toBe("设为新会话默认");

    expect(en.modelConfigurationTitle).toBe("Model & Thinking Configuration");
    expect(en.oneClickInstall).toBe("One-Click Install");
    expect(en.saveModelPreference).toBe("Save as Default for New Threads");
  });
});
