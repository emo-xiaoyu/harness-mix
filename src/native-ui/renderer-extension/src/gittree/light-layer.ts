// Full-viewport light-flight layer for the GitTree panel. Rendering approach
// adapted from lancer's packages/light-ui (MIT, upstream pi-gui — see lancer
// NOTICE): one fixed overlay SVG, per-flight cubic bezier chosen by a stable
// seed, three strokes (two glow widths + a gradient main line) advanced with
// stroke-dasharray/offset from 64-segment arc-length integration, a landing
// ripple, zero animation frames while idle, and prefers-reduced-motion off.

import {
  FLIGHT_SECONDS,
  LANDING_SECONDS,
  clamp,
  cubicPath,
  flightControls,
  flightGeometry,
  landingGeometry,
  type Cubic,
  type Point,
} from "./flight-geometry.js";

export type GittreeAnchor = Element | Point | (() => Element | Point | null);

export interface GittreeFlight {
  readonly id: string;
  readonly from: GittreeAnchor;
  readonly to: GittreeAnchor;
  readonly color: string;
  readonly seed?: number;
}

export type GittreeFlightResult = "arrived" | "cancelled" | "missing-anchor";

export interface GittreeLightLayerControl {
  emit(flight: GittreeFlight): { finished: Promise<GittreeFlightResult>; cancel(): void };
  dispose(): void;
  readonly activeCount: number;
}

const MAX_FLIGHTS = 64;

interface Job {
  flight: GittreeFlight;
  elapsed: number;
  duration: number;
  seed: number;
  group: SVGGElement | null;
  gradient: SVGLinearGradientElement | null;
  ring: SVGCircleElement | null;
  resolved: boolean;
  resolve(result: GittreeFlightResult): void;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(
  ownerDocument: Document,
  name: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = ownerDocument.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function anchorPoint(anchor: GittreeAnchor, origin: Point): Point | null {
  const value = typeof anchor === "function" ? anchor() : anchor;
  if (!value) return null;
  if (value instanceof Element) {
    if (!value.isConnected) return null;
    const bounds = value.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return { x: bounds.x + bounds.width / 2 - origin.x, y: bounds.y + bounds.height / 2 - origin.y };
  }
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: value.x - origin.x, y: value.y - origin.y };
}

/** Inert fallback for document-less environments (node tests). */
const inertLayer = (): GittreeLightLayerControl => ({
  emit: () => ({ finished: Promise.resolve<GittreeFlightResult>("cancelled"), cancel: () => undefined }),
  dispose: () => undefined,
  activeCount: 0,
});

export function createGittreeLightLayer(ownerWindow: Window | null | undefined): GittreeLightLayerControl {
  const doc = ownerWindow?.document;
  if (!ownerWindow || !doc || !doc.body) return inertLayer();
  const svg = svgElement(doc, "svg", { "aria-hidden": "true", "data-harnessmix-gittree-lights": "" });
  Object.assign(svg.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "15",
  });
  doc.body.append(svg);
  const jobs = new Map<string, Job>();
  const reduced = ownerWindow.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let lastTick: number | undefined;
  let destroyed = false;
  let serial = 0;

  const settle = (job: Job, result: GittreeFlightResult) => {
    if (job.resolved) return;
    job.resolved = true;
    job.resolve(result);
  };
  const remove = (id: string, result: GittreeFlightResult) => {
    const job = jobs.get(id);
    if (!job) return;
    settle(job, result);
    job.group?.remove();
    job.ring?.remove();
    jobs.delete(id);
    if (jobs.size === 0) {
      ownerWindow.cancelAnimationFrame(frame);
      frame = 0;
      lastTick = undefined;
    }
  };
  const schedule = () => {
    if (frame || jobs.size === 0 || destroyed) return;
    frame = ownerWindow.requestAnimationFrame(draw);
  };
  const ensureGroup = (job: Job, points: Cubic, serialId: number) => {
    if (job.group && job.gradient) return;
    job.group?.remove();
    const group = svgElement(doc, "g");
    const gradientId = `harnessmix-gittree-flight-${serialId}`;
    const gradient = svgElement(doc, "linearGradient", {
      id: gradientId,
      gradientUnits: "userSpaceOnUse",
    });
    gradient.append(
      svgElement(doc, "stop", { offset: "0", "stop-color": job.flight.color, "stop-opacity": "0" }),
      svgElement(doc, "stop", { offset: "1", "stop-color": job.flight.color }),
    );
    group.append(gradient);
    const attributes = {
      d: cubicPath(points),
      fill: "none",
      stroke: job.flight.color,
      "stroke-linecap": "round",
    };
    for (const [width, opacity] of [
      [6, 0.07],
      [2.6, 0.13],
    ] as const) {
      group.append(svgElement(doc, "path", { ...attributes, "stroke-width": width, opacity }));
    }
    group.append(
      svgElement(doc, "path", {
        ...attributes,
        "stroke-width": 1.6,
        stroke: `url(#${gradientId})`,
        "data-harnessmix-flight-main": job.flight.id,
      }),
    );
    svg.append(group);
    job.group = group;
    job.gradient = gradient;
  };
  const draw = (now: number) => {
    frame = 0;
    if (destroyed) return;
    const delta = lastTick === undefined ? 0 : Math.max(0, now - lastTick);
    lastTick = now;
    const bounds = svg.getBoundingClientRect();
    const origin: Point = { x: bounds.x, y: bounds.y };
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    // Batch anchor reads before SVG writes to avoid layout thrashing.
    const anchors = new Map<Job, readonly [Point | null, Point | null]>();
    for (const job of jobs.values()) {
      anchors.set(job, [anchorPoint(job.flight.from, origin), anchorPoint(job.flight.to, origin)]);
    }
    for (const [id, job] of jobs) {
      const [from, to] = anchors.get(job) ?? [null, null];
      if (!from || !to) {
        remove(id, "missing-anchor");
        continue;
      }
      if (reduced.matches) {
        remove(id, "arrived");
        continue;
      }
      job.elapsed += delta;
      const controls = flightControls(from, to, job.seed);
      const points: Cubic = [from, controls[0], controls[1], to];
      if (job.elapsed < job.duration) {
        ensureGroup(job, points, ++serial);
        const geometry = flightGeometry(points, job.elapsed / job.duration);
        for (const path of job.group?.querySelectorAll("path") ?? []) {
          if (path.getAttribute("d") !== geometry.d) path.setAttribute("d", geometry.d);
          path.setAttribute("stroke-dasharray", geometry.dash);
          path.setAttribute("stroke-dashoffset", String(-geometry.start));
        }
        if (job.gradient) {
          for (const [key, value] of Object.entries({
            x1: geometry.tailPoint.x,
            y1: geometry.tailPoint.y,
            x2: geometry.headPoint.x,
            y2: geometry.headPoint.y,
          })) job.gradient.setAttribute(key, String(value));
        }
      } else {
        job.group?.remove();
        job.group = null;
        job.gradient = null;
        settle(job, "arrived");
        const age = clamp((job.elapsed - job.duration) / (LANDING_SECONDS * 1000));
        if (age >= 1) {
          remove(id, "arrived");
          continue;
        }
        if (!job.ring) {
          job.ring = svgElement(doc, "circle", {
            fill: "none",
            stroke: job.flight.color,
            "stroke-width": 1.2,
            "data-harnessmix-flight-landing": id,
          });
          svg.append(job.ring);
        }
        const landing = landingGeometry(age);
        job.ring.setAttribute("cx", String(to.x));
        job.ring.setAttribute("cy", String(to.y));
        job.ring.setAttribute("r", String(landing.radius));
        job.ring.setAttribute("opacity", String(landing.opacity));
      }
    }
    schedule();
  };
  const onVisibility = () => {
    if (doc.hidden) {
      ownerWindow.cancelAnimationFrame(frame);
      frame = 0;
      lastTick = undefined;
    } else schedule();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  reduced.addEventListener?.("change", schedule);

  return {
    emit(flight) {
      if (destroyed) throw new Error("Gittree light layer is disposed.");
      if (!flight.id || jobs.has(flight.id)) throw new Error("Flights need a unique id.");
      if (jobs.size >= MAX_FLIGHTS) {
        return { finished: Promise.resolve<GittreeFlightResult>("cancelled"), cancel: () => undefined };
      }
      const finished = new Promise<GittreeFlightResult>(resolve => {
        jobs.set(flight.id, {
          flight,
          elapsed: 0,
          duration: FLIGHT_SECONDS * 1000,
          seed: flight.seed ?? 0.42,
          group: null,
          gradient: null,
          ring: null,
          resolved: false,
          resolve,
        });
      });
      schedule();
      return { finished, cancel: () => remove(flight.id, "cancelled") };
    },
    dispose() {
      destroyed = true;
      ownerWindow.cancelAnimationFrame(frame);
      frame = 0;
      for (const id of [...jobs.keys()]) remove(id, "cancelled");
      doc.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener?.("change", schedule);
      svg.remove();
    },
    get activeCount() {
      return jobs.size;
    },
  };
}
