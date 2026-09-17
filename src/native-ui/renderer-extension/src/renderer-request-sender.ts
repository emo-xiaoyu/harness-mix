export class RendererMethodUnavailableError extends Error {
  readonly code = -32601;

  constructor(
    readonly method: string,
    cause: unknown,
  ) {
    super(`${method} is unsupported on this Host connection`, { cause });
    this.name = "RendererMethodUnavailableError";
  }
}

/** A Host call that never settled would otherwise leave picker spinners,
 * ownership loads and sidebar icons pending forever. */
export class RendererRequestTimeoutError extends Error {
  readonly code = -32098;

  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} did not answer within ${timeoutMs} ms`, { cause: undefined });
    this.name = "RendererRequestTimeoutError";
  }
}

export const RENDERER_REQUEST_TIMEOUT_DEFAULT_MS = 20_000;

export interface RendererRequestSenderOptions {
  timeoutMs?: number;
  /** Long-running mutations (install, fork, harness switch, ...) opt out. */
  isTimeoutExempt?(method: string): boolean;
}

function isUnsupportedMethod(error: unknown, method: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  return (
    code === -32601 ||
    (code === -32600 &&
      typeof message === "string" &&
      message.startsWith(`Invalid request: unknown variant \`${method}\``))
  );
}

/** One sender per request client. Only explicit method absence is remembered;
 * successes, params, Harness availability and transient failures are not cached.
 * Non-exempt calls carry a bounded timeout so a stale request bridge degrades
 * into a retryable error instead of an infinite pending state. */
export function createRendererRequestSender(
  send: (method: string, params: unknown) => Promise<unknown> | unknown,
  options: RendererRequestSenderOptions = {},
): (method: string, params: unknown) => Promise<unknown> {
  const unsupported = new Map<string, RendererMethodUnavailableError>();
  const timeoutMs = options.timeoutMs ?? RENDERER_REQUEST_TIMEOUT_DEFAULT_MS;
  return async (method, params) => {
    const known = unsupported.get(method);
    if (known) throw known;
    try {
      // Invoke send synchronously: callers and tests observe the request as
      // dispatched before the first await, exactly as without a timeout.
      const attempt = Promise.resolve(send(method, params));
      if (timeoutMs <= 0 || options.isTimeoutExempt?.(method)) return await attempt;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          attempt,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new RendererRequestTimeoutError(method, timeoutMs)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (error) {
      if (!method.startsWith("harnessmix/") || !isUnsupportedMethod(error, method)) throw error;
      const unavailable = new RendererMethodUnavailableError(method, error);
      unsupported.set(method, unavailable);
      throw unavailable;
    }
  };
}
