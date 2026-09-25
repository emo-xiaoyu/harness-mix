/**
 * Durable pointers into a native harness's own storage. `formatVersion` gates
 * future shape changes; v1 refs pin a session, a single turn inside it, or a
 * named checkpoint. An optional `locator` carries harness-specific addressing
 * hints and must be present-but-never-undefined.
 */
import { z } from "zod";

import { harnessIdSchema } from "./ids.js";
import { jsonValueSchema, rejectExplicitUndefined } from "./json-value.js";
import type { JsonValue } from "./json-value.js";

const nativeId = z.string().refine((value) => value.trim().length > 0, {
  message: "Native identifier must not be empty or whitespace",
});

const sessionV1 = z
  .strictObject({
    harnessId: harnessIdSchema,
    nativeSessionId: nativeId,
    locator: jsonValueSchema.optional(),
    formatVersion: z.literal(1),
  })
  .superRefine(rejectExplicitUndefined(["locator"]));

/** Reassembled optional member (see errors.ts for the exactOptional trick). */
export type NativeSessionRefV1 = Omit<z.infer<typeof sessionV1>, "locator"> & {
  locator?: JsonValue;
};
export const nativeSessionRefV1Schema = sessionV1 as z.ZodType<NativeSessionRefV1>;
export const nativeSessionRefSchema = nativeSessionRefV1Schema;
export type NativeSessionRef = NativeSessionRefV1;

export const nativeTurnRefV1Schema = z.strictObject({
  harnessId: harnessIdSchema,
  nativeSessionId: nativeId,
  nativeTurnKey: nativeId,
  formatVersion: z.literal(1),
});
export type NativeTurnRefV1 = z.infer<typeof nativeTurnRefV1Schema>;
export const nativeTurnRefSchema = nativeTurnRefV1Schema;
export type NativeTurnRef = NativeTurnRefV1;

const checkpointV1 = z
  .strictObject({
    harnessId: harnessIdSchema,
    nativeSessionId: nativeId,
    checkpointId: nativeId,
    locator: jsonValueSchema.optional(),
    formatVersion: z.literal(1),
  })
  .superRefine(rejectExplicitUndefined(["locator"]));

export type NativeCheckpointRefV1 = Omit<z.infer<typeof checkpointV1>, "locator"> & {
  locator?: JsonValue;
};
export const nativeCheckpointRefV1Schema = checkpointV1 as z.ZodType<NativeCheckpointRefV1>;
export const nativeCheckpointRefSchema = nativeCheckpointRefV1Schema;
export type NativeCheckpointRef = NativeCheckpointRefV1;
