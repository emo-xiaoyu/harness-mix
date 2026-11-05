// Emission scheduling adapted from lancer's LiveEmissionClock: identity-diff
// over polled snapshots so a 1.5s polling pipeline can still drive "only new
// activity flies" light rays without a push channel. First observation is the
// baseline and never emits — loaded history must not masquerade as live work.

import { FLIGHT_SECONDS, LANDING_SECONDS } from "./flight-geometry.js";

export interface EmissionIdentityInput {
  readonly id: string;
  readonly status: string;
  readonly milestone?: string | number;
}

export interface EmissionFlight {
  readonly id: string;
  /** ms since flight start; grows past the window then the entry drops. */
  readonly elapsedMs: number;
}

const FLIGHT_WINDOW_MS = (FLIGHT_SECONDS + LANDING_SECONDS) * 1000;

const identityOf = (event: EmissionIdentityInput) =>
  `${event.id}:${event.status}:${event.milestone ?? ""}`;

export class GittreeEmissionClock {
  private seen = new Set<string>();
  private starts = new Map<string, number>();
  private seeds = new Map<string, number>();
  private initialized = false;

  constructor(private readonly random: () => number = Math.random) {}

  /** Feed the latest polled events; wall-clock via injectable now for tests. */
  observe(events: readonly EmissionIdentityInput[], now: number): void {
    for (const event of events) {
      if (!event.id) continue;
      const identity = identityOf(event);
      if (this.initialized && !this.seen.has(identity)) {
        this.starts.set(event.id, now);
        this.seeds.set(event.id, this.nextSeed());
      }
      this.seen.add(identity);
    }
    this.initialized = true;
  }

  private nextSeed(): number {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = this.random();
      if (Number.isFinite(value) && value >= 0 && value < 1) return value;
    }
    return 0.42;
  }

  /** Flights still inside the flight+landing window, dropping expired ids. */
  flights(now: number): readonly EmissionFlight[] {
    const active: EmissionFlight[] = [];
    for (const [id, start] of this.starts) {
      const elapsedMs = now - start;
      if (elapsedMs < FLIGHT_WINDOW_MS) active.push({ id, elapsedMs });
      else {
        this.starts.delete(id);
        this.seeds.delete(id);
      }
    }
    return active.sort((left, right) => left.elapsedMs - right.elapsedMs);
  }

  seedFor(id: string): number {
    return this.seeds.get(id) ?? 0.42;
  }

  reset(): void {
    this.seen.clear();
    this.starts.clear();
    this.seeds.clear();
    this.initialized = false;
  }
}
