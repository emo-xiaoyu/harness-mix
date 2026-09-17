import { harnessIdSchema, hostThreadIdSchema } from "@harnessmix/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRendererModelClient,
  HARNESS_INSTALL_METHOD,
  THREAD_INSPECT_METHOD,
} from "../src/renderer-model-client.js";
import {
  RENDERER_REQUEST_TIMEOUT_DEFAULT_MS,
  RendererRequestTimeoutError,
} from "../src/renderer-request-sender.js";

const harnessId = harnessIdSchema.parse("pi");
const threadId = hostThreadIdSchema.parse("thread-timeout");

function pendingSendRequest(): ReturnType<typeof vi.fn> {
  return vi.fn(() => new Promise(() => undefined));
}

describe("Renderer request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a never-settling read with a timeout error instead of pending forever", async () => {
    const sendRequest = pendingSendRequest();
    const client = createRendererModelClient([{ sendRequest }]);
    expect(client).not.toBeNull();

    const request = client!.inspectThread({ threadId });
    const expectation = expect(request).rejects.toBeInstanceOf(RendererRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(RENDERER_REQUEST_TIMEOUT_DEFAULT_MS);
    await expectation;
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith(THREAD_INSPECT_METHOD, { threadId });
  });

  it("does not cache a timed-out method as unsupported; the next call retries", async () => {
    let calls = 0;
    const sendRequest = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? new Promise(() => undefined)
        : Promise.resolve({ owner: "codex", locked: true });
    });
    const client = createRendererModelClient([{ sendRequest }]);

    const first = client!.inspectThread({ threadId });
    const expectation = expect(first).rejects.toBeInstanceOf(RendererRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(RENDERER_REQUEST_TIMEOUT_DEFAULT_MS);
    await expectation;

    await expect(client!.inspectThread({ threadId })).resolves.toMatchObject({
      owner: "codex",
      locked: true,
    });
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it("lets exempt long-running mutations outlive the default timeout", async () => {
    let settle: ((value: unknown) => void) | null = null;
    const sendRequest = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const client = createRendererModelClient([{ sendRequest }]);

    const request = client!.installHarness!({ harnessId });
    await vi.advanceTimersByTimeAsync(RENDERER_REQUEST_TIMEOUT_DEFAULT_MS * 3);
    expect(sendRequest).toHaveBeenCalledWith(HARNESS_INSTALL_METHOD, { harnessId });
    settle?.({ status: "ok" });
    await expect(request).resolves.toMatchObject({ status: "ok" });
  });
});
