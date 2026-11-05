import { describe, expect, it } from "vitest";
import { GITTREE_PANEL_ATTRIBUTE, GITTREE_TRIGGER_ATTRIBUTE, installGittreePanel } from "../src/gittree/panel.js";
import { createGittreeLightLayer } from "../src/gittree/light-layer.js";

describe("gittree panel without a DOM", () => {
  it("installs to an inert control when document is unavailable", () => {
    const control = installGittreePanel({
      listManagedThreads: async () => [],
      listSidebarThreads: async () => [],
      inspectActiveTeam: async () => null,
      activeThreadId: () => null,
      openThread: () => undefined,
      ownerWindow: undefined,
    });
    expect(control.isOpen).toBe(false);
    expect(() => {
      control.open();
      control.toggle();
      control.refresh();
      control.close();
    }).not.toThrow();
    control.dispose();
  });

  it("exposes stable attributes for contract scans", () => {
    expect(GITTREE_PANEL_ATTRIBUTE).toBe("data-harnessmix-gittree-panel");
    expect(GITTREE_TRIGGER_ATTRIBUTE).toBe("data-harnessmix-gittree-trigger");
  });
});

describe("gittree light layer without a DOM", () => {
  it("degrades to an inert layer with resolved flights", async () => {
    const layer = createGittreeLightLayer(undefined);
    const flight = layer.emit({ id: "f1", from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, color: "#fff" });
    await expect(flight.finished).resolves.toBe("cancelled");
    expect(layer.activeCount).toBe(0);
    expect(() => layer.dispose()).not.toThrow();
  });

  it.runIf(typeof document !== "undefined")("rejects duplicate flight ids", async () => {
    const layer = createGittreeLightLayer(window);
    const first = layer.emit({ id: "dup", from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, color: "#fff" });
    expect(() => layer.emit({ id: "dup", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, color: "#fff" })).toThrow();
    first.cancel();
    layer.dispose();
  });
});
