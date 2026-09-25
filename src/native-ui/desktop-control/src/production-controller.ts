/**
 * The Desktop Controller main loop: parses launcher arguments, optionally
 * starts the local Host sidecar, installs the renderer bundle into the
 * Desktop with transient-failure retries, serves the attachment gate and
 * keeps monitoring/recovering the session with bounded exponential backoff.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startLocalSidecar, type LocalSidecar } from "./local-sidecar.js";

import {
  startControllerAttachmentServer,
  type ControllerAttachmentServer,
  type StartControllerAttachmentServerOptions,
} from "./controller-attachment-server.js";
import {
  installRendererCdpControlSession,
  type RendererCdpControlSession,
} from "./renderer-cdp-control-session.js";

export interface DesktopControllerOptions {
  rendererCdpEndpoint: string;
  rendererPath: string;
  defaultAgent: "codex" | "pi";
  attachmentPort: number;
  attachmentNonce: string;
}

export interface DesktopControllerReadiness {
  schemaVersion: 2;
  state: "compatible";
  issues: [];
}

export interface DesktopControllerDependencies {
  readRenderer(filePath: string): Promise<string>;
  install(options: {
    rendererCdpEndpoint: string;
    rendererSource: string;
    sidecar?: LocalSidecar;
    enabledAgents: readonly string[];
    timeoutMs: number;
  }): Promise<RendererCdpControlSession>;
  startAttachmentServer(
    options: StartControllerAttachmentServerOptions,
  ): Promise<ControllerAttachmentServer>;
  ready(readiness: DesktopControllerReadiness): void;
  sleep(milliseconds: number): Promise<void>;
  now?(): number;
  monitorIntervalMs: number;
}

const PRODUCTION_INSTALL_TIMEOUT_MS = 90_000;
const RENDERER_CSP_BOOTSTRAP =
  "globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;";
const DESKTOP_CONTROLLER_READINESS_MAX_BYTES = 512;
const TRANSIENT_INSTALL_ATTEMPTS = 3;
const TRANSIENT_INSTALL_RETRY_MS = 250;
const RECOVERY_RETRY_INITIAL_MS = 30_000;
const RECOVERY_RETRY_MAX_MS = 300_000;
const traceStartedAt = Date.now();

function startupTrace(stage: string, detail?: unknown): void {
  if (process.env.HARNESSMIX_STARTUP_TRACE !== "1") return;
  const suffix =
    detail === undefined ? "" : `: ${detail instanceof Error ? detail.message : String(detail)}`;
  console.error(
    `[harnessmix startup +${Date.now() - traceStartedAt}ms] controller: ${stage}${suffix}`,
  );
}

export function serializeDesktopControllerReadiness(
  readiness: DesktopControllerReadiness,
): string {
  if (
    readiness.schemaVersion !== 2 ||
    readiness.state !== "compatible" ||
    !Array.isArray(readiness.issues) ||
    readiness.issues.length !== 0 ||
    Object.keys(readiness).length !== 3
  ) {
    throw new Error("Desktop Controller readiness is invalid");
  }
  const line = JSON.stringify(readiness);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_CONTROLLER_READINESS_MAX_BYTES) {
    throw new Error("Desktop Controller readiness exceeds its size limit");
  }
  return line;
}

const defaultDependencies: DesktopControllerDependencies = {
  readRenderer: (filePath) => readFile(filePath, "utf8"),
  install: installRendererCdpControlSession,
  startAttachmentServer: startControllerAttachmentServer,
  ready: (readiness) => {
    process.stdout.write(`${serializeDesktopControllerReadiness(readiness)}\n`);
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monitorIntervalMs: 500,
};

function normalizeRendererCdpEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("--renderer-cdp-endpoint must be a loopback HTTP origin with an explicit port");
  }
  return url.origin;
}

export function parseDesktopControllerArguments(
  arguments_: readonly string[],
): DesktopControllerOptions {
  const seen: Record<string, string | number> = {};
  const markOnce = (flag: string, value: string | number): void => {
    if (seen[flag] !== undefined) throw new Error(`${flag} may only be provided once`);
    seen[flag] = value;
  };
  const readValue = (flag: string, argument: string, value: string | undefined): string => {
    if (!value) throw new Error(`${flag} requires a value`);
    void argument;
    return value;
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const next = arguments_[index + 1];
    switch (flag) {
      case "--renderer-cdp-endpoint":
        markOnce(flag, normalizeRendererCdpEndpoint(readValue(flag, flag, next)));
        index += 1;
        break;
      case "--renderer": {
        const value = readValue(flag, flag, next);
        if (!path.isAbsolute(value)) throw new Error("--renderer must be an absolute path");
        markOnce(flag, path.normalize(value));
        index += 1;
        break;
      }
      case "--default-agent":
        if (next !== "codex" && next !== "pi") {
          throw new Error("--default-agent must be 'codex' or 'pi'");
        }
        markOnce(flag, next);
        index += 1;
        break;
      case "--attachment-port": {
        const port = Number(next);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new Error("--attachment-port must be a valid TCP port");
        }
        markOnce(flag, port);
        index += 1;
        break;
      }
      case "--attachment-nonce":
        if (next === undefined || !/^[0-9a-f]{32}$/.test(next)) {
          throw new Error("--attachment-nonce must be 32 lowercase hexadecimal characters");
        }
        markOnce(flag, next);
        index += 1;
        break;
      default:
        throw new Error(`unknown Desktop Controller option: ${flag}`);
    }
  }
  const endpoint = seen["--renderer-cdp-endpoint"];
  const rendererPath = seen["--renderer"];
  const defaultAgent = seen["--default-agent"];
  const attachmentPort = seen["--attachment-port"];
  const attachmentNonce = seen["--attachment-nonce"];
  if (typeof endpoint !== "string") throw new Error("--renderer-cdp-endpoint is required");
  if (typeof rendererPath !== "string") throw new Error("--renderer is required");
  if (defaultAgent !== "codex" && defaultAgent !== "pi") {
    throw new Error("--default-agent is required");
  }
  if (typeof attachmentPort !== "number") throw new Error("--attachment-port is required");
  if (typeof attachmentNonce !== "string") throw new Error("--attachment-nonce is required");
  return {
    rendererCdpEndpoint: endpoint,
    rendererPath,
    defaultAgent,
    attachmentPort,
    attachmentNonce,
  };
}

/** Renderer reloads destroy evaluation contexts mid-flight; those are retryable. */
function isTransientRendererInstallError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Execution context was destroyed") ||
      message.includes("Promise was collected")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function installProductionSession(
  options: Parameters<DesktopControllerDependencies["install"]>[0],
  dependencies: DesktopControllerDependencies,
): Promise<RendererCdpControlSession> {
  for (let attempt = 1; attempt <= TRANSIENT_INSTALL_ATTEMPTS; attempt += 1) {
    try {
      return await dependencies.install(options);
    } catch (error) {
      if (attempt === TRANSIENT_INSTALL_ATTEMPTS || !isTransientRendererInstallError(error)) {
        throw error;
      }
      await dependencies.sleep(TRANSIENT_INSTALL_RETRY_MS);
    }
  }
  throw new Error("Desktop Controller exhausted Renderer installation attempts");
}

export async function runDesktopController(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies = defaultDependencies,
): Promise<void> {
  const sidecarScript = process.env.HARNESSMIX_SIDECAR_SCRIPT;
  const stockCodexPath = process.env.HARNESSMIX_STOCK_CODEX_PATH;
  const sidecar =
    sidecarScript && stockCodexPath
      ? startLocalSidecar(process.execPath, sidecarScript, stockCodexPath)
      : undefined;
  const configuration = `Object.defineProperty(window, "__harnessmixProductionConfigV1", { configurable: true, value: { defaultAgent: ${JSON.stringify(options.defaultAgent)} } });\nwindow.__harnessmixSidecarModeV1 = ${sidecar ? "true" : "false"};`;
  const now = dependencies.now ?? Date.now;

  let session: RendererCdpControlSession | undefined;
  let nextRecoveryAt = 0;
  let recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
  const scheduleRecoveryFailure = (): void => {
    nextRecoveryAt = now() + recoveryDelayMs;
    recoveryDelayMs = Math.min(recoveryDelayMs * 2, RECOVERY_RETRY_MAX_MS);
  };
  const scheduleRecoverySuccess = (): void => {
    nextRecoveryAt = 0;
    recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
  };

  const createSession = async (): Promise<RendererCdpControlSession> => {
    startupTrace("reading Renderer bundle");
    const rendererSource = await dependencies.readRenderer(options.rendererPath);
    if (rendererSource.trim().length === 0) {
      throw new Error("production Renderer Bundle is empty");
    }
    startupTrace("installing Renderer Session");
    const installed = await installProductionSession(
      {
        rendererCdpEndpoint: options.rendererCdpEndpoint,
        rendererSource: `${RENDERER_CSP_BOOTSTRAP}\n${configuration}\n${rendererSource}`,
        ...(sidecar ? { sidecar } : {}),
        enabledAgents: [
          "codex",
          "pi",
          "claude-code",
          "deepseek-harness",
          "omp",
          "opencode",
          "grok",
          "openclaw",
          "hermes",
          "antigravity",
          "qoder",
          "codebuddy",
          "kiro-cli",
          "cursor-cli",
          "codex-harness",
          "zcode",
          "trae",
          "cline",
        ],
        timeoutMs: PRODUCTION_INSTALL_TIMEOUT_MS,
      },
      dependencies,
    );
    startupTrace("Renderer Session installed");
    return installed;
  };

  startupTrace("initialization started");
  try {
    session = await createSession();
    scheduleRecoverySuccess();
  } catch (error) {
    startupTrace("initial Renderer Session unavailable", error);
    session = undefined;
    scheduleRecoveryFailure();
  }

  // Serialize all session-touching work: attachment requests and the monitor
  // loop must never interleave an install with a close.
  let operation = Promise.resolve<unknown>(undefined);
  const useSession = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = operation.then(callback, callback);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const recoverSession = async (): Promise<RendererCdpControlSession> => {
    try {
      if (!session) session = await createSession();
      else await session.ensureInstalled();
      scheduleRecoverySuccess();
      return session;
    } catch (error) {
      session?.close();
      session = undefined;
      scheduleRecoveryFailure();
      throw error;
    }
  };

  let attachmentServer: ControllerAttachmentServer | undefined;
  try {
    startupTrace("starting attachment server");
    attachmentServer = await dependencies.startAttachmentServer({
      port: options.attachmentPort,
      nonce: options.attachmentNonce,
      attach: () =>
        useSession(async () => {
          const current = await recoverSession();
          await current.activateDesktop();
        }),
    });
    startupTrace("attachment server ready");
    startupTrace("publishing readiness");
    dependencies.ready({ schemaVersion: 2, state: "compatible", issues: [] });
    while (!signal.aborted) {
      await dependencies.sleep(dependencies.monitorIntervalMs);
      if (signal.aborted) continue;
      await useSession(async () => {
        if (!session && now() < nextRecoveryAt) return;
        try {
          await recoverSession();
        } catch {
          // Renderer integration stays unavailable until a later bounded retry.
        }
      });
    }
  } finally {
    await attachmentServer?.close();
    await operation;
    session?.close();
    session = undefined;
    await sidecar?.close();
  }
}
