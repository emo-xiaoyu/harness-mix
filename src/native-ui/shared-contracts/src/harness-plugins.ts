/**
 * Harness plugin manifest/descriptor/configuration contracts. Plugin ids are
 * portable directory keys (lowercase, dot/dash/hyphen separated) — never a
 * native session id — and `codex` is reserved for the official route. A
 * manifest is inert data: validating it must precede importing any plugin
 * code. The configuration list is an explicit trust grant; discovery alone
 * enables nothing.
 */
import { z } from "zod";

import { harnessIdSchema } from "./ids.js";

export const HARNESS_PLUGIN_API_VERSION = 1;
export const HARNESS_PLUGIN_MANIFEST_MAX_BYTES = 32 * 1024;
export const HARNESS_PLUGIN_ICON_MAX_BYTES = 128 * 1024;
export const HARNESS_PLUGIN_LIMIT = 128;

export const harnessPluginIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
  .refine((id) => id !== "codex", "The official Codex identity is reserved")
  .pipe(harnessIdSchema);

// NUL is kept out via a dedicated check so the regex literal can stay
// printable (raw control characters in source are fragile across tooling).
const NUL = String.fromCharCode(0);

/** Entry/icon paths stay inside the plugin directory: no drive letters, no .., no empty segments. */
const pluginRelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[\\:#?]/u.test(value) &&
      !value.includes(NUL) &&
      !value.startsWith("/") &&
      !value.split("/").some((segment) => segment === ".." || segment === ""),
    "Plugin resources must be relative paths inside the plugin",
  );

/** Documentation surfaces must be plain credential-free HTTPS links. */
const pluginDocumentationUrl = z
  .url()
  .refine(
    (value) => /^https:\/\/[^/?#@]+(?:[/?#]|$)/iu.test(value),
    "Plugin documentation links must be credential-free HTTPS URLs",
  );

const pluginPresentation = {
  id: harnessPluginIdSchema,
  name: z.string().trim().min(1).max(128),
  version: z.string().min(1).max(128),
  links: z
    .object({
      documentation: pluginDocumentationUrl.optional(),
      installation: pluginDocumentationUrl.optional(),
    })
    .strict()
    .optional(),
};

export const harnessPluginManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    ...pluginPresentation,
    adapterApiVersion: z.number().int().positive(),
    entry: pluginRelativePath,
    icon: pluginRelativePath.optional(),
  })
  .strict();
export type HarnessPluginManifest = z.infer<typeof harnessPluginManifestSchema>;

/**
 * Data-URI icons are presentation data only — consumers render them in an
 * <img>, never as markup. The length bound leaves headroom over the raw
 * base64 payload (4/3 expansion) for the URI prefix and padding.
 */
export const harnessPluginIconSchema = z
  .string()
  .max(Math.ceil(HARNESS_PLUGIN_ICON_MAX_BYTES / 3) * 4 + 64)
  .regex(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u);

export const harnessPluginDescriptorSchema = z
  .object({
    ...pluginPresentation,
    icon: harnessPluginIconSchema.optional(),
  })
  .strict();
export type HarnessPluginDescriptor = z.infer<typeof harnessPluginDescriptorSchema>;

export const harnessPluginListParamsSchema = z.object({}).strict();
export const harnessPluginListResultSchema = z
  .object({
    plugins: z.array(harnessPluginDescriptorSchema).max(HARNESS_PLUGIN_LIMIT),
  })
  .strict();
export type HarnessPluginListResult = z.infer<typeof harnessPluginListResultSchema>;

export const harnessPluginConfigurationSchema = z
  .object({
    version: z.literal(1),
    enabled: z.array(harnessPluginIdSchema).max(HARNESS_PLUGIN_LIMIT),
  })
  .strict()
  .refine((value) => new Set(value.enabled).size === value.enabled.length, {
    message: "Enabled plugin IDs must be unique",
    path: ["enabled"],
  });
export type HarnessPluginConfiguration = z.infer<typeof harnessPluginConfigurationSchema>;
