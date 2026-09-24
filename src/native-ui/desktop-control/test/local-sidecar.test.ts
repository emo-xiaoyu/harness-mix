import { describe, expect, it } from "vitest";

import { createSidecarFrameBuffer } from "../src/local-sidecar.js";

describe("local sidecar frame delivery", () => {
  it("keeps the Host usable when an active Team outpaces a detached Renderer", () => {
    const frames = createSidecarFrameBuffer();
    for (let index = 0; index < 300; index += 1) frames.publish(`event-${index}`);

    const received: string[] = [];
    const unsubscribe = frames.onFrame((frame) => received.push(frame));
    expect(received).toHaveLength(256);
    expect(received[0]).toBe("event-44");
    expect(received.at(-1)).toBe("event-299");

    frames.publish("ownership-response");
    expect(received.at(-1)).toBe("ownership-response");
    unsubscribe();

    frames.publish("team-update-after-detach");
    const nextRenderer: string[] = [];
    frames.onFrame((frame) => nextRenderer.push(frame));
    expect(nextRenderer).toEqual(["team-update-after-detach"]);
  });

  it("retains a native approval request while older Team notifications overflow", () => {
    const frames = createSidecarFrameBuffer(3);
    const approval = JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval" });
    frames.publish(approval);
    for (let index = 0; index < 8; index += 1) frames.publish(`team-event-${index}`);

    const received: string[] = [];
    frames.onFrame((frame) => received.push(frame));
    expect(received).toEqual([approval, "team-event-6", "team-event-7"]);
  });
});
