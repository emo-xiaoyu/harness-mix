import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  type HostThreadId,
  type HostTurnId,
} from "@harnessmix/shared-contracts";

import type { RendererModelClient } from "./renderer-model-client.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

const RESPONSE_CONVERSATION_ATTRIBUTE = "data-response-annotation-conversation";
const TURN_KEY_ATTRIBUTE = "data-content-search-turn-key";
const OPEN_THREAD_TIMEOUT_MS = 5_000;
const FIBER_ANCESTRY_LIMIT = 24;
const FIBER_PROPERTY_PREFIX = "__reactFiber$";

function threadOpenAborted(): Error {
  return Object.assign(new Error("Thread opening was aborted"), { name: "AbortError" });
}

/**
 * Click the sidebar row that owns `threadId` (optionally only rows registered
 * under a specific host), waiting briefly for it to appear.
 */
export function openRendererThread(
  threadId: HostThreadId,
  options: { hostId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const locateRow = (): HTMLElement | null => {
    for (const row of document.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
      const hostMatches =
        options.hostId === undefined ||
        row.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE) === options.hostId;
      if (hostMatches && threadIdFromSidebarRowElement(row) === threadId) {
        return row;
      }
    }
    return null;
  };

  if (options.signal?.aborted) return Promise.reject(threadOpenAborted());
  const immediate = locateRow();
  if (immediate) {
    immediate.click();
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const teardown = (): void => {
      window.clearTimeout(timeoutHandle);
      sidebarObserver.disconnect();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settleWith = (row: HTMLElement): void => {
      if (settled) return;
      settled = true;
      teardown();
      row.click();
      resolve();
    };
    const sidebarObserver = new MutationObserver(() => {
      const row = locateRow();
      if (row) settleWith(row);
    });
    const timeoutHandle = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      teardown();
      reject(new Error("Thread did not appear in the sidebar"));
    }, options.timeoutMs ?? OPEN_THREAD_TIMEOUT_MS);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      teardown();
      reject(threadOpenAborted());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    sidebarObserver.observe(document.documentElement, { childList: true, subtree: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    const row = locateRow();
    if (row) settleWith(row);
  });
}

export interface RendererForkTarget {
  control: object;
  isProjectlessConversation: boolean;
  threadId: HostThreadId;
  turnId: HostTurnId;
}

export interface RendererForkDom {
  listen(onFork: (target: RendererForkTarget) => boolean): () => void;
  openThread(threadId: HostThreadId): Promise<void>;
  replay(target: RendererForkTarget): void;
}

export interface RendererForkControl {
  dispose(): void;
}

export interface RendererForkContractInspection {
  annotatedResponseCount: number;
  candidateButtonCount: number;
  verifiedButtonCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function soleReactFiber(element: Element): Record<string, unknown> | null {
  const keys = Object.getOwnPropertyNames(element).filter((key) =>
    key.startsWith(FIBER_PROPERTY_PREFIX),
  );
  const key = keys[0];
  if (keys.length !== 1 || !key) return null;
  const fiber = Object.getOwnPropertyDescriptor(element, key)?.value;
  return isRecord(fiber) ? fiber : null;
}

/**
 * Trust a Fork button only when its DOM ids and its React Fiber ancestry agree
 * on thread, turn, and host, and a genuine onFork handler exists above it.
 */
export function rendererForkTargetFromButton(button: HTMLButtonElement): RendererForkTarget | null {
  const annotation = button.closest<HTMLElement>(`[${RESPONSE_CONVERSATION_ATTRIBUTE}]`);
  const turnElement = button.closest<HTMLElement>(`[${TURN_KEY_ATTRIBUTE}]`);
  const threadId = hostThreadIdSchema.safeParse(
    annotation?.getAttribute(RESPONSE_CONVERSATION_ATTRIBUTE),
  );
  const turnId = hostTurnIdSchema.safeParse(turnElement?.getAttribute(TURN_KEY_ATTRIBUTE));
  if (!threadId.success || !turnId.success) return null;

  const fiberThreadIds = new Set<string>();
  const fiberTurnIds = new Set<string>();
  const fiberHostIds = new Set<string>();
  const projectlessFlags = new Set<boolean>();
  let sawForkHandler = false;
  let fiber = soleReactFiber(button);
  const buttonProps = fiber?.memoizedProps;
  if (!isRecord(buttonProps) || !Object.hasOwn(buttonProps, "aria-busy")) return null;
  for (let level = 0; fiber && level < FIBER_ANCESTRY_LIMIT; level += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      if (typeof props.conversationId === "string") fiberThreadIds.add(props.conversationId);
      if (typeof props.turnId === "string") fiberTurnIds.add(props.turnId);
      if (typeof props.hostId === "string") fiberHostIds.add(props.hostId);
      if (typeof props.isProjectlessConversation === "boolean") {
        projectlessFlags.add(props.isProjectlessConversation);
      }
      if (typeof props.onFork === "function") sawForkHandler = true;
    }
    fiber = isRecord(fiber.return) ? fiber.return : null;
  }
  if (
    !sawForkHandler ||
    fiberThreadIds.size !== 1 ||
    !fiberThreadIds.has(threadId.data) ||
    fiberTurnIds.size !== 1 ||
    !fiberTurnIds.has(turnId.data) ||
    fiberHostIds.size !== 1 ||
    !fiberHostIds.has("local") ||
    projectlessFlags.size !== 1
  ) {
    return null;
  }
  return {
    control: button,
    isProjectlessConversation: projectlessFlags.has(true),
    threadId: threadId.data,
    turnId: turnId.data,
  };
}

export function inspectRendererForkContract(
  root: ParentNode = document,
): RendererForkContractInspection {
  const annotatedResponses = [
    ...root.querySelectorAll<HTMLElement>(`[${RESPONSE_CONVERSATION_ATTRIBUTE}]`),
  ];
  const candidateButtons = annotatedResponses.flatMap((annotation) => [
    ...annotation.querySelectorAll<HTMLButtonElement>("button"),
  ]);
  return {
    annotatedResponseCount: annotatedResponses.length,
    candidateButtonCount: candidateButtons.length,
    verifiedButtonCount: candidateButtons.filter(
      (button) => rendererForkTargetFromButton(button) !== null,
    ).length,
  };
}

class BrowserRendererForkDom implements RendererForkDom {
  readonly #suppressedClicks = new WeakSet<HTMLButtonElement>();

  listen(onFork: (target: RendererForkTarget) => boolean): () => void {
    const listener = (event: MouseEvent): void => {
      const origin =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const button = origin?.closest<HTMLButtonElement>("button");
      if (!button) return;
      if (this.#suppressedClicks.delete(button)) return;
      const target = rendererForkTargetFromButton(button);
      if (!target || !onFork(target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", listener, true);
    return () => document.removeEventListener("click", listener, true);
  }

  replay(target: RendererForkTarget): void {
    if (!(target.control instanceof HTMLButtonElement) || !target.control.isConnected) return;
    this.#suppressedClicks.add(target.control);
    target.control.click();
  }

  openThread(threadId: HostThreadId): Promise<void> {
    return openRendererThread(threadId);
  }
}

export function installRendererForkControl(options: {
  getClient(): RendererModelClient | null;
  dom?: RendererForkDom;
  reportError?(error: unknown): void;
}): RendererForkControl {
  const dom = options.dom ?? new BrowserRendererForkDom();
  const inFlight = new Set<string>();
  let disposed = false;
  const stopListening = dom.listen((target) => {
    if (disposed) return false;
    const client = options.getClient();
    if (!client) return false;
    const key = `${target.threadId}\u0000${target.turnId}`;
    if (inFlight.has(key)) return true;
    inFlight.add(key);
    void client
      .inspectThread({ threadId: target.threadId })
      .then(async (inspection) => {
        if (disposed) return;
        // Project Threads keep Desktop's own destination/worktree picker: the
        // Host validates chosen destinations inside forkAcrossCwd and that UI
        // must stay in the loop.
        if (
          inspection.owner === "codex" ||
          !inspection.history.fork ||
          !target.isProjectlessConversation
        ) {
          dom.replay(target);
          return;
        }
        const forked = await client.forkThread({
          threadId: target.threadId,
          lastTurnId: target.turnId,
        });
        if (!disposed) await dom.openThread(forked.threadId);
      })
      .catch((error: unknown) => options.reportError?.(error))
      .finally(() => inFlight.delete(key));
    return true;
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stopListening();
      inFlight.clear();
    },
  };
}
