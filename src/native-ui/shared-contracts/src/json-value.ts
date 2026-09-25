/**
 * JSON value schemas with two guards plain recursive zod cannot express:
 * circular references (would otherwise hang or blow the stack) and explicitly
 * present `undefined` members (valid JS, invalid on the wire — they serialize
 * differently across transports).
 */
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/**
 * Refinement that rejects `{ key: undefined }` for the listed keys. Schemas
 * mark such keys `.optional()`, which alone would let an explicit undefined
 * slip through; this restores the JSON distinction between absent and null.
 */
export function rejectExplicitUndefined(keys: readonly string[]) {
  return (value: object, ctx: z.RefinementCtx): void => {
    for (const key of keys) {
      if (Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Explicit undefined is not valid JSON",
        });
      }
    }
  };
}

export const jsonPrimitiveSchema: z.ZodType<JsonPrimitive> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * Iterative DFS keeping the in-progress ancestor chain in a WeakSet. A frame
 * that is `leaving` pops its object off the chain before the next sibling
 * branch, so a repeated reference on a *different* branch stays legal.
 * Structural exceptions (proxy traps, exotic objects) count as rejection —
 * the value is not safely serializable either way.
 */
function acyclic(value: unknown): boolean {
  const onPath = new WeakSet<object>();
  const pending: Array<{ node: unknown; leaving: boolean }> = [{ node: value, leaving: false }];
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (!frame) break;
      if (frame.leaving) {
        onPath.delete(frame.node as object);
        continue;
      }
      if (typeof frame.node !== "object" || frame.node === null) continue;
      if (onPath.has(frame.node)) return false;
      onPath.add(frame.node);
      pending.push({ node: frame.node, leaving: true });
      for (const child of Object.values(frame.node)) {
        pending.push({ node: child, leaving: false });
      }
    }
  } catch {
    return false;
  }
  return true;
}

const acyclicCheck = z.custom<unknown>(acyclic, {
  message: "JSON value must not contain circular references",
});

const recursiveJsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(recursiveJsonValue),
    z.record(z.string(), recursiveJsonValue),
  ]),
);

export const jsonValueSchema: z.ZodType<JsonValue> = acyclicCheck.pipe(recursiveJsonValue);

export const jsonArraySchema: z.ZodType<JsonArray> = acyclicCheck.pipe(
  z.array(recursiveJsonValue),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = acyclicCheck.pipe(
  z.record(z.string(), recursiveJsonValue),
);
