import { describe, expect, it } from "vitest";
import {
  branchPath,
  cubicPath,
  flightControls,
  flightGeometry,
  landingGeometry,
  segment,
  smoothstep,
} from "../src/gittree/flight-geometry.js";

describe("gittree flight geometry", () => {
  it("keeps arcs stable per seed and distinct across variants", () => {
    const a = { x: 10, y: 10 };
    const b = { x: 300, y: 200 };
    const first = flightControls(a, b, 0.3);
    const again = flightControls(a, b, 0.3);
    expect(first).toEqual(again);
    const other = flightControls(a, b, 0.8);
    expect(other).not.toEqual(first);
  });

  it("caps control-point amplitude at 180px regardless of length", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 5000, y: 0 };
    for (const [control] of [flightControls(a, b, 0.99)]) {
      const offset = Math.abs(control.y - a.y);
      expect(offset).toBeLessThanOrEqual(181);
    }
  });

  it("advances the comet tail with monotone dash offsets", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 0 };
    const controls = flightControls(a, b, 0.25);
    const points = [a, controls[0], controls[1], b] as const;
    const early = flightGeometry(points, 0.2);
    const mid = flightGeometry(points, 0.5);
    const end = flightGeometry(points, 0.99);
    expect(early.d).toBe(cubicPath(points));
    expect(mid.head).toBeGreaterThan(early.head);
    expect(end.head).toBeGreaterThan(mid.head);
    // Early flight shows only the head stub (tail parked at the source).
    expect(early.start).toBe(0);
    // The visible segment grows as the tail starts chasing after 75%.
    const visibleEarly = Number(early.dash.split(" ")[0]);
    const visibleEnd = Number(end.dash.split(" ")[0]);
    expect(visibleEnd).toBeGreaterThan(visibleEarly);
    // At arrival the dark gap is the 35% tail parameter, so ~65% stays lit.
    const visibleFraction = visibleEnd / end.total;
    expect(visibleFraction).toBeGreaterThan(0.5);
    expect(visibleFraction).toBeLessThan(0.75);
  });

  it("clamps progress and eases the landing ripple out", () => {
    expect(smoothstep(segment(0.75, 0.75, 1))).toBe(0);
    const early = landingGeometry(0);
    const late = landingGeometry(1);
    expect(early.radius).toBeLessThan(late.radius);
    expect(late.opacity).toBe(0);
  });

  it("renders branch rails as vertical cubics", () => {
    expect(branchPath({ x: 40, y: 100 }, { x: 10, y: 20 })).toBe(
      "M 40 100 C 40 60 10 60 10 20",
    );
  });
});
