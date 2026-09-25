/**
 * Error envelope every harnessmix JSON-RPC error response carries. Optional
 * diagnostic fields must be truly absent — an explicit `undefined` would leak
 * into JSON.stringify differently per transport.
 */
import { z } from "zod";

import { rejectExplicitUndefined } from "./json-value.js";

const OPTIONAL_KEYS = ["diagnostic", "stage", "durationMs", "stderrTail"] as const;

export const harnessmixErrorSchema = z
  .strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    diagnostic: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    stderrTail: z.string().min(1).optional(),
  })
  .superRefine(rejectExplicitUndefined(OPTIONAL_KEYS));

/**
 * zod infers optional members as `T | undefined` even when the schema would
 * reject explicit undefineds; under exactOptionalPropertyTypes the inferred
 * type therefore has to be reassembled by hand.
 */
export type HarnessMixError = Omit<
  z.infer<typeof harnessmixErrorSchema>,
  (typeof OPTIONAL_KEYS)[number]
> & {
  diagnostic?: string;
  stage?: string;
  durationMs?: number;
  stderrTail?: string;
};
