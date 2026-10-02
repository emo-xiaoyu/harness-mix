import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  createSidecarFrameBuffer,
  startLocalSidecar,
  type SidecarChildProcess,
} from "../src/local-sidecar.js";

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

/** Minimal ChildProcess stand-in: readable stdout, writable stdin, exit/error events. */
function fakeHostChild(): SidecarChildProcess & { emitExit(code: number): void } {
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const child = emitter as unknown as SidecarChildProcess & { emitExit(code: number): void };
  child.stdout = stdout;
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.exitCode = 1;
    emitter.emit("exit", 1, null);
  };
  child.emitExit = (code: number) => {
    child.exitCode = code;
    emitter.emit("exit", code, null);
  };
  return child;
}

function supervisedSidecar(children: SidecarChildProcess[], restartDelays = [100]) {
  let spawnIndex = 0;
  const sidecar = startLocalSidecar("node", "host.cjs", "codex.cmd", {
    spawnChild: (() => {
      const child = children[spawnIndex];
      spawnIndex += 1;
      return child as never;
    }) as never,
    restartDelays,
    stableUptimeMs: 60_000,
  });
  return { sidecar, spawnCount: () => spawnIndex };
}

describe("local sidecar Host supervision", () => {
  it("respawns the Host after an unexpected exit and unblocks send()", async () => {
    vi.useFakeTimers();
    try {
      const first = fakeHostChild();
      const second = fakeHostChild();
      const { sidecar, spawnCount } = supervisedSidecar([first, second]);
      expect(spawnCount()).toBe(1);

      const received: string[] = [];
      sidecar.onFrame((frame) => received.push(frame));
      first.emitExit(1);
      expect(received).toEqual([
        JSON.stringify({ harnessmixSidecarFailure: "Host exited with code 1" }),
      ]);
      // Backoff window: send() keeps failing fast so renderer ladders retry.
      expect(() => sidecar.send("{}")).toThrow("Host exited with code 1");

      await vi.advanceTimersByTimeAsync(100);
      expect(spawnCount()).toBe(2);
      expect(() => sidecar.send("{}")).not.toThrow();
      second.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(received.at(-1)).toBe(JSON.stringify({ id: 1, result: {} }));
      second.emitExit(0);
      await sidecar.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not respawn after a deliberate close()", async () => {
    vi.useFakeTimers();
    try {
      const first = fakeHostChild();
      const { sidecar, spawnCount } = supervisedSidecar([first]);
      void sidecar.close();
      first.emitExit(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnCount()).toBe(1);
      expect(() => sidecar.send("{}")).toThrow("Host sidecar is closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates the backoff ladder and resets it after a stable run", async () => {
    vi.useFakeTimers();
    try {
      const first = fakeHostChild();
      const second = fakeHostChild();
      const third = fakeHostChild();
      const { sidecar, spawnCount } = supervisedSidecar([first, second, third], [100, 1_000]);
      first.emitExit(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(spawnCount()).toBe(2);
      // Second death advances the ladder: 100ms is no longer enough.
      second.emitExit(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(spawnCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(900);
      expect(spawnCount()).toBe(3);
      void sidecar.close();
      third.emitExit(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
