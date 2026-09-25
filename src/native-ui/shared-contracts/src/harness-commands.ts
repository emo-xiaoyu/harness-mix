/**
 * Slash-command style native commands a harness exposes. Command ids use a
 * restricted printable charset so they can double as UI keys, and catalog
 * entries must be unique. Execution is accepted-asynchronous: the result only
 * confirms the turn that now carries the command.
 */
import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";
import { jsonObjectSchema } from "./json-value.js";

const commandIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u)
  .brand<"HarnessCommandId">();

export const harnessCommandDescriptorSchema = z
  .object({
    id: commandIdSchema,
    invocation: z.string().min(1).max(128),
    label: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(512).optional(),
    argumentMode: z.enum(["none", "text"]),
  })
  .strict();

export type HarnessCommandDescriptor = z.infer<typeof harnessCommandDescriptorSchema>;

export const harnessCommandCatalogSchema = z
  .object({
    commands: z.array(harnessCommandDescriptorSchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const known = new Set<string>();
    catalog.commands.forEach((command, index) => {
      if (known.has(command.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Harness command IDs must be unique",
          path: ["commands", index, "id"],
        });
      }
      known.add(command.id);
    });
  });

export type HarnessCommandCatalog = z.infer<typeof harnessCommandCatalogSchema>;

export const harnessCommandsInspectParamsSchema = z.object({ harnessId: harnessIdSchema }).strict();

export type HarnessCommandsInspectParams = z.infer<typeof harnessCommandsInspectParamsSchema>;

export const threadCommandsInspectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
  })
  .strict();

export type ThreadCommandsInspectParams = z.infer<typeof threadCommandsInspectParamsSchema>;

export const threadCommandExecuteParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    commandId: commandIdSchema,
    turnId: hostTurnIdSchema.optional(),
    arguments: jsonObjectSchema.optional(),
  })
  .strict();

export type ThreadCommandExecuteParams = z.infer<typeof threadCommandExecuteParamsSchema>;

export const threadCommandExecuteResultSchema = z
  .object({
    accepted: z.literal(true),
    turnId: hostTurnIdSchema,
  })
  .strict();

export type ThreadCommandExecuteResult = z.infer<typeof threadCommandExecuteResultSchema>;
