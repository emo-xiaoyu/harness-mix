import { z } from "zod";

import { rejectExplicitUndefined } from "./json-value.js";

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
  .superRefine(rejectExplicitUndefined(["diagnostic", "stage", "durationMs", "stderrTail"]));

export type HarnessMixError = Omit<
  z.infer<typeof harnessmixErrorSchema>,
  "diagnostic" | "stage" | "durationMs" | "stderrTail"
> & {
  diagnostic?: string;
  stage?: string;
  durationMs?: number;
  stderrTail?: string;
};
