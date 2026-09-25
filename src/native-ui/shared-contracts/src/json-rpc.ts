/**
 * JSON-RPC 2.0 envelope family with role separation enforced per shape: a
 * notification must not carry an id, a success response must not carry a
 * method, and so on. Forbidden members use `z.never().optional()` — absent is
 * the only passing state — and every envelope additionally rejects explicit
 * `undefined` in its optional/forbidden members (see json-value.ts). Unknown
 * members are tolerated (catchall) since peers legitimately attach tracing
 * metadata.
 */
import { z } from "zod";

import { jsonValueSchema, rejectExplicitUndefined } from "./json-value.js";

const optionalVersion = z.literal("2.0").optional();
const mustBeAbsent = z.never().optional();
const method = z.string().min(1);

export const jsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

export const jsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: jsonValueSchema.optional(),
  })
  .catchall(jsonValueSchema)
  .superRefine(rejectExplicitUndefined(["data"]));
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;

export const jsonRpcRequestSchema = z
  .object({
    jsonrpc: optionalVersion,
    id: jsonRpcIdSchema,
    method,
    params: jsonValueSchema.optional(),
    result: mustBeAbsent,
    error: mustBeAbsent,
  })
  .catchall(jsonValueSchema)
  .superRefine(rejectExplicitUndefined(["jsonrpc", "params", "result", "error"]));
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export const jsonRpcNotificationSchema = z
  .object({
    jsonrpc: optionalVersion,
    id: mustBeAbsent,
    method,
    params: jsonValueSchema.optional(),
    result: mustBeAbsent,
    error: mustBeAbsent,
  })
  .catchall(jsonValueSchema)
  .superRefine(rejectExplicitUndefined(["jsonrpc", "id", "params", "result", "error"]));
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

export const jsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: optionalVersion,
    id: jsonRpcIdSchema,
    method: mustBeAbsent,
    params: mustBeAbsent,
    result: jsonValueSchema,
    error: mustBeAbsent,
  })
  .catchall(jsonValueSchema)
  .superRefine(rejectExplicitUndefined(["jsonrpc", "method", "params", "error"]));
export type JsonRpcSuccessResponse = z.infer<typeof jsonRpcSuccessResponseSchema>;

export const jsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: optionalVersion,
    id: jsonRpcIdSchema,
    method: mustBeAbsent,
    params: mustBeAbsent,
    result: mustBeAbsent,
    error: jsonRpcErrorSchema,
  })
  .catchall(jsonValueSchema)
  .superRefine(rejectExplicitUndefined(["jsonrpc", "method", "params", "result"]));
export type JsonRpcErrorResponse = z.infer<typeof jsonRpcErrorResponseSchema>;

export const jsonRpcEnvelopeSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcSuccessResponseSchema,
  jsonRpcErrorResponseSchema,
]);
export type JsonRpcEnvelope = z.infer<typeof jsonRpcEnvelopeSchema>;
