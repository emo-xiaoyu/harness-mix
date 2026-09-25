/**
 * Minimal Chrome DevTools Protocol client over WebSocket plus the HTTP
 * discovery endpoints (`/json/version`, `/json/list`). Every endpoint is
 * pinned to loopback: the Desktop debugging port must never be reachable
 * off-box, and neither may a malicious page redirect us to a remote socket.
 */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpBrowserVersion {
  browser: string;
  protocolVersion: string;
  webSocketDebuggerUrl: string;
}

export interface CdpFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type CdpFetch = (url: string) => Promise<CdpFetchResponse>;

interface SocketEvent {
  data?: unknown;
}

/** Subset of the WebSocket surface the client relies on (injectable for tests). */
interface Socket {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: SocketEvent) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: SocketEvent) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export type CdpSocketFactory = (url: string) => Socket;

export interface CdpClientOptions {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  socketFactory?: CdpSocketFactory;
}

export type CdpEventListener = (params: unknown, sessionId: string | undefined) => void;

interface AwaitedCommand {
  settle(error: Error): void;
  settle(value: unknown): void;
  timer: NodeJS.Timeout;
}

interface WireResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CDP target '${field}' must be non-empty text`);
  }
  return value;
}

function endpointUrl(value: string, protocols: readonly string[]): URL {
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) {
    throw new Error(`CDP endpoint must use ${protocols.join(" or ")}`);
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error("CDP endpoint must use a loopback host");
  }
  return url;
}

function decodeTarget(value: unknown): CdpTarget {
  if (!isRecord(value)) throw new Error("CDP target must be an object");
  const target: CdpTarget = {
    id: requiredText(value.id, "id"),
    type: requiredText(value.type, "type"),
    title: typeof value.title === "string" ? value.title : "",
    url: requiredText(value.url, "url"),
    webSocketDebuggerUrl: requiredText(value.webSocketDebuggerUrl, "webSocketDebuggerUrl"),
  };
  endpointUrl(target.webSocketDebuggerUrl, ["ws:", "wss:"]);
  return target;
}

const plainFetch: CdpFetch = (url) => fetch(url);

const browserSocket: CdpSocketFactory = (url) => new WebSocket(url) as unknown as Socket;

function frameToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new Error("CDP WebSocket returned a non-text message");
}

function asWireResponse(value: unknown): WireResponse | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  const response: WireResponse = { id: value.id };
  if ("result" in value) response.result = value.result;
  if (isRecord(value.error)) {
    response.error = {
      ...(typeof value.error.code === "number" ? { code: value.error.code } : {}),
      ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
    };
  }
  return response;
}

export async function getCdpBrowserVersion(
  endpoint: string,
  fetchImpl: CdpFetch = plainFetch,
): Promise<CdpBrowserVersion> {
  const base = endpointUrl(endpoint, ["http:", "https:"]);
  const response = await fetchImpl(new URL("/json/version", base).toString());
  if (!response.ok) throw new Error(`CDP version discovery failed with HTTP ${response.status}`);
  const value = await response.json();
  if (!isRecord(value)) throw new Error("CDP version discovery did not return an object");
  const version = {
    browser: requiredText(value.Browser, "Browser"),
    protocolVersion: requiredText(value["Protocol-Version"], "Protocol-Version"),
    webSocketDebuggerUrl: requiredText(value.webSocketDebuggerUrl, "webSocketDebuggerUrl"),
  };
  endpointUrl(version.webSocketDebuggerUrl, ["ws:", "wss:"]);
  return version;
}

export async function listCdpTargets(
  endpoint: string,
  fetchImpl: CdpFetch = plainFetch,
): Promise<CdpTarget[]> {
  const base = endpointUrl(endpoint, ["http:", "https:"]);
  const response = await fetchImpl(new URL("/json/list", base).toString());
  if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("CDP target discovery did not return an array");
  return value.map(decodeTarget);
}

/** Polls `/json/list` until a Codex renderer page (app:// origin) appears. */
export async function waitForRendererTarget(
  endpoint: string,
  options: { fetchImpl?: CdpFetch; pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<CdpTarget> {
  const fetchImpl = options.fetchImpl ?? plainFetch;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const renderer = (await listCdpTargets(endpoint, fetchImpl)).find(
        (target) => target.type === "page" && target.url.startsWith("app://"),
      );
      if (renderer) return renderer;
      lastFailure = new Error("CDP has no app:// page target");
    } catch (error) {
      lastFailure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const detail = lastFailure instanceof Error ? `: ${lastFailure.message}` : "";
  throw new Error(`Codex Renderer CDP target did not become ready${detail}`);
}

export class CdpClient {
  readonly #commandTimeoutMs: number;
  readonly #socket: Socket;
  #closed = false;
  #ids = 0;
  #awaiting = new Map<number, AwaitedCommand>();
  #listeners = new Map<string, Set<CdpEventListener>>();

  private constructor(socket: Socket, commandTimeoutMs: number) {
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener("message", (event) => this.#dispatch(event));
    socket.addEventListener("error", () => this.#rejectAll(new Error("CDP WebSocket failed")));
    socket.addEventListener("close", () => this.#rejectAll(new Error("CDP WebSocket closed")));
  }

  static async connect(url: string, options: CdpClientOptions = {}): Promise<CdpClient> {
    endpointUrl(url, ["ws:", "wss:"]);
    const socket = (options.socketFactory ?? browserSocket)(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        detach();
        socket.close();
        reject(new Error("CDP WebSocket connection timed out"));
      }, options.connectTimeoutMs ?? 10_000);
      const opened = (): void => {
        detach();
        resolve();
      };
      const failed = (): void => {
        detach();
        reject(new Error("CDP WebSocket connection failed"));
      };
      const detach = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
      };
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
    });
    return new CdpClient(socket, options.commandTimeoutMs ?? 10_000);
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.#request(method, params);
  }

  sessionCommand(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (sessionId.length === 0) return Promise.reject(new Error("CDP session ID is required"));
    return this.#request(method, params, sessionId);
  }

  /** Subscribes to a CDP event; returns an unsubscribe function. */
  on(method: string, listener: CdpEventListener): () => void {
    const bucket = this.#listeners.get(method) ?? new Set();
    bucket.add(listener);
    this.#listeners.set(method, bucket);
    return () => {
      bucket.delete(listener);
      if (bucket.size === 0) this.#listeners.delete(method);
    };
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!isRecord(response)) throw new Error("Runtime.evaluate returned an invalid result");
    if (isRecord(response.exceptionDetails)) {
      throw new Error(
        typeof response.exceptionDetails.text === "string"
          ? response.exceptionDetails.text
          : "Renderer evaluation failed",
      );
    }
    if (!isRecord(response.result) || !("value" in response.result)) {
      throw new Error("Runtime.evaluate did not return a value");
    }
    return response.result.value as T;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("CDP client closed"));
    this.#listeners.clear();
    this.#socket.close();
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("CDP client is closed"));
    const id = ++this.#ids;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        this.#awaiting.delete(id);
        settled = true;
        reject(new Error(`CDP command '${method}' timed out`));
      }, this.#commandTimeoutMs);
      this.#awaiting.set(id, {
        timer,
        settle(pending: unknown) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (pending instanceof Error) reject(pending);
          else resolve(pending);
        },
      });
      try {
        this.#socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      } catch (error) {
        const command = this.#awaiting.get(id);
        this.#awaiting.delete(id);
        clearTimeout(timer);
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #dispatch(event: SocketEvent): void {
    try {
      const value: unknown = JSON.parse(frameToText(event.data));
      const response = asWireResponse(value);
      if (response) {
        this.#awaiting.get(response.id)?.settle(
          response.error
            ? new Error(
                response.error.message ??
                  `CDP command failed with error ${response.error.code ?? "unknown"}`,
              )
            : response.result,
        );
        this.#awaiting.delete(response.id);
        return;
      }
      if (!isRecord(value) || typeof value.method !== "string") return;
      const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
      for (const listener of this.#listeners.get(value.method) ?? []) {
        listener(value.params, sessionId);
      }
    } catch (error) {
      this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#awaiting.values()) {
      pending.settle(error);
    }
    this.#awaiting.clear();
  }
}
