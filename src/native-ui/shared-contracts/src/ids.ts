/**
 * Branded identifier schemas. The brand keeps host ids from flowing into
 * harness-id slots (and vice versa) at compile time; at runtime every id is
 * merely a string that is not blank after trimming.
 */
import { z } from "zod";

const BLANK_ID_MESSAGE = "Identifier must not be empty or whitespace";

function brandedId<T extends string>() {
  return z
    .string()
    .refine((value) => value.trim().length > 0, { message: BLANK_ID_MESSAGE })
    .brand<T>();
}

export const harnessIdSchema = brandedId<"HarnessId">();
export type HarnessId = z.infer<typeof harnessIdSchema>;

export const hostThreadIdSchema = brandedId<"HostThreadId">();
export type HostThreadId = z.infer<typeof hostThreadIdSchema>;

export const hostTurnIdSchema = brandedId<"HostTurnId">();
export type HostTurnId = z.infer<typeof hostTurnIdSchema>;

export const hostItemIdSchema = brandedId<"HostItemId">();
export type HostItemId = z.infer<typeof hostItemIdSchema>;

export const hostInteractionIdSchema = brandedId<"HostInteractionId">();
export type HostInteractionId = z.infer<typeof hostInteractionIdSchema>;
