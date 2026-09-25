/**
 * Typed client for the native session-import API. Callers only ever see
 * these fixed methods — never the raw request bridge. Concurrent imports of
 * the same native session are coalesced into one in-flight promise.
 */
import {
  harnessSessionImportSourcesResultSchema,
  harnessSessionListParamsSchema,
  harnessSessionListResultSchema,
  harnessSessionImportParamsSchema,
  harnessSessionImportResultSchema,
  type HarnessSessionImportSourcesResult,
  type HarnessSessionListParams,
  type HarnessSessionListResult,
  type HarnessSessionImportParams,
  type HarnessSessionImportResult,
} from "@harnessmix/shared-contracts";

export interface RendererSessionImportClient {
  listSessionImportSources(): Promise<HarnessSessionImportSourcesResult>;
  listHarnessSessions(input: HarnessSessionListParams): Promise<HarnessSessionListResult>;
  importHarnessSession(input: HarnessSessionImportParams): Promise<HarnessSessionImportResult>;
}

export class RendererSessionImportUnavailableError extends Error {
  constructor() {
    super("Harness Session import is unavailable");
    this.name = "RendererSessionImportUnavailableError";
  }
}

/** -32601 (method unknown) and -32076 (host lacks the feature) both mean unavailable. */
const UNAVAILABLE_CODES = new Set([-32601, -32076]);

export function createRendererSessionImportClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): RendererSessionImportClient {
  const pending = new Map<string, Promise<HarnessSessionImportResult>>();
  const request = async (method: string, params: unknown): Promise<unknown> => {
    try {
      return await send(method, params);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof code === "number" && UNAVAILABLE_CODES.has(code)) {
        throw new RendererSessionImportUnavailableError();
      }
      throw error;
    }
  };
  return {
    async listSessionImportSources() {
      return harnessSessionImportSourcesResultSchema.parse(
        await request("harnessmix/harness/session-import/sources", {}),
      );
    },
    async listHarnessSessions(input) {
      const params = harnessSessionListParamsSchema.parse(input);
      return harnessSessionListResultSchema.parse(
        await request("harnessmix/harness/session-import/list", params),
      );
    },
    async importHarnessSession(input) {
      const params = harnessSessionImportParamsSchema.parse(input);
      const key = JSON.stringify([params.harnessId, params.nativeSessionId]);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const operation = request("harnessmix/harness/session-import/import", params)
        .then((value) => harnessSessionImportResultSchema.parse(value))
        .finally(() => {
          if (pending.get(key) === operation) pending.delete(key);
        });
      pending.set(key, operation);
      return operation;
    },
  };
}
