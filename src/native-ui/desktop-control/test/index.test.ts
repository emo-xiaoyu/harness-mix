import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";

describe("desktop-control package", () => {
  it("builds without implementing Desktop integration", () => {
    expect(packageMetadata).toEqual({
      name: "@harnessmix/desktop-control",
      contractVersion: 1,
    });
  });
});
