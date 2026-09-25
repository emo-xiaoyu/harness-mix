/** Update RPCs get both a timeout and abort handling so settings pages can
 * cancel in-flight checks when the user navigates away. */
export const RENDERER_UPDATE_REQUEST_TIMEOUT_MS = 15_000;

export class RendererUpdateRequestTimeoutError extends Error {
  constructor() {
    super("Update request timed out");
    this.name = "RendererUpdateRequestTimeoutError";
  }
}

export function runBoundedRendererUpdateRequest<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs = RENDERER_UPDATE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new RendererUpdateRequestTimeoutError()));
    }, timeoutMs);
    const onAbort = (): void => {
      settle(() => reject(new Error("Update request was aborted")));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      void operation().then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
