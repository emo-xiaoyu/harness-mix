import { describe, expect, it } from "vitest";

import { createRendererPetsClient } from "../../src/settings/pets-client.js";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

function recordingClient(response: unknown) {
  const calls: RecordedCall[] = [];
  const client = createRendererPetsClient(async (method, params) => {
    calls.push({ method, params });
    return response;
  });
  return { calls, client };
}

describe("RendererPetsClient", () => {
  it("requests the catalog", async () => {
    const { calls, client } = recordingClient({ data: [], officialAvailable: false, petsDir: "/tmp/pets" });
    const result = await client.catalog();
    expect(calls).toEqual([{ method: "harnessmix/pets/catalog", params: {} }]);
    expect(result.petsDir).toBe("/tmp/pets");
  });

  it("passes community query params through", async () => {
    const { calls, client } = recordingClient({ data: [], total: 0, source: "online" });
    await client.community({ page: 2, pageSize: 12, sort: "new", search: "cat" });
    expect(calls).toEqual([
      {
        method: "harnessmix/pets/community",
        params: { page: 2, pageSize: 12, sort: "new", search: "cat" },
      },
    ]);
  });

  it("loads a preview by id", async () => {
    const { calls, client } = recordingClient({ id: "rush", mime: "image/webp", dataBase64: "AA" });
    const result = await client.preview("rush");
    expect(calls).toEqual([{ method: "harnessmix/pets/preview", params: { id: "rush" } }]);
    expect(result.dataBase64).toBe("AA");
  });

  it("sends install params unchanged", async () => {
    const { calls, client } = recordingClient({ id: "rush", path: "/tmp/pets/rush", installed: true });
    await client.install({ id: "rush", displayName: "Rush", spriteVersionNumber: 2 });
    expect(calls).toEqual([
      {
        method: "harnessmix/pets/install",
        params: { id: "rush", displayName: "Rush", spriteVersionNumber: 2 },
      },
    ]);
  });

  it("uninstalls by id", async () => {
    const { calls, client } = recordingClient({ id: "rush", removed: true });
    const result = await client.uninstall("rush");
    expect(calls).toEqual([{ method: "harnessmix/pets/uninstall", params: { id: "rush" } }]);
    expect(result.removed).toBe(true);
  });

  it("requests the current selection", async () => {
    const { calls, client } = recordingClient({ id: "rush", displayName: "Rush", spriteVersionNumber: 2 });
    const result = await client.selection();
    expect(calls).toEqual([{ method: "harnessmix/pets/selection", params: {} }]);
    expect(result).toEqual({ id: "rush", displayName: "Rush", spriteVersionNumber: 2 });
  });

  it("selects a pet by id", async () => {
    const { calls, client } = recordingClient({ id: "rush", displayName: "Rush" });
    const result = await client.select("rush");
    expect(calls).toEqual([{ method: "harnessmix/pets/select", params: { id: "rush" } }]);
    expect(result.id).toBe("rush");
  });

  it("clears the selection with null", async () => {
    const { calls, client } = recordingClient({ id: null });
    const result = await client.select(null);
    expect(calls).toEqual([{ method: "harnessmix/pets/select", params: { id: null } }]);
    expect(result.id).toBeNull();
  });
});
