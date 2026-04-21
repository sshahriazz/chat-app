import { z } from "zod";
// Importing zod-openapi anywhere pulls in its module-augmentation for
// Zod's `.meta()` typings (adds OpenAPI-specific fields like `id`, `param`,
// `header`). No runtime effect.
import "zod-openapi";

/**
 * Canonical error codes returned across the API. Keeping the list as a
 * const + enum pair gives us exhaustive switches in handlers and a
 * closed set in the OpenAPI document.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const fieldErrorSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .meta({ id: "FieldError" });

/**
 * Error response envelope used by the terminal error sink. The existing
 * handlers still return `{ status, error }` in many places; new endpoints
 * should adopt this richer shape as they're migrated to the DomainError
 * pipeline. Documenting it here both guides the migration and makes the
 * OpenAPI responses accurate for endpoints already using it.
 */
export const errorResponseSchema = z
  .object({
    status: z.number().int(),
    error: z.string(),
    code: z
      .enum(Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]])
      .optional(),
    requestId: z.string().optional(),
    details: z.array(fieldErrorSchema).optional(),
  })
  .meta({ id: "ErrorResponse" });

/** Shared response snippets so each path doesn't redefine them. */
export const commonResponses = {
  Unauthorized: {
    description: "Authentication required",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  Forbidden: {
    description: "Not authorized for this resource",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  NotFound: {
    description: "Resource not found",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  BadRequest: {
    description: "Invalid request",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  TooManyRequests: {
    description: "Rate limit exceeded",
    content: { "application/json": { schema: errorResponseSchema } },
  },
} as const;
