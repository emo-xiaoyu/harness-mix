/**
 * Plugin routes travel through UI surfaces that reject arbitrary payloads
 * (composer text, thread titles), so a route is hex-encoded JSON under a
 * prefix. Decoding rejects anything noncanonical — reordered keys, extra
 * fields, mixed-case hex — because the re-encoded form must equal the input
 * byte-for-byte before the route is trusted.
 */
import { z } from "zod";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessPermissionModeIdSchema } from "./harness-permission-modes.js";
import { harnessPluginIdSchema } from "./harness-plugins.js";

export const HARNESS_PLUGIN_ROUTE_PREFIX = "harnessmix/plugin-v1@";
const MAX_ROUTE_LENGTH = 4096;
const INVALID_ROUTE = "Invalid Harness plugin route";

export const harnessPluginRouteSchema = z
  .object({
    harnessId: harnessPluginIdSchema,
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .strict();
export type HarnessPluginRoute = z.infer<typeof harnessPluginRouteSchema>;

/** Every identity field is transport-safe ASCII; no Node.js Buffer dependency. */
export function encodeHarnessPluginRoute(route: HarnessPluginRoute): string {
  const parsed = harnessPluginRouteSchema.parse(route);
  const payload = [...JSON.stringify(parsed)]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return `${HARNESS_PLUGIN_ROUTE_PREFIX}${payload}`;
}

/**
 * Returns `null` when the value belongs to another protocol entirely; throws
 * on anything that carries the prefix but fails canonical-form validation.
 */
export function decodeHarnessPluginRoute(value: unknown): HarnessPluginRoute | null {
  if (typeof value !== "string" || !value.startsWith(HARNESS_PLUGIN_ROUTE_PREFIX)) return null;
  const payload = value.slice(HARNESS_PLUGIN_ROUTE_PREFIX.length);
  if (value.length > MAX_ROUTE_LENGTH || !/^(?:[a-f0-9]{2})+$/u.test(payload)) {
    throw new Error(INVALID_ROUTE);
  }
  try {
    const json = payload.replace(/[a-f0-9]{2}/gu, (byte) =>
      String.fromCharCode(Number.parseInt(byte, 16)),
    );
    const decoded = harnessPluginRouteSchema.parse(JSON.parse(json));
    if (encodeHarnessPluginRoute(decoded) !== value) {
      throw new Error("Noncanonical Harness plugin route");
    }
    return decoded;
  } catch {
    throw new Error(INVALID_ROUTE);
  }
}
