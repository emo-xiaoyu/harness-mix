/**
 * Internal validation primitives shared across contract modules.
 *
 * Nothing here is part of the package's public surface (the index re-exports
 * only the names listed in SPEC.md); these helpers exist so every module
 * enforces identical text/number rules instead of restating them.
 */
import { z } from "zod";

/** Non-blank string schema factory; `message` surfaces verbatim in issues. */
export function nonBlankText(message = "Value must not be empty or whitespace") {
  return z.string().refine((value) => value.trim().length > 0, { message });
}

/**
 * Reports `message` at `pathOf(index)` for every entry whose `pick` key was
 * already seen. `E` infers from the `entries` argument.
 */
export function rejectDuplicateKeys<E>(
  entries: readonly E[],
  pick: (entry: E) => string,
  message: string,
  pathOf: (index: number) => (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const key = pick(entry);
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", message, path: pathOf(index) });
    }
    seen.add(key);
  });
}

/** Whole number, `Number.isSafeInteger`, zero allowed. */
export const safeNonNegativeInteger = z.number().int().safe().nonnegative();

/** Finite number, zero allowed, NaN/Infinity rejected. */
export const finiteNonNegative = z.number().finite().nonnegative();

/** Finite number clamped to the inclusive 0–100 window (percentages). */
export const boundedPercent = finiteNonNegative.min(0).max(100);

/** Charset shared by model refs, thinking option ids and permission mode ids. */
export const TRANSPORT_SAFE_ID_SOURCE = "^[A-Za-z0-9._~-]+$";
