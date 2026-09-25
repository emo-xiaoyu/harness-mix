/**
 * In-place harness switch: the thread (history + file state) stays with the
 * host while the underlying native session is replaced. The first send after
 * a switch automatically attaches a one-shot context envelope; `note` is
 * folded into that envelope.
 */
import { z } from "zod";

import { hostThreadIdSchema } from "./ids.js";

export const harnessHandoffIntentSchema = z.enum(["continue", "execute-plan", "review", "reanalyze"]);
export type HarnessHandoffIntent = z.infer<typeof harnessHandoffIntentSchema>;

export const harnessHandoffIncludesSchema = z
  .object({
    conversation: z.boolean(),
    plan: z.boolean(),
    evidence: z.boolean(),
    files: z.boolean(),
    unresolved: z.boolean(),
  })
  .strict();
export type HarnessHandoffIncludes = z.infer<typeof harnessHandoffIncludesSchema>;

export const threadHarnessSwitchParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    harnessId: z.string().min(1),
    note: z.string().max(2000).optional(),
    intent: harnessHandoffIntentSchema.optional(),
    includes: harnessHandoffIncludesSchema.optional(),
  })
  .strict();

export type ThreadHarnessSwitchParams = z.infer<typeof threadHarnessSwitchParamsSchema>;

export const threadHarnessSwitchResultSchema = z
  .object({
    threadId: hostThreadIdSchema,
    checkpointId: z.string().min(1),
    phase: z.enum(["ready", "rolled-back", "cancelled"]).optional(),
    fromHarnessId: z.string().min(1).optional(),
    toHarnessId: z.string().min(1).optional(),
  })
  .strict();

export type ThreadHarnessSwitchResult = z.infer<typeof threadHarnessSwitchResultSchema>;
