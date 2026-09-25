import { isRendererSettingsIconName, type RendererSettingsIconName } from "./icons.js";

const SETTINGS_PAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_SETTINGS_PAGE_ID_LENGTH = 48;
const MAX_SETTINGS_PAGE_LABEL_LENGTH = 64;

export interface RendererSettingsAsyncHandlers<T> {
  success(value: T): void;
  failure(error: unknown): void;
}

export interface RendererSettingsPageMountContext {
  content: HTMLElement;
  signal: AbortSignal;
  runLatest<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    handlers: RendererSettingsAsyncHandlers<T>,
  ): Promise<void>;
}

export interface RendererSettingsPageDefinition {
  readonly id: string;
  readonly label: string;
  readonly icon: RendererSettingsIconName;
  mount(context: RendererSettingsPageMountContext): (() => void) | undefined;
}

export interface RendererSettingsPageRegistry {
  readonly pages: readonly RendererSettingsPageDefinition[];
  readonly defaultPageId: string;
  getPage(pageId: string): RendererSettingsPageDefinition | undefined;
}

function assertUsablePageId(page: RendererSettingsPageDefinition): void {
  const tooShortOrLong =
    page.id.length === 0 || page.id.length > MAX_SETTINGS_PAGE_ID_LENGTH;
  if (tooShortOrLong || !SETTINGS_PAGE_ID_PATTERN.test(page.id)) {
    throw new Error(`Invalid settings page ID: ${page.id || "(empty)"}`);
  }
}

function trimmedPageLabel(page: RendererSettingsPageDefinition): string {
  const label = page.label.trim();
  if (label.length === 0 || label.length > MAX_SETTINGS_PAGE_LABEL_LENGTH) {
    throw new Error(`Invalid settings page label for ${page.id}`);
  }
  return label;
}

function assertUsablePage(page: RendererSettingsPageDefinition): void {
  assertUsablePageId(page);
  const label = trimmedPageLabel(page);
  if (!isRendererSettingsIconName(page.icon)) {
    throw new Error(`Unknown settings page icon for ${page.id}`);
  }
  if (typeof page.mount !== "function") {
    throw new Error(`Settings page ${page.id} has no mount function`);
  }
}

export function createRendererSettingsPageRegistry(
  definitions: readonly RendererSettingsPageDefinition[],
  defaultPageId?: string,
): RendererSettingsPageRegistry {
  if (definitions.length === 0) throw new Error("Settings page registry cannot be empty");
  const resolvedDefaultPageId = defaultPageId ?? definitions[0]?.id ?? "";
  const pages = definitions.map((definition) => {
    assertUsablePage(definition);
    return Object.freeze({ ...definition, label: definition.label.trim() });
  });
  const pagesById = new Map<string, RendererSettingsPageDefinition>();
  for (const page of pages) {
    if (pagesById.has(page.id)) throw new Error(`Duplicate settings page ID: ${page.id}`);
    pagesById.set(page.id, page);
  }
  if (!pagesById.has(resolvedDefaultPageId)) {
    throw new Error(`Default settings page is not registered: ${resolvedDefaultPageId}`);
  }
  return Object.freeze({
    pages: Object.freeze([...pages]),
    defaultPageId: resolvedDefaultPageId,
    getPage(pageId: string) {
      return pagesById.get(pageId);
    },
  });
}

export class RendererSettingsNavigationState {
  #selectedPageId: string;

  constructor(readonly registry: RendererSettingsPageRegistry) {
    this.#selectedPageId = registry.defaultPageId;
  }

  get activePageId(): string {
    return this.#selectedPageId;
  }

  select(pageId: string): boolean {
    if (!this.registry.getPage(pageId)) throw new Error(`Unknown settings page: ${pageId}`);
    if (this.#selectedPageId === pageId) return false;
    this.#selectedPageId = pageId;
    return true;
  }

  reset(): boolean {
    return this.select(this.registry.defaultPageId);
  }
}

// Owns the async lifetime of one mounted settings page. `runLatest` keeps a
// single in-flight request slot per page: issuing a new request aborts the
// previous one, and only the newest generation may deliver its callbacks.
export class RendererSettingsPageScope {
  readonly #lifetimeController = new AbortController();
  #inFlight: AbortController | null = null;
  #generation = 0;
  #disposed = false;

  get signal(): AbortSignal {
    return this.#lifetimeController.signal;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async runLatest<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    handlers: RendererSettingsAsyncHandlers<T>,
  ): Promise<void> {
    if (this.#disposed) throw new Error("Settings page scope is disposed");
    this.#inFlight?.abort();
    const request = new AbortController();
    this.#inFlight = request;
    const ticket = ++this.#generation;
    const abortRequest = (): void => request.abort();
    this.signal.addEventListener("abort", abortRequest, { once: true });
    try {
      const value = await operation(request.signal);
      if (this.#ownsRequest(request, ticket)) handlers.success(value);
    } catch (error) {
      if (this.#ownsRequest(request, ticket)) handlers.failure(error);
    } finally {
      this.signal.removeEventListener("abort", abortRequest);
      if (this.#inFlight === request) this.#inFlight = null;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#inFlight?.abort();
    this.#inFlight = null;
    this.#lifetimeController.abort();
  }

  #ownsRequest(request: AbortController, ticket: number): boolean {
    return (
      !this.#disposed &&
      !request.signal.aborted &&
      this.#inFlight === request &&
      this.#generation === ticket
    );
  }
}
