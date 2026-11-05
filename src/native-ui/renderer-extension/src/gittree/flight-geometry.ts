// Light-flight geometry adapted from lancer's packages/light-ui (MIT, upstream
// pi-gui v1.0.1 — see lancer NOTICE). Pure math only: no DOM, no timers, so the
// arc/dash numbers stay unit-testable in a bare node environment.

export interface Point {
  readonly x: number;
  readonly y: number;
}
export type Cubic = readonly [Point, Point, Point, Point];

export const FLIGHT_SECONDS = 1.2;
export const LANDING_SECONDS = 0.6;

export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export const segment = (value: number, start: number, end: number) =>
  clamp((value - start) / (end - start));

export const smoothstep = (value: number) => value * value * (3 - 2 * value);

export function cubicEase(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let low = 0;
    let high = 1;
    let u = t;
    for (let index = 0; index < 22; index += 1) {
      u = (low + high) / 2;
      const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
      if (x < t) low = u;
      else high = u;
    }
    return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
  };
}

export const flightEase = smoothstep;
export const outEase = cubicEase(0.16, 1, 0.3, 1);

export function bezier(a: Point, c1: Point, c2: Point, b: Point, p: number): Point {
  const q = 1 - p;
  return {
    x: q * q * q * a.x + 3 * q * q * p * c1.x + 3 * q * p * p * c2.x + p * p * p * b.x,
    y: q * q * q * a.y + 3 * q * q * p * c1.y + 3 * q * p * p * c2.y + p * p * p * b.y,
  };
}

export const cubicPoint = (points: Cubic, t: number) => bezier(...points, t);

export const cubicPath = ([a, c, d, b]: Cubic) =>
  `M ${a.x} ${a.y} C ${c.x} ${c.y} ${d.x} ${d.y} ${b.x} ${b.y}`;

/** One emission seed chooses a stable arc; never randomize while advancing frames. */
export function flightControls(a: Point, b: Point, seed: number): readonly [Point, Point] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const variant = Math.min(3, Math.floor(seed * 4));
  const variation = (seed * 4) % 1;
  const amplitude = Math.min(180, length * (0.14 + variation * 0.12));
  const direction = variant % 2 === 0 ? -1 : 1;
  const control = (fraction: number, bend: number): Point => ({
    x: Math.max(8, a.x + dx * fraction - (dy / length) * bend),
    y: Math.max(8, a.y + dy * fraction + (dx / length) * bend),
  });
  return [
    control(0.25 + variation * 0.1, direction * amplitude),
    control(0.65 + variation * 0.1, direction * amplitude * (variant < 2 ? 0.8 : -0.8)),
  ];
}

function arcLength(points: Cubic, end: number): number {
  let length = 0;
  let previous = points[0];
  for (let index = 1; index <= 64; index += 1) {
    const next = cubicPoint(points, (end * index) / 64);
    length += Math.hypot(next.x - previous.x, next.y - previous.y);
    previous = next;
  }
  return length;
}

export interface FlightGeometry {
  /** Full-curve path (stable across frames). */
  readonly d: string;
  readonly head: number;
  readonly tailPoint: Point;
  readonly headPoint: Point;
  /** Arc length at the tail start; dashoffset = -start. */
  readonly start: number;
  /** dasharray = `${tail length} ${total + 1}`. */
  readonly dash: string;
  readonly total: number;
}

export function flightGeometry(points: Cubic, progress: number): FlightGeometry {
  const head = flightEase(clamp(progress));
  const tail = flightEase(segment(progress, 0.75, 1)) * 0.35;
  const tailPoint = cubicPoint(points, tail);
  const headPoint = cubicPoint(points, head);
  const start = arcLength(points, tail);
  const end = arcLength(points, head);
  const total = arcLength(points, 1);
  return {
    d: cubicPath(points),
    head,
    tailPoint,
    headPoint,
    start,
    dash: `${Math.max(0, end - start)} ${total + 1}`,
    total,
  };
}

export interface LandingGeometry {
  readonly radius: number;
  readonly opacity: number;
}

export function landingGeometry(age01: number): LandingGeometry {
  const eased = outEase(clamp(age01));
  return { radius: 5 + eased * 20, opacity: (1 - eased) * 0.5 };
}

/** Rail edge for tree branch lines: a vertical-ish cubic from child up to parent. */
export function branchPath(from: Point, to: Point): string {
  const midY = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${midY} ${to.x} ${midY} ${to.x} ${to.y}`;
}
