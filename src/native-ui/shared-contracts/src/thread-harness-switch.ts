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

/**
 * 原地切换 Harness：线程（会话历史/文件现场）保留在 Host 侧，仅更换底层原生会话。
 * 切换后首轮发送由 Host 自动附带一次性上下文信封；note 会并入该信封。
 */
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
