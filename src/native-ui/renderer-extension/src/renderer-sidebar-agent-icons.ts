import {
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  hostThreadIdSchema,
  type HostThreadId,
  type ThreadOwnership,
} from "@harnessmix/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";

export const SIDEBAR_THREAD_ROW_ATTRIBUTE = "data-app-action-sidebar-thread-row";
export const SIDEBAR_THREAD_ROW_SELECTOR = `[${SIDEBAR_THREAD_ROW_ATTRIBUTE}]`;
export const SIDEBAR_THREAD_ID_ATTRIBUTE = "data-app-action-sidebar-thread-id";
export const SIDEBAR_THREAD_HOST_ID_ATTRIBUTE = "data-app-action-sidebar-thread-host-id";
export const SIDEBAR_AGENT_ICON_ATTRIBUTE = "data-harnessmix-sidebar-agent-icon";

export interface RendererSidebarContractInspection {
  rowCount: number;
  titleOwnerCount: number;
  resolvedThreadCount: number;
  ambiguousThreadCount: number;
}

const OWNERSHIP_RETRY_DELAYS_MS = [100, 300, 800, 1_500, 3_000] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SidebarRowIdentity {
  taskKey: string;
  hostId: string;
  rowMarker: string;
}

function readSidebarRowIdentity(element: HTMLElement): SidebarRowIdentity | null {
  const taskKey = element.getAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE);
  const hostId = element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
  const rowMarker = element.getAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE);
  if (taskKey === null || hostId === null || rowMarker === null) return null;
  return { taskKey, hostId, rowMarker };
}

export function draftIdFromSidebarRowElement(element: HTMLElement): string | null {
  const identity = readSidebarRowIdentity(element);
  if (!identity) return null;
  const hostPrefix = `${identity.hostId}:`;
  const taskKey = identity.taskKey.startsWith(hostPrefix)
    ? identity.taskKey.slice(hostPrefix.length)
    : identity.taskKey;
  return taskKey.startsWith("client-new-thread:") ? taskKey : null;
}

function conversationIdsFromFibers(element: HTMLElement, identity: SidebarRowIdentity): Set<string> {
  const matches = new Set<string>();
  const fiberKeys = Object.getOwnPropertyNames(element).filter((key) =>
    key.startsWith("__reactFiber$"),
  );
  for (const fiberKey of fiberKeys) {
    let fiber = Object.getOwnPropertyDescriptor(element, fiberKey)?.value;
    if (!isRecord(fiber)) continue;
    // Climb at most sixteen ancestors: enough to reach the row component from
    // any key the Desktop build attaches, without walking the whole tree.
    for (let depth = 0; fiber && depth < 16; depth += 1) {
      const props = fiber.memoizedProps;
      if (isRecord(props) && isRecord(props.dataAttributes)) {
        const conversationId = hostThreadIdSchema.safeParse(props.conversationId);
        if (
          conversationId.success &&
          props.dataAttributes[SIDEBAR_THREAD_ROW_ATTRIBUTE] === identity.rowMarker &&
          props.dataAttributes[SIDEBAR_THREAD_ID_ATTRIBUTE] === identity.taskKey &&
          props.dataAttributes[SIDEBAR_THREAD_HOST_ID_ATTRIBUTE] === identity.hostId
        ) {
          matches.add(conversationId.data);
        }
      }
      fiber = isRecord(fiber.return) ? fiber.return : null;
    }
  }
  return matches;
}

export function threadIdFromSidebarRowElement(element: HTMLElement): string | null {
  const identity = readSidebarRowIdentity(element);
  if (!identity) return null;
  // Desktop builds sometimes leave more than one Fiber root key on a row
  // (transitions, nested roots). Every root gets a vote; resolution only
  // fails when the votes genuinely disagree.
  const candidates = conversationIdsFromFibers(element, identity);
  if (candidates.size !== 1) return null;
  return candidates.values().next().value ?? null;
}

export function inspectRendererSidebarContract(
  root: ParentNode = document,
): RendererSidebarContractInspection {
  const rows = [...root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)];
  let titleOwnerCount = 0;
  let resolvedThreadCount = 0;
  let ambiguousThreadCount = 0;
  for (const row of rows) {
    const titleTrigger = row.querySelector<HTMLElement>("[data-thread-title-trigger]");
    const title = titleTrigger?.querySelector<HTMLElement>("[data-thread-title]");
    if (titleTrigger && title) titleOwnerCount += 1;
    const identity = readSidebarRowIdentity(row);
    if (!identity || identity.taskKey.startsWith("client-new-thread:")) continue;
    if (threadIdFromSidebarRowElement(row) === null) ambiguousThreadCount += 1;
    else resolvedThreadCount += 1;
  }
  return {
    rowCount: rows.length,
    titleOwnerCount,
    resolvedThreadCount,
    ambiguousThreadCount,
  };
}

export interface SidebarAgentIconRow {
  isConnected(): boolean;
  hostId(): string | null;
  threadId(): string | null;
  draftId(): string | null;
  render(agent: RendererAgent): void;
  clear(): void;
}

export interface SidebarAgentIconDom {
  rows(): readonly SidebarAgentIconRow[];
  observe(onChange: () => void): () => void;
  clear(): void;
}

export interface RendererSidebarAgentIcons {
  refresh(): void;
  dispose(): void;
}

export function rendererAgentForThreadOwnership(
  ownership: ThreadOwnership,
): RendererAgent | null {
  if (ownership.owner === "codex") return "codex";
  switch (ownership.harnessId) {
    case "pi":
      return "pi";
    case "claude-code":
      return "claude-code";
    case "deepseek-harness":
      return "deepseek-harness";
    case "opencode":
      return "opencode";
    case "grok":
      return "grok";
    case "omp":
      return "omp";
    case "antigravity":
      return "antigravity";
    case "kiro-cli":
      return "kiro-cli";
    case "openclaw":
      return "openclaw";
    case "hermes":
      return "hermes";
    case "qoder":
      return "qoder";
    case "codebuddy":
      return "codebuddy";
    case "zcode":
      return "zcode";
    case "trae":
      return "trae";
    case "cursor-cli":
      return "cursor-cli";
    case "cline":
      return "cline";
    case "codex-harness":
      return "codex-harness";
    default:
      return null;
  }
}

class LiveSidebarAgentIconRow implements SidebarAgentIconRow {
  constructor(private readonly element: HTMLElement) {}

  isConnected(): boolean {
    return this.element.isConnected;
  }

  hostId(): string | null {
    return readSidebarRowIdentity(this.element)?.hostId ?? null;
  }

  threadId(): string | null {
    return threadIdFromSidebarRowElement(this.element);
  }

  draftId(): string | null {
    return draftIdFromSidebarRowElement(this.element);
  }

  render(agent: RendererAgent): void {
    const titleTrigger = this.element.querySelector<HTMLElement>("[data-thread-title-trigger]");
    const title = titleTrigger?.querySelector<HTMLElement>("[data-thread-title]");
    if (!titleTrigger || !title) {
      this.clear();
      return;
    }
    const existing = [
      ...this.element.querySelectorAll<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`),
    ];
    if (
      existing.length === 1 &&
      existing[0]?.parentElement === titleTrigger &&
      existing[0].getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE) === agent
    ) {
      return;
    }
    this.clear();

    const label = `${RENDERER_AGENT_LABELS[agent]} Agent`;
    const marker = this.element.ownerDocument.createElement("span");
    marker.setAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE, agent);
    marker.setAttribute("role", "img");
    marker.setAttribute("aria-label", label);
    marker.title = label;
    marker.style.display = "inline-flex";
    marker.style.alignItems = "center";
    marker.style.justifyContent = "center";
    marker.style.width = "14px";
    marker.style.height = "14px";
    marker.style.flex = "none";
    marker.style.pointerEvents = "none";
    marker.append(createRendererAgentIcon(agent, 14, this.element.ownerDocument));
    titleTrigger.insertBefore(marker, title);
  }

  clear(): void {
    for (const icon of this.element.querySelectorAll(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`)) {
      icon.remove();
    }
  }
}

class LiveSidebarAgentIconDom implements SidebarAgentIconDom {
  readonly #rowByElement = new WeakMap<HTMLElement, LiveSidebarAgentIconRow>();
  readonly #knownRows = new Set<LiveSidebarAgentIconRow>();

  constructor(private readonly root: ParentNode & Node) {}

  rows(): readonly SidebarAgentIconRow[] {
    for (const row of this.#knownRows) {
      if (!row.isConnected()) this.#knownRows.delete(row);
    }
    return [...this.root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)].map(
      (element) => {
        let row = this.#rowByElement.get(element);
        if (!row) {
          row = new LiveSidebarAgentIconRow(element);
          this.#rowByElement.set(element, row);
          this.#knownRows.add(row);
        }
        return row;
      },
    );
  }

  observe(onChange: () => void): () => void {
    const observer = new MutationObserver(onChange);
    observer.observe(this.root, {
      attributes: true,
      attributeFilter: [SIDEBAR_THREAD_ID_ATTRIBUTE, SIDEBAR_THREAD_HOST_ID_ATTRIBUTE],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }

  clear(): void {
    for (const row of this.#knownRows) row.clear();
    this.#knownRows.clear();
  }
}

export function installRendererSidebarAgentIcons(options: {
  getClient(hostId: string): RendererModelClient | null;
  getLocalAgent?(input: {
    hostId: string;
    threadId: string | null;
    draftId: string | null;
  }): RendererAgent | null;
  dom?: SidebarAgentIconDom;
}): RendererSidebarAgentIcons {
  const dom = options.dom ?? new LiveSidebarAgentIconDom(document);
  const agentByKey = new Map<string, RendererAgent | null>();
  const inFlight = new Set<string>();
  const errored = new Set<string>();
  const codexProvisional = new Set<string>();
  const stale = new Set<string>();
  const retryAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let scanQueued = false;

  const ownershipKey = (hostId: string, threadId: string): string =>
    JSON.stringify([hostId, threadId]);

  const scheduleScan = (): void => {
    if (disposed || scanQueued) return;
    scanQueued = true;
    queueMicrotask(scan);
  };

  const cancelRetry = (key: string): void => {
    const timer = retryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    retryTimers.delete(key);
    retryAttempts.delete(key);
    errored.delete(key);
    codexProvisional.delete(key);
  };

  const armRetry = (hostId: string, threadId: HostThreadId): void => {
    const key = ownershipKey(hostId, threadId);
    if (
      disposed ||
      (!errored.has(key) && !codexProvisional.has(key)) ||
      inFlight.has(key) ||
      retryTimers.has(key)
    ) {
      return;
    }
    const attempt = retryAttempts.get(key) ?? 0;
    const delay = OWNERSHIP_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    retryAttempts.set(key, attempt + 1);
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      if (disposed) return;
      errored.delete(key);
      stale.add(key);
      scheduleScan();
    }, delay);
    retryTimers.set(key, timer);
  };

  const requestOwnership = (
    hostId: string,
    threadIds: HostThreadId[],
    client: RendererModelClient,
  ): void => {
    for (const threadId of threadIds) {
      const key = ownershipKey(hostId, threadId);
      inFlight.add(key);
      stale.delete(key);
    }
    let responded = false;
    let mayRetry = true;
    void Promise.resolve()
      .then(() => client.listThreadOwnership({ threadIds }))
      .then(({ threads }) => {
        if (disposed) return;
        for (const ownership of threads) {
          const key = ownershipKey(hostId, ownership.threadId);
          agentByKey.set(key, rendererAgentForThreadOwnership(ownership));
          errored.delete(key);
          if (ownership.owner === "codex") {
            codexProvisional.add(key);
            armRetry(hostId, ownership.threadId);
          } else {
            cancelRetry(key);
          }
        }
        responded = true;
      })
      .catch((error) => {
        if (disposed) return;
        mayRetry = !(error instanceof RendererMethodUnavailableError);
        for (const threadId of threadIds) errored.add(ownershipKey(hostId, threadId));
      })
      .finally(() => {
        for (const threadId of threadIds) inFlight.delete(ownershipKey(hostId, threadId));
        if (mayRetry) {
          for (const threadId of threadIds) armRetry(hostId, threadId);
        }
        if (responded) scheduleScan();
      });
  };

  const scan = (): void => {
    scanQueued = false;
    if (disposed) return;
    const unresolvedByHost = new Map<string, Set<HostThreadId>>();
    for (const row of dom.rows()) {
      if (!row.isConnected()) {
        row.clear();
        continue;
      }
      const hostId = row.hostId();
      if (!hostId) {
        row.clear();
        continue;
      }
      const threadId = hostThreadIdSchema.safeParse(row.threadId());
      const localAgent = options.getLocalAgent?.({
        hostId,
        threadId: threadId.success ? threadId.data : null,
        draftId: row.draftId(),
      });
      if (localAgent != null) {
        if (threadId.success) {
          const key = ownershipKey(hostId, threadId.data);
          agentByKey.set(key, localAgent);
          cancelRetry(key);
        }
        row.render(localAgent);
        continue;
      }
      if (!threadId.success) {
        row.clear();
        continue;
      }
      const key = ownershipKey(hostId, threadId.data);
      if (agentByKey.has(key)) {
        const agent = agentByKey.get(key);
        if (agent) row.render(agent);
        else row.clear();
        if (!stale.has(key)) continue;
      }
      if (!agentByKey.has(key)) row.clear();
      if (!inFlight.has(key) && !errored.has(key)) {
        let unresolved = unresolvedByHost.get(hostId);
        if (!unresolved) {
          unresolved = new Set();
          unresolvedByHost.set(hostId, unresolved);
        }
        unresolved.add(threadId.data);
      }
    }
    for (const [hostId, unresolved] of unresolvedByHost) {
      const client = options.getClient(hostId);
      if (!client) {
        for (const threadId of unresolved) {
          errored.add(ownershipKey(hostId, threadId));
          armRetry(hostId, threadId);
        }
        continue;
      }
      const threadIds = [...unresolved];
      for (let index = 0; index < threadIds.length; index += THREAD_OWNERSHIP_LIST_MAX_LENGTH) {
        requestOwnership(
          hostId,
          threadIds.slice(index, index + THREAD_OWNERSHIP_LIST_MAX_LENGTH),
          client,
        );
      }
    }
  };

  const stopObserving = dom.observe(scheduleScan);
  scan();

  return {
    refresh() {
      errored.clear();
      // Revalidate quietly: keep whatever icon is already shown while the
      // recheck runs in the background.
      for (const key of codexProvisional) stale.add(key);
      scheduleScan();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      dom.clear();
      agentByKey.clear();
      inFlight.clear();
      errored.clear();
      codexProvisional.clear();
      stale.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      retryAttempts.clear();
    },
  };
}
