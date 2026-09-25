/**
 * Permission-mode catalogs as harnesses report them. A catalog must be
 * non-empty, duplicate-free, and its default must name one of its own modes.
 */
import { z } from "zod";

import { nonBlankText, rejectDuplicateKeys, TRANSPORT_SAFE_ID_SOURCE } from "./constraints.js";
import { hostThreadIdSchema } from "./ids.js";

export const HARNESS_PERMISSION_MODE_ID_MAX_LENGTH = 128;
export const HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH = 256;
export const HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH = 1_024;
export const HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH = 32;

export const harnessPermissionModeIdSchema = nonBlankText()
  .max(HARNESS_PERMISSION_MODE_ID_MAX_LENGTH)
  .regex(new RegExp(TRANSPORT_SAFE_ID_SOURCE, "u"), "Permission Mode ID must use transport-safe characters")
  .brand<"HarnessPermissionModeId">();

export type HarnessPermissionModeId = z.infer<typeof harnessPermissionModeIdSchema>;

export const harnessPermissionModeSchema = z
  .object({
    id: harnessPermissionModeIdSchema,
    label: nonBlankText().max(HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH),
    description: nonBlankText().max(HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH).optional(),
    dangerous: z.boolean().optional(),
  })
  .strict();

export type HarnessPermissionMode = z.infer<typeof harnessPermissionModeSchema>;

export const harnessPermissionModeCatalogSchema = z
  .object({
    modes: z
      .array(harnessPermissionModeSchema)
      .min(1)
      .max(HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH),
    defaultModeId: harnessPermissionModeIdSchema,
  })
  .strict()
  .superRefine((catalog, ctx) => {
    rejectDuplicateKeys(
      catalog.modes,
      (mode) => mode.id,
      "Permission Mode IDs must be unique",
      (index) => ["modes", index, "id"],
      ctx,
    );
    const known = new Set(catalog.modes.map((mode) => mode.id));
    if (!known.has(catalog.defaultModeId)) {
      ctx.addIssue({
        code: "custom",
        message: "Default Permission Mode must exist in the catalog",
        path: ["defaultModeId"],
      });
    }
  });

export type HarnessPermissionModeCatalog = z.infer<typeof harnessPermissionModeCatalogSchema>;

export const threadPermissionModeSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    permissionModeId: harnessPermissionModeIdSchema,
  })
  .strict();

export type ThreadPermissionModeSelectParams = z.infer<
  typeof threadPermissionModeSelectParamsSchema
>;
