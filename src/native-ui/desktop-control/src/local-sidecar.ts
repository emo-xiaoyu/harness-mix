import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface LocalSidecar {
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): () => void;
  close(): Promise<void>;
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
  const listeners = new Set<(frame: string) => void>();
  const pendingFrames: string[] = [];
  let failure: string | null = null;
  let closed = false;
  const publish = (frame: string): void => {
    if (listeners.size === 0) {
      if (pendingFrames.length < 256) pendingFrames.push(frame);
      else fail("Host output exceeded the startup buffer");
      return;
    }
    for (const listener of listeners) listener(frame);
  };
  const fail = (message: string): void => {
    if (closed || failure !== null) return;
    failure = message;
    publish(JSON.stringify({ harnessmixSidecarFailure: message }));
  };
  output.on("line", publish);
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
      listeners.add(listener);
      for (const frame of pendingFrames.splice(0)) listener(frame);
      if (failure !== null) listener(JSON.stringify({ harnessmixSidecarFailure: failure }));
      return () => listeners.delete(listener);
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
      listeners.clear();
    },
  };
}
