/**
 * Installs the thread-metadata title policy into the Electron main process:
 * official Codex titles keep flowing, while harnessmix-owned drafts must not
 * leak into the official title generator. The host side walks the inspector
 * object graph to reach the main process's `getContextForWebContents`
 * closure; the policy itself is the serialized payload below (see SPEC.md —
 * its text is wire protocol).
 */
import type { CdpClient } from "./cdp-client.js";

interface Commander {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface RemoteObject {
  objectId?: string;
  value?: unknown;
}

interface RuntimeProperty {
  name?: string;
  value?: RemoteObject;
}

export interface MainProcessTitlePolicyStatus {
  state: "ready";
  reason: "ready";
  requiresRendererReload: true;
}

export interface MainProcessTitlePolicyCounters {
  codexTitleCalls: number;
  piTitleSkips: number;
  externalTitleSkips: number;
  ambiguousTitleSkips: number;
}

export interface RendererTitlePolicyReadiness {
  state: "ready";
  reason: "owned-metadata-service";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwraps a Runtime command result, surfacing remote exceptions as errors. */
function checkedResult(value: unknown, command: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${command} returned an invalid result`);
  if (isRecord(value.exceptionDetails)) {
    const exception = value.exceptionDetails.exception;
    const description = isRecord(exception) ? exception.description : undefined;
    throw new Error(
      typeof description === "string"
        ? description
        : typeof value.exceptionDetails.text === "string"
          ? value.exceptionDetails.text
          : `${command} failed`,
    );
  }
  return value;
}

function objectIdOf(value: unknown, label: string): string {
  if (!isRecord(value) || typeof value.objectId !== "string") {
    throw new Error(`${label} is unavailable`);
  }
  return value.objectId;
}

function propertyList(value: unknown, command: string): RuntimeProperty[] {
  const result = checkedResult(value, command).result;
  if (!Array.isArray(result)) throw new Error(`${command} returned invalid properties`);
  return result.filter(isRecord) as RuntimeProperty[];
}

const ELECTRON_MODULE_EXPRESSION = `(() => {
  const mainModule = process.mainModule;
  if (mainModule != null && typeof mainModule.require === 'function') {
    return mainModule.require('electron');
  }
  const { createRequire } = process.getBuiltinModule('module');
  return createRequire(process.execPath)('electron');
})()`;
const CONNECT_APP_HOST_CHANNEL = "codex_desktop:connect-app-host";
const POLICY_STATE_SYMBOL = "harnessmix.main-process-title-policy.v1";
const SERVICE_OWNER_SYMBOL = "harnessmix.main-process-title-policy.owner.v1";
const RENDERER_READY_EXPRESSION =
  "(() => { Object.defineProperty(window, '__harnessmixMainProcessTitlePolicyV1', { configurable: true, value: { state: 'ready' } }); return 'ready'; })()";
const INSTALL_POLICY_FUNCTION = `async function (rendererWebContentsId) {
  const mainModule = process.mainModule;
  const electron = mainModule != null && typeof mainModule.require === 'function'
    ? mainModule.require('electron')
    : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
  const selected = electron.webContents.fromId(rendererWebContentsId);
  if (selected == null || selected.isDestroyed() || selected.getType() !== 'window') {
    throw new Error('Owned Renderer unavailable for title policy');
  }

  const context = this(selected);
  if (context == null || typeof context.createAppHost !== 'function') {
    throw new Error('WindowContext unavailable for title policy');
  }
  const stateSymbol = Symbol.for(${JSON.stringify(POLICY_STATE_SYMBOL)});
  const ownerSymbol = Symbol.for(${JSON.stringify(SERVICE_OWNER_SYMBOL)});
  globalThis[stateSymbol]?.dispose?.();

  const originalCreateAppHost = context.createAppHost;
  const sampleHost = originalCreateAppHost.call(context, selected);
  const sampleService = sampleHost?.services?.threadMetadataGeneration;
  const servicePrototype = sampleService == null ? null : Object.getPrototypeOf(sampleService);
  const originalGenerateTitle = servicePrototype?.generateTitle;
  if (
    servicePrototype == null ||
    typeof originalGenerateTitle !== 'function' ||
    !Function.prototype.toString.call(originalGenerateTitle).includes('Failed to generate thread title')
  ) {
    throw new Error('ThreadMetadataGenerationService signature mismatch');
  }
  const originalGenerateDescription = typeof servicePrototype?.generateDescription === 'function'
    ? servicePrototype.generateDescription
    : null;
  const originalReconsiderTitle = typeof servicePrototype?.reconsiderTitle === 'function'
    ? servicePrototype.reconsiderTitle
    : null;
  const counters = {
    codexTitleCalls: 0,
    piTitleSkips: 0,
    externalTitleSkips: 0,
    ambiguousTitleSkips: 0,
  };
  const ownedWebContentsIds = new Set();
  const ownService = (service, contents) => {
    const existingOwner = service[ownerSymbol];
    if (existingOwner != null && existingOwner !== contents) {
      throw new Error('Thread metadata service ownership mismatch');
    }
    if (existingOwner == null) {
      Object.defineProperty(service, ownerSymbol, { value: contents });
    }
    ownedWebContentsIds.add(contents.id);
  };
  ownService(sampleService, selected);
  const wrappedCreateAppHost = function (contents) {
    const host = originalCreateAppHost.call(this, contents);
    const service = host?.services?.threadMetadataGeneration;
    if (service != null) ownService(service, contents);
    return host;
  };
  const wrappedGenerateTitle = async function (params) {
    const owner = this[ownerSymbol];
    if (owner == null || owner.isDestroyed()) {
      counters.ambiguousTitleSkips += 1;
      return null;
    }
    let selection = null;
    try {
      selection = await owner.executeJavaScript(
        "window.__harnessmixRendererBindingProbeV1?.lockedSelection() ?? null",
        true,
      );
    } catch {}
    if (selection?.phase !== 'locked') {
      counters.ambiguousTitleSkips += 1;
      return null;
    }
    if (selection.agent === 'pi') {
      counters.piTitleSkips += 1;
      return null;
    }
    if (selection.agent !== 'codex') {
      counters.externalTitleSkips += 1;
      return null;
    }
    counters.codexTitleCalls += 1;
    return originalGenerateTitle.call(this, params);
  };
  const shouldSkipExternalMetadata = async (service) => {
    const owner = service[ownerSymbol];
    if (owner == null || owner.isDestroyed()) return true;
    let selection = null;
    try {
      selection = await owner.executeJavaScript(
        "window.__harnessmixRendererBindingProbeV1?.lockedSelection() ?? null",
        true,
      );
    } catch {}
    return selection?.phase === 'locked' && selection.agent !== 'codex';
  };
  const wrappedGenerateDescription = originalGenerateDescription
    ? async function (params) {
        if (await shouldSkipExternalMetadata(this)) return null;
        return originalGenerateDescription.call(this, params);
      }
    : null;
  const wrappedReconsiderTitle = originalReconsiderTitle
    ? async function (params) {
        if (await shouldSkipExternalMetadata(this)) return null;
        return originalReconsiderTitle.call(this, params);
      }
    : null;

  context.createAppHost = wrappedCreateAppHost;
  servicePrototype.generateTitle = wrappedGenerateTitle;
  if (wrappedGenerateDescription) servicePrototype.generateDescription = wrappedGenerateDescription;
  if (wrappedReconsiderTitle) servicePrototype.reconsiderTitle = wrappedReconsiderTitle;
  const state = {
    counters,
    ownedWebContentsIds,
    dispose() {
      if (context.createAppHost === wrappedCreateAppHost) {
        context.createAppHost = originalCreateAppHost;
      }
      if (servicePrototype.generateTitle === wrappedGenerateTitle) {
        servicePrototype.generateTitle = originalGenerateTitle;
      }
      if (wrappedGenerateDescription && servicePrototype.generateDescription === wrappedGenerateDescription) {
        servicePrototype.generateDescription = originalGenerateDescription;
      }
      if (wrappedReconsiderTitle && servicePrototype.reconsiderTitle === wrappedReconsiderTitle) {
        servicePrototype.reconsiderTitle = originalReconsiderTitle;
      }
      if (globalThis[stateSymbol] === state) delete globalThis[stateSymbol];
    },
  };
  globalThis[stateSymbol] = state;
  return {
    state: 'ready',
    reason: 'ready',
    requiresRendererReload: true,
  };
}`;

const requireWebContentsId = (rendererWebContentsId: number): void => {
  if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0) {
    throw new Error("Renderer webContents ID must be a positive integer");
  }
};

export async function installMainProcessTitlePolicy(
  inspector: Pick<CdpClient, "command"> | Commander,
  rendererWebContentsId: number,
): Promise<MainProcessTitlePolicyStatus> {
  requireWebContentsId(rendererWebContentsId);
  // Reach into the main process: IPC listener → closure scopes → local scope →
  // the `f` binding (getContextForWebContents), then install the policy there.
  const listener = checkedResult(
    await inspector.command("Runtime.evaluate", {
      expression: `(${ELECTRON_MODULE_EXPRESSION}).ipcMain.listeners(${JSON.stringify(
        CONNECT_APP_HOST_CHANNEL,
      )})[0]`,
    }),
    "Runtime.evaluate",
  ).result;
  const listenerObject = objectIdOf(listener, "connect-app-host listener");

  const listenerProps = checkedResult(
    await inspector.command("Runtime.getProperties", { objectId: listenerObject }),
    "Runtime.getProperties",
  );
  const internalProps = listenerProps.internalProperties;
  if (!Array.isArray(internalProps)) {
    throw new Error("connect-app-host listener scopes are unavailable");
  }
  const scopes = internalProps.find(
    (property) => isRecord(property) && property.name === "[[Scopes]]",
  );
  const scopesObject = objectIdOf(
    isRecord(scopes) ? scopes.value : null,
    "connect-app-host listener scopes",
  );

  const scopeProps = propertyList(
    await inspector.command("Runtime.getProperties", {
      objectId: scopesObject,
      ownProperties: true,
    }),
    "Runtime.getProperties",
  );
  const localScope = scopeProps.find((property) => property.name === "0");
  const localScopeObject = objectIdOf(localScope?.value, "connect-app-host local scope");

  const localProps = propertyList(
    await inspector.command("Runtime.getProperties", {
      objectId: localScopeObject,
      ownProperties: true,
    }),
    "Runtime.getProperties",
  );
  const getContext = localProps.find(
    (property) => property.name === "f" && typeof property.value?.objectId === "string",
  );
  const getContextObject = objectIdOf(getContext?.value, "getContextForWebContents");

  const installPromise = checkedResult(
    await inspector.command("Runtime.callFunctionOn", {
      objectId: getContextObject,
      functionDeclaration: INSTALL_POLICY_FUNCTION,
      arguments: [{ value: rendererWebContentsId }],
    }),
    "Runtime.callFunctionOn",
  );
  const awaited = checkedResult(
    await inspector.command("Runtime.awaitPromise", {
      promiseObjectId: objectIdOf(
        installPromise.result,
        "Main-process title policy installation promise",
      ),
      returnByValue: true,
    }),
    "Runtime.awaitPromise",
  );
  const status = isRecord(awaited.result) ? awaited.result.value : null;
  if (
    !isRecord(status) ||
    status.state !== "ready" ||
    status.reason !== "ready" ||
    status.requiresRendererReload !== true ||
    Object.keys(status).length !== 3
  ) {
    throw new Error("Main-process title policy returned an invalid status");
  }
  return status as unknown as MainProcessTitlePolicyStatus;
}

export async function markRendererTitlePolicyReady(
  inspector: Pick<CdpClient, "evaluate">,
  rendererWebContentsId: number,
): Promise<RendererTitlePolicyReadiness> {
  requireWebContentsId(rendererWebContentsId);
  const value = await inspector.evaluate<unknown>(`(async () => {
    const state = globalThis[Symbol.for(${JSON.stringify(POLICY_STATE_SYMBOL)})];
    if (state == null) throw new Error('Main-process title policy is unavailable');
    const mainModule = process.mainModule;
    const electron = mainModule != null && typeof mainModule.require === 'function'
      ? mainModule.require('electron')
      : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const selected = electron.webContents.fromId(${rendererWebContentsId});
    if (selected == null || selected.isDestroyed() || selected.getType() !== 'window') {
      throw new Error('Owned Renderer unavailable for title policy readiness');
    }
    if (!state.ownedWebContentsIds.has(selected.id)) {
      throw new Error('Renderer metadata service ownership is unavailable');
    }
    const marker = selected.executeJavaScript(
      ${JSON.stringify(RENDERER_READY_EXPRESSION)},
      true,
    );
    const markerTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Renderer readiness marker timed out')), 2_000);
    });
    await Promise.race([marker, markerTimeout]);
    return { state: 'ready', reason: 'owned-metadata-service' };
  })()`);
  if (!isRecord(value) || value.state !== "ready" || value.reason !== "owned-metadata-service") {
    throw new Error("Renderer title policy returned an invalid readiness status");
  }
  return value as unknown as RendererTitlePolicyReadiness;
}

export async function readMainProcessTitlePolicyCounters(
  inspector: Pick<CdpClient, "evaluate">,
): Promise<MainProcessTitlePolicyCounters | null> {
  const value = await inspector.evaluate<unknown>(`(() => {
    const state = globalThis[Symbol.for(${JSON.stringify(POLICY_STATE_SYMBOL)})];
    return state == null ? null : { ...state.counters };
  })()`);
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !Number.isInteger(value.codexTitleCalls) ||
    !Number.isInteger(value.piTitleSkips) ||
    !Number.isInteger(value.externalTitleSkips) ||
    !Number.isInteger(value.ambiguousTitleSkips)
  ) {
    throw new Error("Main-process title policy returned invalid counters");
  }
  return value as unknown as MainProcessTitlePolicyCounters;
}
