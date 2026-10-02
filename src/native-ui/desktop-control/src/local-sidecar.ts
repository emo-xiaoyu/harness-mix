/**
 * Host sidecar process wrapper. The sidecar speaks newline-delimited JSON on
 * stdio; frames are buffered while no CDP listener is attached so a renderer
 * swap does not lose in-flight approval requests.
 *
 * The child is supervised: after an unexpected exit the Host is respawned on a
 * bounded backoff ladder. A dead sidecar used to latch permanently — every
 * later `send()` threw forever, so an idle Desktop that outlived its Host
 * (sleep, crash, OS reaping) could never load model catalogs or settle turns
 * again without a full app restart.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface LocalSidecar {
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): () => void;
  close(): Promise<void>;
}

/** Test seam: the minimal child-process surface the supervisor relies on. */
export interface SidecarChildProcess {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  exitCode: number | null;
  signalCode: string | null;
  kill(): void;
}

export interface LocalSidecarOptions {
  spawnChild?: typeof spawn;
  restartDelays?: readonly number[];
  stableUptimeMs?: number;
}

/**
 * Frame buffer with request protection: when no listener is attached, frames
 * queue up to `limit`; once full, ordinary state updates are dropped first so
 * native approval/input requests (`{id, method}` frames) survive.
 */
export function createSidecarFrameBuffer(limit = 256): {
  publish(frame: string): void;
  onFrame(listener: (frame: string) => void): () => void;
  clear(): void;
} {
  const listeners = new Set<(frame: string) => void>();
  const queued: Array<{ frame: string; isRequest: boolean }> = [];
  const looksLikeRequest = (frame: string): boolean => {
    try {
      const value: unknown = JSON.parse(frame);
      return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        (value as Record<string, unknown>).id !== undefined &&
        "method" in value &&
        typeof (value as Record<string, unknown>).method === "string"
      );
    } catch {
      return false;
    }
  };
  return {
    publish(frame) {
      if (listeners.size > 0) {
        for (const listener of listeners) listener(frame);
        return;
      }
      const isRequest = looksLikeRequest(frame);
      if (queued.length >= limit) {
        const droppable = queued.findIndex((entry) => !entry.isRequest);
        if (droppable >= 0) queued.splice(droppable, 1);
        else if (!isRequest) return;
      }
      queued.push({ frame, isRequest });
    },
    onFrame(listener) {
      listeners.add(listener);
      for (const entry of queued.splice(0)) listener(entry.frame);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
      queued.length = 0;
    },
  };
}

const FAILURE_CLOSE_GRACE_MS = 5_000;

export function startLocalSidecar(
  nodePath: string,
  scriptPath: string,
  stockCodexPath: string,
  options: LocalSidecarOptions = {},
): LocalSidecar {
  const spawnChild = options.spawnChild ?? spawn;
  // Backoff between Host respawns after unexpected exits. The ladder caps out
  // and resets once a child has stayed up past `stableUptimeMs`, so a Host that
  // dies repeatedly degrades to one restart attempt per minute instead of a
  // tight respawn loop.
  const restartDelays =
    options.restartDelays ?? [500, 2_000, 10_000, 30_000, 60_000];
  const stableUptimeMs = options.stableUptimeMs ?? 60_000;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESSMIX_STOCK_CODEX_PATH: stockCodexPath,
    HARNESSMIX_SIDECAR: "1",
  };
  delete env.CODEX_CLI_PATH;
  const frames = createSidecarFrameBuffer();
  let failure: string | null = null;
  let closed = false;
  let child: SidecarChildProcess | null = null;
  let lines: ReturnType<typeof createInterface> | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let restartAttempt = 0;
  const spawnHost = (): void => {
    const current = spawnChild(
      nodePath,
      [scriptPath, "app-server", "--listen", "stdio://"],
      {
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "inherit"],
      },
    ) as unknown as SidecarChildProcess;
    const startedAt = Date.now();
    child = current;
    failure = null;
    lines = createInterface({ input: current.stdout });
    lines.on("line", frames.publish);
    let terminated = false;
    const handleExit = (message: string): void => {
      if (closed || terminated || child !== current) return;
      terminated = true;
      failure = message;
      frames.publish(JSON.stringify({ harnessmixSidecarFailure: message }));
      lines?.close();
      // EPIPE races: stdin errors and exit can both fire for one death; only
      // the first schedules the respawn.
      if (Date.now() - startedAt >= stableUptimeMs) restartAttempt = 0;
      const delay = restartDelays[Math.min(restartAttempt, restartDelays.length - 1)];
      restartAttempt += 1;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!closed) spawnHost();
      }, delay);
    };
    current.once("exit", (code) =>
      handleExit(`Host exited with code ${code ?? "unknown"}`));
    current.once("error", (error) =>
      handleExit(`Host failed to start: ${error.message}`));
    current.stdin.on("error", (error) =>
      handleExit(`Host stdin failed: ${error.message}`));
  };
  spawnHost();
  return {
    send(frame) {
      if (failure !== null) throw new Error(failure);
      if (closed || child === null) throw new Error("Host sidecar is closed");
      child.stdin.write(`${frame}\n`);
    },
    onFrame(listener) {
      const unsubscribe = frames.onFrame(listener);
      if (failure !== null) listener(JSON.stringify({ harnessmixSidecarFailure: failure }));
      return unsubscribe;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const exiting = child;
      if (exiting !== null) {
        exiting.stdin.end();
        if (exiting.exitCode === null && exiting.signalCode === null) {
          await new Promise<void>((resolve) => {
            const giveUp = setTimeout(() => {
              exiting.kill();
              resolve();
            }, FAILURE_CLOSE_GRACE_MS);
            exiting.once("exit", () => {
              clearTimeout(giveUp);
              resolve();
            });
          });
        }
      }
      lines?.close();
      frames.clear();
    },
  };
}
