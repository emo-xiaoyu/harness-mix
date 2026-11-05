import { describe, expect, it } from "vitest";
import { GittreeEmissionClock } from "../src/gittree/emission-clock.js";

describe("gittree emission clock", () => {
  it("treats the first observation as baseline and never emits history", () => {
    const clock = new GittreeEmissionClock(() => 0.5);
    clock.observe([{ id: "e1", status: "spawn" }], 1000);
    expect(clock.flights(1100)).toHaveLength(0);
  });

  it("emits only for identities unseen in the baseline", () => {
    const clock = new GittreeEmissionClock(() => 0.5);
    clock.observe([{ id: "e1", status: "spawn", milestone: "t1" }], 1000);
    clock.observe([{ id: "e1", status: "spawn", milestone: "t1" }], 2500);
    expect(clock.flights(2600)).toHaveLength(0);
    clock.observe(
      [
        { id: "e1", status: "spawn", milestone: "t1" },
        { id: "e2", status: "settle", milestone: "t1" },
      ],
      4000,
    );
    const flights = clock.flights(4100);
    expect(flights.map(flight => flight.id)).toEqual(["e2"]);
    expect(flights[0].elapsedMs).toBe(100);
  });

  it("re-emits when an existing id changes status", () => {
    const clock = new GittreeEmissionClock(() => 0.5);
    clock.observe([{ id: "task", status: "spawn" }], 1000);
    clock.observe([{ id: "task", status: "settle" }], 2000);
    expect(clock.flights(2100).map(flight => flight.id)).toEqual(["task"]);
  });

  it("drops flights after the flight+landing window", () => {
    const clock = new GittreeEmissionClock(() => 0.5);
    clock.observe([{ id: "a", status: "spawn" }], 0);
    clock.observe([{ id: "a", status: "settle" }], 2000);
    expect(clock.flights(2000 + 1799)).toHaveLength(1);
    expect(clock.flights(2000 + 1801)).toHaveLength(0);
  });

  it("recycles seeds per id and resets cleanly", () => {
    const clock = new GittreeEmissionClock(() => 0.25);
    clock.observe([{ id: "a", status: "spawn" }], 0);
    clock.observe([{ id: "a", status: "settle" }], 100);
    expect(clock.seedFor("a")).toBe(0.25);
    expect(clock.seedFor("missing")).toBeGreaterThan(0);
    clock.reset();
    clock.observe([{ id: "a", status: "settle" }], 200);
    expect(clock.flights(300)).toHaveLength(0);
  });
});
