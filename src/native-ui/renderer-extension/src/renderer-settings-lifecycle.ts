import { readCodexLocaleSettings, type CodexLocaleSettings } from "./codex-locale-adapter.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";
import {
  createDefaultRendererSettingsPages,
  type RendererConnectionDiagnostics,
  type RendererCodexAccountClient,
  type RendererUpdateClient,
  type RendererStorageClient,
  type RendererPetsClient,
} from "./settings/pages.js";
import type {
  RendererSessionImportClient,
  RendererImportedThreadOpener,
} from "./settings/session-import-page.js";
import { installRendererSettingsShell, type RendererSettingsShell } from "./settings/shell.js";
import {
  installRendererSettingsHeaderTrigger,
  type RendererSettingsHeaderTriggerControl,
} from "./settings/trigger.js";
import { restoreRendererSkin } from "./settings/skin-runtime.js";

const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;

export interface RendererSettingsLifecycleOptions {
  getIntegrationsClient?(): import('./renderer-integrations-client.js').RendererIntegrationsClient | null;
  getUpdateClient?(): RendererUpdateClient | null;
  getConnectionDiagnostics?(): RendererConnectionDiagnostics | null;
  getAccountClient?(): RendererCodexAccountClient | null;
  getSessionImportClient?(): RendererSessionImportClient | null;
  getStorageClient?(): RendererStorageClient | null;
  getUsageClient?(): import('./settings/pages.js').RendererUsageClient | null;
  getHealthClient?(): import('./settings/pages.js').RendererHealthClient | null;
  getPetClient?(): RendererPetsClient | null;
  getCollaborationClient?(): import('./settings/pages.js').RendererCollaborationClient | null;
  openImportedThread?: RendererImportedThreadOpener;
  onLocaleChange?(locale: RendererSettingsLocale): void;
}

export interface RendererSettingsLifecycleControl {
  readonly locale: RendererSettingsLocale;
  refresh(): boolean;
  dispose(): void;
}

/**
 * Tracks the "update available" dot: checks each distinct update client once,
 * and on failure retries with growing delays that DOM-driven refreshes can
 * never short-circuit.
 */
function createUpdateIndicatorController(
  ownerWindow: Window,
  options: RendererSettingsLifecycleOptions,
  isDisposed: () => boolean,
  getTrigger: () => RendererSettingsHeaderTriggerControl | null,
): {
  isAvailable(): boolean;
  refresh(): void;
  dispose(): void;
} {
  let checkedClient: RendererUpdateClient | null = null;
  let backoffClient: RendererUpdateClient | null = null;
  let backoffTimer: number | null = null;
  let backoffAttempt = 0;
  let checkGeneration = 0;
  let available = false;

  const cancelBackoff = (): void => {
    if (backoffTimer === null) return;
    ownerWindow.clearTimeout(backoffTimer);
    backoffTimer = null;
  };

  const scheduleBackoff = (client: RendererUpdateClient): void => {
    if (isDisposed() || backoffTimer !== null) return;
    const delay = UPDATE_RETRY_DELAYS_MS[backoffAttempt];
    if (delay === undefined) return;
    backoffAttempt += 1;
    backoffTimer = ownerWindow.setTimeout(() => {
      backoffTimer = null;
      if (isDisposed() || options.getUpdateClient?.() !== client) return;
      refresh();
    }, delay);
  };

  const checkWithTimeout = (client: RendererUpdateClient) =>
    new Promise<Awaited<ReturnType<RendererUpdateClient["checkUpdate"]>>>((resolve, reject) => {
      const timer = ownerWindow.setTimeout(
        () => reject(new Error("Update indicator check timed out")),
        UPDATE_CHECK_TIMEOUT_MS,
      );
      void client.checkUpdate().then(
        (result) => {
          ownerWindow.clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          ownerWindow.clearTimeout(timer);
          reject(error);
        },
      );
    });

  const refresh = (): void => {
    const client = options.getUpdateClient?.() ?? null;
    if (!client || checkedClient === client) return;
    if (backoffClient !== client) {
      cancelBackoff();
      backoffClient = client;
      backoffAttempt = 0;
    } else if (backoffTimer !== null) {
      // Already waiting out the backoff for this client; stay quiet.
      return;
    }
    checkedClient = client;
    const generation = ++checkGeneration;
    void checkWithTimeout(client)
      .then((result) => {
        if (isDisposed() || generation !== checkGeneration) return;
        available = result.updateAvailable;
        getTrigger()?.setUpdateAvailable(available);
        if (result.error === null) {
          backoffAttempt = 0;
          cancelBackoff();
          return;
        }
        checkedClient = null;
        scheduleBackoff(client);
      })
      .catch(() => {
        if (isDisposed() || generation !== checkGeneration || checkedClient !== client) {
          return;
        }
        checkedClient = null;
        scheduleBackoff(client);
      });
  };

  return {
    isAvailable: () => available,
    refresh,
    dispose() {
      cancelBackoff();
      checkGeneration += 1;
    },
  };
}

export function installRendererSettingsLifecycle(
  ownerWindow: Window = window,
  options: RendererSettingsLifecycleOptions = {},
): RendererSettingsLifecycleControl {
  restoreRendererSkin(ownerWindow);
  const localeRequests = new AbortController();
  let locale = resolveRendererSettingsLocale(ownerWindow.navigator.languages);
  let shell: RendererSettingsShell | null = null;
  let trigger: RendererSettingsHeaderTriggerControl | null = null;
  let pendingLocaleRequest: Promise<void> | null = null;
  let openGeneration = 0;
  let disposed = false;

  const updateIndicator = createUpdateIndicatorController(
    ownerWindow,
    options,
    () => disposed,
    () => trigger,
  );

  const mount = (): {
    shell: RendererSettingsShell;
    trigger: RendererSettingsHeaderTriggerControl;
  } => {
    const messages = rendererSettingsMessages(locale);
    const definitions = createDefaultRendererSettingsPages(
      messages,
      options.getUpdateClient ?? (() => null),
      options.getConnectionDiagnostics ?? (() => null),
      options.getAccountClient ?? (() => null),
      options.getSessionImportClient ?? (() => null),
      async (threadId, signal) => {
        if (!options.openImportedThread) {
          throw new Error("Imported Thread navigation is unavailable");
        }
        await options.openImportedThread(threadId, signal);
        if (!disposed && !signal.aborted) shell?.close();
      },
      options.getIntegrationsClient,
      options.getStorageClient,
      options.getUsageClient,
      options.getHealthClient,
      options.getPetClient,
      options.getCollaborationClient,
    );
    const nextShell = installRendererSettingsShell(definitions, messages, ownerWindow.document);
    const nextTrigger = installRendererSettingsHeaderTrigger({
      available: nextShell.supported,
      messages,
      ownerDocument: ownerWindow.document,
      onOpen(opener, pageId) {
        const generation = ++openGeneration;
        // Re-resolve the locale before showing the panel so a freshly
        // switched language renders correctly on first open.
        void refreshLocale().then(() => {
          if (disposed || generation !== openGeneration) return;
          const currentOpener = opener.isConnected
            ? opener
            : (trigger?.root?.querySelector<HTMLButtonElement>("button") ?? undefined);
          shell?.openSettings(currentOpener, pageId);
        });
      },
    });
    nextTrigger.setUpdateAvailable(updateIndicator.isAvailable());
    shell = nextShell;
    trigger = nextTrigger;
    return { shell: nextShell, trigger: nextTrigger };
  };

  const switchLocale = (nextLocale: RendererSettingsLocale, preserveOpen: boolean): void => {
    if (disposed || locale === nextLocale) return;

    const reopen = preserveOpen && shell?.open === true;
    const activePageId = shell?.activePageId;
    locale = nextLocale;
    trigger?.dispose();
    shell?.dispose();
    trigger = null;
    shell = null;
    const mounted = mount();
    options.onLocaleChange?.(locale);

    if (reopen) {
      const opener = mounted.trigger.root?.querySelector<HTMLButtonElement>("button") ?? undefined;
      mounted.shell.openSettings(opener, activePageId);
    }
  };

  const refreshLocale = (): Promise<void> => {
    if (pendingLocaleRequest) return pendingLocaleRequest;
    const request = readCodexLocaleSettings({
      ownerWindow,
      signal: localeRequests.signal,
    })
      .then((settings: CodexLocaleSettings) => {
        switchLocale(resolveRendererSettingsLocale([settings.preferredLocale]), false);
      })
      .catch(() => {
        // The synchronous browser-locale pick stays as the safe fallback.
      })
      .finally(() => {
        if (pendingLocaleRequest === request) pendingLocaleRequest = null;
      });
    pendingLocaleRequest = request;
    return request;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      shell?.openSettings(undefined, "connections");
    }
  };

  mount();
  ownerWindow.addEventListener?.("keydown", onKeyDown);
  void refreshLocale();
  updateIndicator.refresh();

  return {
    get locale() {
      return locale;
    },
    refresh() {
      const refreshed = trigger?.refresh() ?? false;
      updateIndicator.refresh();
      return refreshed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ownerWindow.removeEventListener?.("keydown", onKeyDown);
      openGeneration += 1;
      updateIndicator.dispose();
      localeRequests.abort();
      trigger?.dispose();
      shell?.dispose();
      trigger = null;
      shell = null;
    },
  };
}
