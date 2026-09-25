/**
 * One-shot loopback TCP gate the Desktop main process uses to ask the
 * controller to (re)attach: send `ATTACH <nonce>\n`, receive exactly one of
 * `ready`, `rejected` or `failed`. The nonce is the shared secret minted by
 * the launcher for this boot.
 */
import { createServer, type Server, type Socket } from "node:net";

const MAX_REQUEST_BYTES = 96;
const IDLE_TIMEOUT_MS = 5_000;

export interface ControllerAttachmentServer {
  close(): Promise<void>;
}

export interface StartControllerAttachmentServerOptions {
  port: number;
  nonce: string;
  attach(): Promise<void>;
}

const isPort = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= 65_535;
const isNonce = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const reply = (socket: Socket, verdict: "ready" | "rejected" | "failed"): void => {
  socket.end(`${verdict}\n`);
};

export async function startControllerAttachmentServer(
  options: StartControllerAttachmentServerOptions,
): Promise<ControllerAttachmentServer> {
  if (!isPort(options.port)) throw new Error("attachment port must be a valid TCP port");
  if (!isNonce(options.nonce)) {
    throw new Error("attachment nonce must be 32 lowercase hexadecimal characters");
  }

  const live = new Set<Socket>();
  const server = createServer((socket) => {
    live.add(socket);
    socket.once("close", () => live.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    let answered = false;
    socket.on("data", (chunk: string) => {
      if (answered) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        answered = true;
        reply(socket, "rejected");
        return;
      }
      const terminator = buffer.indexOf("\n");
      if (terminator < 0) return;
      answered = true;
      const request = buffer.slice(0, terminator).replace(/\r$/, "");
      if (request === `ATTACH ${options.nonce}`) {
        void options.attach().then(
          () => reply(socket, "ready"),
          () => reply(socket, "failed"),
        );
        return;
      }
      reply(socket, "rejected");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of live) socket.destroy();
      await closeServer(server);
    },
  };
}
