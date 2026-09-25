/**
 * Renderer control over the direct page-level CDP endpoint: waits for the
 * primary `app://-/index.html` target, installs the renderer bundle
 * (`Page.addScriptToEvaluateOnNewDocument` + immediate evaluation), wires the
 * sidecar frame bridge and re-installs wholesale whenever the target is
 * replaced (window reload / recreation).
 */
import {
  CdpClient,
  listCdpTargets,
  type CdpClientOptions,
  type CdpFetch,
  type CdpTarget,
} from "./cdp-client.js";
import {
  installRendererDraftPrewarmPolicyDirect,
  type RendererDraftPrewarmPolicyStatus,
} from "./renderer-draft-prewarm-policy.js";
import type { LocalSidecar } from "./local-sidecar.js";

export interface ProductionRendererStatus {
  version: 2;
  enabledAgents: string[];
  adapter: {
    state: "ready";
    reason: string;
  };
}

export interface RendererCdpControlSnapshot {
  target: CdpTarget;
  draftPrewarmPolicy: RendererDraftPrewarmPolicyStatus;
  binding: ProductionRendererStatus;
}

interface RendererConnection {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  on?(method: string, listener: (params: unknown) => void): () => void;
  close(): void;
}

interface CdpOperations {
  listTargets(endpoint: string): Promise<CdpTarget[]>;
  connect(webSocketDebuggerUrl: string): Promise<RendererConnection>;
  installDraftPrewarmPolicy(renderer: RendererConnection): Promise<RendererDraftPrewarmPolicyStatus>;
}

export interface RendererCdpControlSession {
  readonly snapshot: RendererCdpControlSnapshot;
  ensureInstalled(): Promise<RendererCdpControlSnapshot>;
  activateDesktop(): Promise<number>;
  executeRenderer<T>(expression: string): Promise<T>;
  close(): void;
}

export interface InstallRendererCdpControlOptions {
  rendererCdpEndpoint: string;
  rendererSource: string;
  sidecar?: LocalSidecar;
  enabledAgents?: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface CreateSessionOptions extends InstallRendererCdpControlOptions {
  operations?: CdpOperations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The renderer bundle and the controller keep independently ordered catalogs. */
function sameAgentSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((agent) => actual.includes(agent));
}

function isPrimaryRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "app:" &&
      url.hostname === "-" &&
      url.pathname === "/index.html" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function selectPrimaryRendererTarget(
  targets: readonly CdpTarget[],
  preferredTargetId?: string,
): CdpTarget | null {
  const pages = targets.filter(
    (target) => target.type === "page" && isPrimaryRendererUrl(target.url),
  );
  return pages.find((target) => target.id === preferredTargetId) ?? pages.at(0) ?? null;
}

class RendererAdapterReadinessError extends Error {
  constructor(
    readonly state: string,
    readonly reason: string,
  ) {
    super(`Production Renderer Adapter is ${state}: ${reason}`);
    this.name = "RendererAdapterReadinessError";
  }
}

function validateBindingStatus(
  value: unknown,
  expectedAgents: readonly string[],
): ProductionRendererStatus {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.enabledAgents) ||
    value.enabledAgents.some((agent) => typeof agent !== "string") ||
    !sameAgentSet(value.enabledAgents as string[], expectedAgents) ||
    !isRecord(value.adapter)
  ) {
    throw new Error("Production Renderer binding returned an invalid status");
  }
  if (value.adapter.state !== "ready" || typeof value.adapter.reason !== "string") {
    throw new RendererAdapterReadinessError(
      typeof value.adapter.state === "string" ? value.adapter.state : "invalid",
      typeof value.adapter.reason === "string" ? value.adapter.reason : "unknown",
    );
  }
  return value as unknown as ProductionRendererStatus;
}

async function waitForPrimaryTarget(
  endpoint: string,
  operations: CdpOperations,
  timeoutMs: number,
  pollIntervalMs: number,
  preferredTargetId?: string,
): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const target = selectPrimaryRendererTarget(
        await operations.listTargets(endpoint),
        preferredTargetId,
      );
      if (target) return target;
      lastFailure = new Error("Renderer CDP has no primary app://-/index.html page target");
    } catch (error) {
      lastFailure = error;
    }
    await wait(pollIntervalMs);
  }
  const detail = lastFailure instanceof Error ? `: ${lastFailure.message}` : "";
  throw new Error(`Primary Codex Renderer CDP target did not become ready${detail}`);
}

async function evaluateSource(renderer: RendererConnection, source: string): Promise<void> {
  const response = await renderer.command("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
  });
  if (!isRecord(response)) {
    throw new Error("Renderer source evaluation returned an invalid result");
  }
  if (isRecord(response.exceptionDetails)) {
    throw new Error(
      typeof response.exceptionDetails.text === "string"
        ? response.exceptionDetails.text
        : "Renderer source evaluation failed",
    );
  }
}

const readBinding = (renderer: RendererConnection): Promise<unknown> =>
  renderer.evaluate<unknown>("window.__harnessmixRendererBindingProbeV1?.status() ?? null");

async function waitForBinding(
  renderer: RendererConnection,
  enabledAgents: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ProductionRendererStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await readBinding(renderer);
      if (value !== null) return validateBindingStatus(value, enabledAgents);
    } catch (error) {
      lastFailure = error;
      // "installing" is the only transient adapter state; anything else is fatal.
      if (error instanceof RendererAdapterReadinessError && error.state !== "installing") {
        throw error;
      }
    }
    await wait(pollIntervalMs);
  }
  const detail = lastFailure instanceof Error ? `: ${lastFailure.message}` : "";
  throw new Error(`Production Renderer binding did not become ready${detail}`);
}

interface InstalledTarget {
  renderer: RendererConnection;
  snapshot: RendererCdpControlSnapshot;
  detachSidecar?: () => void;
}

async function installTarget(
  target: CdpTarget,
  rendererSource: string,
  sidecar: LocalSidecar | undefined,
  enabledAgents: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
  operations: CdpOperations,
): Promise<InstalledTarget> {
  const renderer = await operations.connect(target.webSocketDebuggerUrl);
  let detachSidecar: (() => void) | undefined;
  // 帧中继与桥安装存在竞态：CDP attach 早于请求管理器 patch，
  // __harnessmixSidecarReceiveV1 尚未定义，optional-chain 会把这段窗口里
  // （含 sidecar 帧缓冲重放的 Host 启动补发）整批帧静默丢弃。先停进页面级
  // 停机坪，桥安装时统一按序放行。
  const deliverSidecarFrame = (frame: string): void => {
    const payload = JSON.stringify(frame);
    void renderer
      .command("Runtime.evaluate", {
        expression: `(() => { const frame = ${payload}; if (typeof window.__harnessmixSidecarReceiveV1 === "function") window.__harnessmixSidecarReceiveV1(frame); else (window.__harnessmixPendingSidecarFramesV1 ??= []).push(frame); })()`,
      })
      .catch(() => undefined);
  };
  try {
    await renderer.command("Runtime.enable");
    await renderer.command("Page.enable");
    if (sidecar) {
      if (!renderer.on) throw new Error("Renderer CDP binding events are unavailable");
      await renderer
        .command("Runtime.removeBinding", { name: "__harnessmixSidecarSendV1" })
        .catch(() => undefined);
      await renderer.command("Runtime.addBinding", { name: "__harnessmixSidecarSendV1" });
      renderer.on("Runtime.bindingCalled", (params) => {
        if (
          !isRecord(params) ||
          params.name !== "__harnessmixSidecarSendV1" ||
          typeof params.payload !== "string"
        ) {
          return;
        }
        try {
          sidecar.send(params.payload);
        } catch (error) {
          deliverSidecarFrame(JSON.stringify({ harnessmixSidecarFailure: String(error) }));
        }
      });
      detachSidecar = sidecar.onFrame((frame) => {
        deliverSidecarFrame(frame);
      });
    }
    await renderer.command("Page.addScriptToEvaluateOnNewDocument", { source: rendererSource });
    await evaluateSource(renderer, rendererSource);
    const draftPrewarmPolicy = await operations.installDraftPrewarmPolicy(renderer);
    const binding = await waitForBinding(renderer, enabledAgents, timeoutMs, pollIntervalMs);
    return {
      renderer,
      snapshot: { target, draftPrewarmPolicy, binding },
      ...(detachSidecar ? { detachSidecar } : {}),
    };
  } catch (error) {
    detachSidecar?.();
    renderer.close();
    throw error;
  }
}

class ActiveRendererCdpControlSession implements RendererCdpControlSession {
  #closed = false;
  #renderer: RendererConnection;
  #snapshot: RendererCdpControlSnapshot;
  #detachSidecar: (() => void) | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly rendererSource: string,
    private readonly sidecar: LocalSidecar | undefined,
    private readonly enabledAgents: readonly string[],
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
    private readonly operations: CdpOperations,
    installed: InstalledTarget,
  ) {
    this.#renderer = installed.renderer;
    this.#snapshot = installed.snapshot;
    this.#detachSidecar = installed.detachSidecar;
  }

  get snapshot(): RendererCdpControlSnapshot {
    return this.#snapshot;
  }

  async ensureInstalled(): Promise<RendererCdpControlSnapshot> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    const target = await waitForPrimaryTarget(
      this.endpoint,
      this.operations,
      this.timeoutMs,
      this.pollIntervalMs,
      this.#snapshot.target.id,
    );
    if (target.id !== this.#snapshot.target.id) {
      await this.#reinstall(target);
      return this.#snapshot;
    }
    try {
      const existing = await readBinding(this.#renderer);
      if (existing === null) await evaluateSource(this.#renderer, this.rendererSource);
      else validateBindingStatus(existing, this.enabledAgents);
      const draftPrewarmPolicy = await this.operations.installDraftPrewarmPolicy(this.#renderer);
      const binding = await waitForBinding(
        this.#renderer,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
      );
      this.#snapshot = { target, draftPrewarmPolicy, binding };
      return this.#snapshot;
    } catch {
      await this.#reinstall(target);
      return this.#snapshot;
    }
  }

  async activateDesktop(): Promise<number> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    await this.#renderer.command("Page.bringToFront");
    return 1;
  }

  executeRenderer<T>(expression: string): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("Renderer CDP Control Session is closed"));
    }
    return this.#renderer.evaluate<T>(expression);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachSidecar?.();
    this.#renderer.close();
  }

  async #reinstall(target: CdpTarget): Promise<void> {
    const replacement = await installTarget(
      target,
      this.rendererSource,
      this.sidecar,
      this.enabledAgents,
      this.timeoutMs,
      this.pollIntervalMs,
      this.operations,
    );
    this.#detachSidecar?.();
    this.#renderer.close();
    this.#renderer = replacement.renderer;
    this.#detachSidecar = replacement.detachSidecar;
    this.#snapshot = replacement.snapshot;
  }
}

const liveOperations: CdpOperations = {
  listTargets: (endpoint) => listCdpTargets(endpoint),
  connect: (webSocketDebuggerUrl) => CdpClient.connect(webSocketDebuggerUrl),
  installDraftPrewarmPolicy: installRendererDraftPrewarmPolicyDirect,
};

export async function createRendererCdpControlSession(
  options: CreateSessionOptions,
): Promise<RendererCdpControlSession> {
  const enabledAgents = options.enabledAgents ?? ["codex", "pi"];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const operations = options.operations ?? liveOperations;
  const target = await waitForPrimaryTarget(
    options.rendererCdpEndpoint,
    operations,
    timeoutMs,
    pollIntervalMs,
  );
  const installed = await installTarget(
    target,
    options.rendererSource,
    options.sidecar,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
  );
  return new ActiveRendererCdpControlSession(
    options.rendererCdpEndpoint,
    options.rendererSource,
    options.sidecar,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    installed,
  );
}

export function installRendererCdpControlSession(
  options: InstallRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  return createRendererCdpControlSession(options);
}

export type RendererCdpFetch = CdpFetch;
export type RendererCdpClientOptions = CdpClientOptions;
