/**
 * Host sidecar process wrapper. The sidecar speaks newline-delimited JSON on
 * stdio; frames are buffered while no CDP listener is attached so a renderer
 * swap does not lose in-flight approval requests.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface LocalSidecar {
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): () => void;
  close(): Promise<void>;
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
): LocalSidecar {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESSMIX_STOCK_CODEX_PATH: stockCodexPath,
    HARNESSMIX_SIDECAR: "1",
  };
  delete env.CODEX_CLI_PATH;
  const child = spawn(nodePath, [scriptPath, "app-server", "--listen", "stdio://"], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const frames = createSidecarFrameBuffer();
  let failure: string | null = null;
  let closed = false;
  const recordFailure = (message: string): void => {
    if (closed || failure !== null) return;
    failure = message;
    frames.publish(JSON.stringify({ harnessmixSidecarFailure: message }));
  };
  lines.on("line", frames.publish);
  child.once("error", (error) => recordFailure(error.message));
  child.once("exit", (code) => recordFailure(`Host exited with code ${code ?? "unknown"}`));
  child.stdin.on("error", (error) => recordFailure(error.message));
  return {
    send(frame) {
      if (failure !== null) throw new Error(failure);
      if (closed) throw new Error("Host sidecar is closed");
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
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const giveUp = setTimeout(() => {
            child.kill();
            resolve();
          }, FAILURE_CLOSE_GRACE_MS);
          child.once("exit", () => {
            clearTimeout(giveUp);
            resolve();
          });
        });
      }
      lines.close();
      frames.clear();
    },
  };
}
