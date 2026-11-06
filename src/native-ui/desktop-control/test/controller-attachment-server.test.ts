import { createConnection, createServer } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { startControllerAttachmentServer } from "../src/controller-attachment-server.js";

const nonce = "0123456789abcdef0123456789abcdef";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP address unavailable");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function request(port: number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("connect", () => socket.write(line));
  });
}

describe("Controller attachment server", () => {
  it("accepts only the exact nonce and invokes the attachment callback", async () => {
    const port = await availablePort();
    const attach = vi.fn(async () => {});
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach,
    });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
      await expect(request(port, `ATTACH ${"0".repeat(32)}\n`)).resolves.toBe("rejected\n");
      expect(attach).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("rejects the retired compatibility update command", async () => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
    });
    try {
      await expect(request(port, `COMPATIBILITY_UPDATE ${nonce}\n`)).resolves.toBe("rejected\n");
    } finally {
      await server.close();
    }
  });

  it("reports callback failure without exposing its error", async () => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {
        throw new Error("private detail");
      },
    });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("failed\n");
    } finally {
      await server.close();
    }
  });

  // Regression: the idle-reap timer used to destroy the socket while a slow
  // attach() was still in flight, so the Desktop main process saw the
  // connection close without ever receiving ready/rejected/failed.
  it("delivers the verdict even when attach outlasts the idle window", async () => {
    const port = await availablePort();
    const settle = new Promise<void>((resolve) => setTimeout(resolve, 200));
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: () => settle,
      idleTimeoutMs: 50,
    });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
    } finally {
      await server.close();
    }
  });

  // Regression: a client that RSTs mid-conversation used to raise an unhandled
  // 'error' on the server-side socket and crash the whole controller.
  it("survives an abrupt client reset and keeps serving", async () => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const done = () => { socket.removeAllListeners(); resolve(); };
        socket.once("error", done);
        socket.once("connect", () => {
          socket.write(`ATTACH ${nonce}\n`, () => {
            // Real RST, not a graceful FIN — the shape that triggers ECONNRESET.
            socket.resetAndDestroy?.() ?? socket.destroy();
            setTimeout(done, 150);
          });
        });
        setTimeout(() => reject(new Error("reset probe never connected")), 3000);
      });
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
    } finally {
      await server.close();
    }
  });

  it("rejects the retired Desktop quit command", async () => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
    });
    try {
      await expect(request(port, `SHUTDOWN ${nonce}\n`)).resolves.toBe("rejected\n");
    } finally {
      await server.close();
    }
  });
});
