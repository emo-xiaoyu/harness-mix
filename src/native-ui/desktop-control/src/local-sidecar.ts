import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface LocalSidecar {
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): () => void;
  close(): Promise<void>;
}

export function createSidecarFrameBuffer(limit = 256): {
  publish(frame: string): void;
  onFrame(listener: (frame: string) => void): () => void;
  clear(): void;
} {
  const listeners = new Set<(frame: string) => void>();
  const pendingFrames: Array<{ frame: string; request: boolean }> = [];
  const isServerRequest = (frame: string): boolean => {
    try {
      const value: unknown = JSON.parse(frame);
      return typeof value === "object" && value !== null &&
        "id" in value && value.id !== undefined &&
        "method" in value && typeof value.method === "string";
    } catch {
      return false;
    }
  };
  return {
    publish(frame) {
      if (listeners.size === 0) {
        // A Renderer replacement can leave a busy Agent Team without a CDP
        // listener for a while. Its next thread/read reconstructs old state.
        // Preserve native approval/input requests; discard only older state
        // updates when the temporary queue fills.
        const request = isServerRequest(frame);
        if (pendingFrames.length >= limit) {
          const removable = pendingFrames.findIndex((entry) => !entry.request);
          if (removable >= 0) pendingFrames.splice(removable, 1);
          else if (!request) return;
        }
        pendingFrames.push({ frame, request });
        return;
      }
      for (const listener of listeners) listener(frame);
    },
    onFrame(listener) {
      listeners.add(listener);
      for (const entry of pendingFrames.splice(0)) listener(entry.frame);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
      pendingFrames.length = 0;
    },
  };
}

export function startLocalSidecar(nodePath: string, scriptPath: string, stockCodexPath: string): LocalSidecar {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HARNESSMIX_STOCK_CODEX_PATH: stockCodexPath, HARNESSMIX_SIDECAR: "1",
  };
  delete env.CODEX_CLI_PATH;
  const child = spawn(nodePath, [scriptPath, "app-server", "--listen", "stdio://"], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const output = createInterface({ input: child.stdout });
  const frames = createSidecarFrameBuffer();
  let failure: string | null = null;
  let closed = false;
  const fail = (message: string): void => {
    if (closed || failure !== null) return;
    failure = message;
    frames.publish(JSON.stringify({ harnessmixSidecarFailure: message }));
  };
  output.on("line", frames.publish);
  child.once("error", (error) => fail(error.message));
  child.once("exit", (code) => fail(`Host exited with code ${code ?? "unknown"}`));
  child.stdin.on("error", (error) => fail(error.message));
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
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill(); resolve(); }, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      output.close();
      frames.clear();
    },
  };
}
