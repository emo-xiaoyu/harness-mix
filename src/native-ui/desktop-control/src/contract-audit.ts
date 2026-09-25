/**
 * Read-only contract audit: drives the renderer-side audit entrypoint
 * (`window.__harnessmixContractAuditV1`) through the Electron main process
 * and validates the counting result against the schema below. Used by the
 * compatibility checks that decide whether a Desktop build is supported.
 */
import { CdpClient, getCdpBrowserVersion, type CdpBrowserVersion } from "./cdp-client.js";
import {
  inspectElectronWebContents,
  selectRendererWebContents,
  waitForInspectorTarget,
  type ElectronRendererSummary,
} from "./renderer-control-session.js";

export const DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION = 1 as const;

export type ContractAuditCardinalityState = "unique" | "missing" | "ambiguous" | "inactive";

export interface RendererContractAuditInspection {
  schemaVersion: 1;
  composer: {
    composerCount: number;
    visibleComposerCount: number;
    activeComposerCount: number;
    modelCandidateCount: number;
    verifiedModelCandidateCount: number;
    permissionCandidateCount: number;
    verifiedPermissionCandidateCount: number;
    contextUsageCandidateCount: number;
    verifiedContextUsageCandidateCount: number;
    sendButtonCount: number;
    trailingActionOwnerCount: number;
  };
  model: {
    draftCount: number;
    conversationCount: number;
    missingCount: number;
    ambiguousCount: number;
  };
  settings: {
    headerCount: number;
    visibleHeaderCount: number;
    insertionPointCount: number;
  };
  sidebar: {
    rowCount: number;
    titleOwnerCount: number;
    resolvedThreadCount: number;
    ambiguousThreadCount: number;
  };
  transcript: {
    turnCount: number;
    itemNodeCount: number;
    identifiedItemCount: number;
    textBodyCount: number;
    textBodyOwnerCount: number;
  };
  fork: {
    annotatedResponseCount: number;
    candidateButtonCount: number;
    verifiedButtonCount: number;
  };
  production: {
    bindingPresent: boolean;
    adapterState: "installing" | "ready" | "unsupported" | "absent";
    adapterReason: string;
    titlePolicyState: "ready" | "absent" | "unknown";
    draftPrewarmPolicyState: "ready" | "absent" | "unknown";
  };
}

export interface DesktopContractAuditObservation {
  schemaVersion: typeof DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION;
  browser: {
    browser: string;
    protocolVersion: string;
  };
  renderer: ElectronRendererSummary;
  contracts: RendererContractAuditInspection;
}

export interface InspectDesktopContractsOptions {
  endpoint: string;
  inspectorEndpoint: string;
  rendererAuditSource: string;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact key-set check: no unknown fields, no missing fields. */
function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function countField(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function countGroup<T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): { [K in T[number]]: number } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  requireExactKeys(value, keys, label);
  return Object.fromEntries(keys.map((key) => [key, countField(value[key], `${label}.${key}`)])) as {
    [K in T[number]]: number;
  };
}

const PRODUCTION_ADAPTER_STATES = ["installing", "ready", "unsupported", "absent"] as const;
const POLICY_STATES = ["ready", "absent", "unknown"] as const;

export function validateRendererContractAuditInspection(
  value: unknown,
): RendererContractAuditInspection {
  if (!isRecord(value)) throw new Error("Renderer contract audit must be an object");
  requireExactKeys(
    value,
    ["schemaVersion", "composer", "model", "settings", "sidebar", "transcript", "fork", "production"],
    "Renderer contract audit",
  );
  if (value.schemaVersion !== 1) throw new Error("Renderer contract audit schema is unsupported");
  const production = value.production;
  if (!isRecord(production)) {
    throw new Error("Renderer contract audit production state is invalid");
  }
  requireExactKeys(
    production,
    ["bindingPresent", "adapterState", "adapterReason", "titlePolicyState", "draftPrewarmPolicyState"],
    "Renderer contract audit production state",
  );
  if (
    typeof production.bindingPresent !== "boolean" ||
    !PRODUCTION_ADAPTER_STATES.includes(String(production.adapterState) as (typeof PRODUCTION_ADAPTER_STATES)[number]) ||
    typeof production.adapterReason !== "string" ||
    production.adapterReason.length > 64 ||
    !POLICY_STATES.includes(String(production.titlePolicyState) as (typeof POLICY_STATES)[number]) ||
    !POLICY_STATES.includes(String(production.draftPrewarmPolicyState) as (typeof POLICY_STATES)[number])
  ) {
    throw new Error("Renderer contract audit production state is invalid");
  }
  return {
    schemaVersion: 1,
    composer: countGroup(
      value.composer,
      [
        "composerCount",
        "visibleComposerCount",
        "activeComposerCount",
        "modelCandidateCount",
        "verifiedModelCandidateCount",
        "permissionCandidateCount",
        "verifiedPermissionCandidateCount",
        "contextUsageCandidateCount",
        "verifiedContextUsageCandidateCount",
        "sendButtonCount",
        "trailingActionOwnerCount",
      ] as const,
      "Renderer composer contract",
    ),
    model: countGroup(
      value.model,
      ["draftCount", "conversationCount", "missingCount", "ambiguousCount"] as const,
      "Renderer model contract",
    ),
    settings: countGroup(
      value.settings,
      ["headerCount", "visibleHeaderCount", "insertionPointCount"] as const,
      "Renderer settings contract",
    ),
    sidebar: countGroup(
      value.sidebar,
      ["rowCount", "titleOwnerCount", "resolvedThreadCount", "ambiguousThreadCount"] as const,
      "Renderer sidebar contract",
    ),
    transcript: countGroup(
      value.transcript,
      ["turnCount", "itemNodeCount", "identifiedItemCount", "textBodyCount", "textBodyOwnerCount"] as const,
      "Renderer transcript contract",
    ),
    fork: countGroup(
      value.fork,
      ["annotatedResponseCount", "candidateButtonCount", "verifiedButtonCount"] as const,
      "Renderer fork contract",
    ),
    production: {
      bindingPresent: production.bindingPresent,
      adapterState:
        production.adapterState as RendererContractAuditInspection["production"]["adapterState"],
      adapterReason: production.adapterReason,
      titlePolicyState:
        production.titlePolicyState as RendererContractAuditInspection["production"]["titlePolicyState"],
      draftPrewarmPolicyState:
        production.draftPrewarmPolicyState as RendererContractAuditInspection["production"]["draftPrewarmPolicyState"],
    },
  };
}

const electronModuleExpression = `(() => {
  const mainModule = process.mainModule;
  if (mainModule != null && typeof mainModule.require === 'function') {
    return mainModule.require('electron');
  }
  const { createRequire } = process.getBuiltinModule('module');
  return createRequire(process.execPath)('electron');
})()`;

async function executeReadOnlyAudit(
  inspector: Pick<CdpClient, "evaluate">,
  rendererWebContentsId: number,
  source: string,
): Promise<unknown> {
  return inspector.evaluate<unknown>(`(async () => {
    const { webContents } = ${electronModuleExpression};
    const contents = webContents.fromId(${rendererWebContentsId});
    if (contents == null || contents.isDestroyed()) throw new Error('Renderer webContents is unavailable');
    return contents.executeJavaScript(${JSON.stringify(`(() => {
      const previous = window.__harnessmixContractAuditV1;
      ${source}
      try {
        const audit = window.__harnessmixContractAuditV1;
        if (audit == null || typeof audit.inspect !== 'function') {
          throw new Error('Renderer contract audit entry is unavailable');
        }
        return audit.inspect();
      } finally {
        if (previous === undefined) delete window.__harnessmixContractAuditV1;
        else window.__harnessmixContractAuditV1 = previous;
      }
    })()`)}, true);
  })()`);
}

export async function inspectDesktopContracts(
  options: InspectDesktopContractsOptions,
): Promise<DesktopContractAuditObservation> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const [browser, inspectorTarget] = await Promise.all([
    getCdpBrowserVersion(options.endpoint),
    waitForInspectorTarget(options.inspectorEndpoint, { timeoutMs }),
  ]);
  const inspector = await CdpClient.connect(inspectorTarget.webSocketDebuggerUrl);
  try {
    await inspector.command("Runtime.enable");
    const inventory = await inspectElectronWebContents(inspector);
    const renderer = selectRendererWebContents(inventory);
    if (!renderer) throw new Error("Contract audit did not find a primary Renderer");
    const contracts = validateRendererContractAuditInspection(
      await executeReadOnlyAudit(inspector, renderer.id, options.rendererAuditSource),
    );
    return {
      schemaVersion: DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION,
      browser: { browser: browser.browser, protocolVersion: browser.protocolVersion },
      renderer,
      contracts,
    };
  } finally {
    inspector.close();
  }
}
