import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

const delegationTaskSchema = z.string().trim().min(1).max(8000);

export const threadDelegateParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    harnessId: harnessIdSchema,
    task: delegationTaskSchema,
  })
  .strict();

export type ThreadDelegateParams = z.infer<typeof threadDelegateParamsSchema>;

export const threadMessageParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    childThreadId: hostThreadIdSchema,
    task: delegationTaskSchema,
  })
  .strict();

export type ThreadMessageParams = z.infer<typeof threadMessageParamsSchema>;

// 协作 Turn 的完整投影由 turn/* 通知流承载；结果只需携带身份供客户端关联
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
