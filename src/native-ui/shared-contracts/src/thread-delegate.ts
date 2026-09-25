/**
 * Host-side delegation: spawn a child thread under another harness with only
 * the task text as context. The result carries identities for correlation;
 * the full turn projection arrives on the turn/* notification stream, so the
 * embedded `turn` object is intentionally loose.
 */
import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

const taskText = z.string().trim().min(1).max(8000);

export const threadDelegateParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    harnessId: harnessIdSchema,
    task: taskText,
  })
  .strict();

export type ThreadDelegateParams = z.infer<typeof threadDelegateParamsSchema>;

export const threadMessageParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    childThreadId: hostThreadIdSchema,
    task: taskText,
  })
  .strict();

export type ThreadMessageParams = z.infer<typeof threadMessageParamsSchema>;

export const threadDelegationResultSchema = z
  .object({
    childThreadId: hostThreadIdSchema,
    turn: z
      .object({
        id: hostTurnIdSchema,
        status: z.string(),
      })
      .loose(),
  })
  .strict();

export type ThreadDelegationResult = z.infer<typeof threadDelegationResultSchema>;
