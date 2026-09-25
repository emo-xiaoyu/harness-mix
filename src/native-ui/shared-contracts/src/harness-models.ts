/**
 * Model / thinking-option / permission-mode catalog contracts and the
 * inspection shapes the renderer builds its pickers from. Catalog integrity
 * rules (unique refs, defaults that exist, supported options that exist) are
 * enforced here so no consumer has to re-check them.
 */
import { z } from "zod";

import { nonBlankText, rejectDuplicateKeys, TRANSPORT_SAFE_ID_SOURCE } from "./constraints.js";
import { harnessmixErrorSchema } from "./errors.js";
import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "./harness-permission-modes.js";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";
import {
  accountCreditsSnapshotSchema,
  threadUsageSnapshotSchema,
  type AccountCreditsSnapshot,
} from "./thread-usage.js";

export const HARNESS_MODEL_REF_MAX_LENGTH = 512;
export const HARNESS_MODEL_LABEL_MAX_LENGTH = 256;
export const HARNESS_THINKING_OPTION_ID_MAX_LENGTH = 128;
export const THREAD_OWNERSHIP_LIST_MAX_LENGTH = 100;

const TRANSPORT_SAFE_ID = new RegExp(TRANSPORT_SAFE_ID_SOURCE, "u");

export const harnessModelRefIdSchema = nonBlankText()
  .max(HARNESS_MODEL_REF_MAX_LENGTH)
  .regex(TRANSPORT_SAFE_ID, "Model Ref must use transport-safe opaque characters")
  .brand<"HarnessModelRefId">();

export const harnessModelRefSchema = z
  .object({
    id: harnessModelRefIdSchema,
  })
  .strict();

export type HarnessModelRef = z.infer<typeof harnessModelRefSchema>;

export const harnessThinkingOptionIdSchema = nonBlankText()
  .max(HARNESS_THINKING_OPTION_ID_MAX_LENGTH)
  .regex(TRANSPORT_SAFE_ID, "Thinking option ID must use transport-safe characters")
  .brand<"HarnessThinkingOptionId">();

export type HarnessThinkingOptionId = z.infer<typeof harnessThinkingOptionIdSchema>;

export const harnessResolvedModelLabelSchema = nonBlankText().max(
  HARNESS_MODEL_LABEL_MAX_LENGTH,
);

export const harnessThinkingOptionSchema = z
  .object({
    id: harnessThinkingOptionIdSchema,
    label: nonBlankText().max(HARNESS_MODEL_LABEL_MAX_LENGTH),
  })
  .strict();

export type HarnessThinkingOption = z.infer<typeof harnessThinkingOptionSchema>;

export const harnessModelSchema = z
  .object({
    ref: harnessModelRefSchema,
    label: nonBlankText().max(HARNESS_MODEL_LABEL_MAX_LENGTH),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    supportedThinkingOptionIds: z.array(harnessThinkingOptionIdSchema).optional(),
  })
  .strict();

export type HarnessModel = z.infer<typeof harnessModelSchema>;

const thinkingOptionsWithUniqueIds = z
  .array(harnessThinkingOptionSchema)
  .superRefine((options, ctx) =>
    rejectDuplicateKeys(
      options,
      (option) => option.id,
      "Thinking option IDs must be unique",
      (index) => [index, "id"],
      ctx,
    ),
  );

export const harnessModelCatalogSchema = z
  .object({
    models: z.array(harnessModelSchema),
    defaultModel: harnessModelRefSchema.optional(),
    thinkingOptions: thinkingOptionsWithUniqueIds,
    defaultThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const modelRefs = new Set<string>();
    const optionIds = new Set(catalog.thinkingOptions.map((option) => option.id));
    catalog.models.forEach((model, index) => {
      if (modelRefs.has(model.ref.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Model Catalog refs must be unique",
          path: ["models", index, "ref", "id"],
        });
      }
      modelRefs.add(model.ref.id);
      const seenPerModel = new Set<string>();
      (model.supportedThinkingOptionIds ?? []).forEach((optionId, optionIndex) => {
        if (seenPerModel.has(optionId)) {
          ctx.addIssue({
            code: "custom",
            message: "Supported Thinking option IDs must be unique per Model",
            path: ["models", index, "supportedThinkingOptionIds", optionIndex],
          });
        }
        seenPerModel.add(optionId);
        if (!optionIds.has(optionId)) {
          ctx.addIssue({
            code: "custom",
            message: "Supported Thinking option must exist in the catalog",
            path: ["models", index, "supportedThinkingOptionIds", optionIndex],
          });
        }
      });
    });
    if (catalog.defaultModel && !modelRefs.has(catalog.defaultModel.id)) {
      ctx.addIssue({
        code: "custom",
        message: "Default Model must exist in the Model Catalog",
        path: ["defaultModel", "id"],
      });
    }
    if (catalog.defaultThinkingOptionId && !optionIds.has(catalog.defaultThinkingOptionId)) {
      ctx.addIssue({
        code: "custom",
        message: "Default Thinking option must exist in the catalog",
        path: ["defaultThinkingOptionId"],
      });
    }
  });

export type HarnessModelCatalog = z.infer<typeof harnessModelCatalogSchema>;

const harnessHistoryCapabilitiesSchema = z
  .object({
    fork: z.boolean(),
    forkAcrossCwd: z.boolean(),
    rollbackLastTurn: z.boolean(),
  })
  .strict()
  .refine((history) => history.fork || !history.forkAcrossCwd, {
    path: ["forkAcrossCwd"],
    message: "Cross-cwd Fork requires exact history Fork support",
  });

export const harnessPermissionModeScopeSchema = z.enum(["live", "atCreate"]);

export type HarnessPermissionModeScope = z.infer<typeof harnessPermissionModeScopeSchema>;

export function permissionModeFixedAtCreate(configuration: {
  permissionModeScope?: HarnessPermissionModeScope;
}): boolean {
  return configuration.permissionModeScope === "atCreate";
}

export const harnessSessionCapabilitiesSchema = z
  .object({
    configuration: z
      .object({
        selectModel: z.boolean(),
        selectThinkingOption: z.boolean(),
        selectPermissionMode: z.boolean(),
        permissionModeScope: harnessPermissionModeScopeSchema.default("live"),
      })
      .strict(),
    history: harnessHistoryCapabilitiesSchema,
    workspace: z
      .object({
        git: z.literal(true),
        worktree: z.literal(true),
        finalDiff: z.literal(true),
        nativeDiff: z.boolean(),
        nativePatch: z.boolean(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        observe: z.boolean(),
        readTranscript: z.boolean(),
      })
      .strict()
      .optional(),
    autonomousTurns: z
      .object({
        observe: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type HarnessSessionCapabilities = z.infer<typeof harnessSessionCapabilitiesSchema>;

export const harnessConfigurationStateSchema = z
  .object({
    effectiveModel: harnessModelRefSchema.optional(),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    effectiveThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    availableThinkingOptions: thinkingOptionsWithUniqueIds.optional(),
    effectivePermissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (
      state.effectiveThinkingOptionId &&
      state.availableThinkingOptions &&
      !state.availableThinkingOptions.some((option) => option.id === state.effectiveThinkingOptionId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Effective Thinking option must be currently available",
        path: ["effectiveThinkingOptionId"],
      });
    }
  });

export type HarnessConfigurationState = z.infer<typeof harnessConfigurationStateSchema>;

export const harnessModelSelectionStateSchema = harnessConfigurationStateSchema;
export type HarnessModelSelectionState = HarnessConfigurationState;

export const harnessWebUiCapabilitySchema = z
  .object({
    open: z.literal(true),
  })
  .strict();

export type HarnessWebUiCapability = z.infer<typeof harnessWebUiCapabilitySchema>;

const readyHarnessInspectionSchema = z
  .object({
    status: z.literal("ready"),
    catalog: harnessModelCatalogSchema,
    permissionModes: harnessPermissionModeCatalogSchema.optional(),
    capabilities: harnessSessionCapabilitiesSchema,
    webUi: harnessWebUiCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((inspection, ctx) => {
    const selectable = inspection.capabilities.configuration.selectPermissionMode;
    if (selectable !== Boolean(inspection.permissionModes)) {
      ctx.addIssue({
        code: "custom",
        message: "Permission Mode catalog and capability must agree",
        path: selectable
          ? ["permissionModes"]
          : ["capabilities", "configuration", "selectPermissionMode"],
      });
    }
  });

const failedHarnessInspectionSchema = z
  .object({
    status: z.enum(["notInstalled", "unavailable", "error"]),
    error: harnessmixErrorSchema,
  })
  .strict();

export const harnessInspectionSchema = z.union([
  readyHarnessInspectionSchema,
  failedHarnessInspectionSchema,
]);

export type HarnessInspection = z.infer<typeof harnessInspectionSchema>;

export const harnessInspectParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
    cwd: nonBlankText().max(16_384).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export type HarnessInspectParams = z.infer<typeof harnessInspectParamsSchema>;

export const harnessWebUiOpenParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
  })
  .strict();

export type HarnessWebUiOpenParams = z.infer<typeof harnessWebUiOpenParamsSchema>;

export const harnessWebUiOpenResultSchema = z.object({}).strict();

export type HarnessWebUiOpenResult = z.infer<typeof harnessWebUiOpenResultSchema>;

export const threadModelSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    model: harnessModelRefSchema,
  })
  .strict();

export type ThreadModelSelectParams = z.infer<typeof threadModelSelectParamsSchema>;

export const threadThinkingSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    thinkingOptionId: harnessThinkingOptionIdSchema,
  })
  .strict();

export type ThreadThinkingSelectParams = z.infer<typeof threadThinkingSelectParamsSchema>;

export const threadInspectionParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
  })
  .strict();

export type ThreadInspectionParams = z.infer<typeof threadInspectionParamsSchema>;

const codexThreadInspectionSchema = z
  .object({
    owner: z.literal("codex"),
    accountId: nonBlankText().optional(),
    locked: z.literal(true),
  })
  .strict();

const externalThreadInspectionSchema = z
  .object({
    owner: z.literal("external"),
    harnessId: nonBlankText().max(256),
    transportModelId: nonBlankText().max(1_024),
    effectiveModel: harnessModelRefSchema.optional(),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    effectiveThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    availableThinkingOptions: thinkingOptionsWithUniqueIds.optional(),
    effectivePermissionModeId: harnessPermissionModeIdSchema.optional(),
    history: harnessHistoryCapabilitiesSchema,
    workspace: z
      .object({
        hostManaged: z.literal(true),
        git: z
          .object({
            available: z.boolean(),
            root: z.string().optional(),
            head: z.string().optional(),
            branch: z.string().nullable().optional(),
            dirty: z.boolean().optional(),
            reason: z.enum(["not-a-git-repository", "git-unavailable"]).optional(),
          })
          .strict(),
        worktree: z
          .object({
            available: z.boolean(),
            active: z.boolean(),
            branch: z.string().optional(),
            root: z.string().optional(),
          })
          .strict(),
        finalDiff: z
          .object({
            available: z.literal(true),
            source: z.literal("snapshot"),
          })
          .strict(),
        nativeDiff: z.boolean(),
        nativePatch: z.boolean(),
      })
      .strict()
      .optional(),
    usage: threadUsageSnapshotSchema.optional(),
    accountCredits: accountCreditsSnapshotSchema.optional(),
    locked: z.literal(true),
  })
  .strict();

export const threadInspectionSchema = z.discriminatedUnion("owner", [
  codexThreadInspectionSchema,
  externalThreadInspectionSchema,
]);

export type ThreadInspection = z.infer<typeof threadInspectionSchema>;

export const threadOwnershipListParamsSchema = z
  .object({
    threadIds: z.array(hostThreadIdSchema).min(1).max(THREAD_OWNERSHIP_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threadIds }, ctx) =>
    rejectDuplicateKeys(
      threadIds,
      (threadId) => threadId,
      "Thread ownership-list IDs must be unique",
      (index) => ["threadIds", index],
      ctx,
    ),
  );

export type ThreadOwnershipListParams = z.infer<typeof threadOwnershipListParamsSchema>;

const codexThreadOwnershipSchema = z
  .object({
    threadId: hostThreadIdSchema,
    owner: z.literal("codex"),
  })
  .strict();

const externalThreadOwnershipSchema = z
  .object({
    threadId: hostThreadIdSchema,
    owner: z.literal("external"),
    harnessId: z.string().max(256).pipe(harnessIdSchema),
  })
  .strict();

export const threadOwnershipSchema = z.discriminatedUnion("owner", [
  codexThreadOwnershipSchema,
  externalThreadOwnershipSchema,
]);

export type ThreadOwnership = z.infer<typeof threadOwnershipSchema>;

export const threadOwnershipListResultSchema = z
  .object({
    threads: z.array(threadOwnershipSchema).min(1).max(THREAD_OWNERSHIP_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threads }, ctx) =>
    rejectDuplicateKeys(
      threads,
      (thread) => thread.threadId,
      "Thread ownership-list results must be unique",
      (index) => ["threads", index, "threadId"],
      ctx,
    ),
  );

export type ThreadOwnershipListResult = z.infer<typeof threadOwnershipListResultSchema>;
