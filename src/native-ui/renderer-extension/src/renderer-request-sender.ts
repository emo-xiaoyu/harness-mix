/**
 * Per-client request sender wrapper: remembers explicitly unsupported
 * harnessmix/* methods (so pickers stop probing them) and bounds every other
 * call with a timeout so a dead bridge degrades to a retryable error instead
 * of an eternally pending spinner. Long-running mutations opt out.
 */
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

/** Without a bound, a Host call that never settled would leave pickers,
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

/** -32601, or the -32600 "unknown variant" spelling some hosts emit. */
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

/** Only explicit method absence is remembered; successes, params, Harness
 * availability and transient failures are never cached. */
export function createRendererRequestSender(
  send: (method: string, params: unknown) => Promise<unknown> | unknown,
  options: RendererRequestSenderOptions = {},
): (method: string, params: unknown) => Promise<unknown> {
  const unavailable = new Map<string, RendererMethodUnavailableError>();
  const timeoutMs = options.timeoutMs ?? RENDERER_REQUEST_TIMEOUT_DEFAULT_MS;
  return async (method, params) => {
    const known = unavailable.get(method);
    if (known) throw known;
    try {
      // Invoke send synchronously: callers observe the request as dispatched
      // before the first await, exactly as they would without the timeout.
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
      const missing = new RendererMethodUnavailableError(method, error);
      unavailable.set(method, missing);
      throw missing;
    }
  };
}
