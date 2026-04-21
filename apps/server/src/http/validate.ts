import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { ValidationError, type FieldError } from "./errors";

/**
 * Zod-backed request validation middleware.
 *
 * `validate({ body, query, params })` parses each supplied section with
 * the matching schema and, on success, replaces `req.body` / `req.query` /
 * `req.params` with the *parsed* value. Routes can then pull typed
 * values out without defensive `as T` casts scattered everywhere.
 *
 * On failure we 400 with a structured error matching `errorResponseSchema`:
 *   { status, error, code: "VALIDATION_ERROR", details: [{ path, message }] }
 * so clients get actionable per-field messages instead of a single string.
 */

export interface ValidateSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

type ValidatedRequest<S extends ValidateSchemas> = Request & {
  body: S["body"] extends z.ZodType ? z.infer<S["body"]> : Request["body"];
  // Express 5 types `query` and `params` as parsed — we override with the
  // concrete Zod output so route handlers get strong typing.
  query: S["query"] extends z.ZodType
    ? z.infer<S["query"]>
    : Request["query"];
  params: S["params"] extends z.ZodType
    ? z.infer<S["params"]>
    : Request["params"];
};

/**
 * Build a validation middleware. Pass only the sections you care about;
 * unspecified sections pass through untouched.
 *
 * Usage:
 *   router.post(
 *     "/conversations/:id/read",
 *     requireAuth,
 *     validate({ body: MarkReadBodySchema, params: IdParamSchema }),
 *     async (req, res) => {
 *       const { messageId } = req.body; // typed
 *     },
 *   );
 */
export function validate<S extends ValidateSchemas>(schemas: S): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors: FieldError[] = [];

    // Zod's `issue.path` is PropertyKey[] (permits symbol); our wire
    // contract is (string | number)[], so coerce any symbols to string
    // before they escape the server.
    const normalize = (
      prefix: string,
      path: PropertyKey[],
    ): (string | number)[] => [
      prefix,
      ...path.map((p) => (typeof p === "symbol" ? String(p) : p)),
    ];

    if (schemas.body) {
      const parsed = schemas.body.safeParse(req.body);
      if (parsed.success) {
        req.body = parsed.data;
      } else {
        for (const issue of parsed.error.issues) {
          errors.push({
            path: normalize("body", issue.path),
            message: issue.message,
          });
        }
      }
    }

    if (schemas.query) {
      const parsed = schemas.query.safeParse(req.query);
      if (parsed.success) {
        // Express 5's req.query is a getter backed by qs; we can't reassign
        // it directly (TS error, and the getter throws in some versions).
        // Stash the parsed value on a side channel and expose a typed
        // accessor via the ValidatedRequest cast.
        Object.defineProperty(req, "query", {
          value: parsed.data,
          writable: true,
          configurable: true,
        });
      } else {
        for (const issue of parsed.error.issues) {
          errors.push({
            path: normalize("query", issue.path),
            message: issue.message,
          });
        }
      }
    }

    if (schemas.params) {
      const parsed = schemas.params.safeParse(req.params);
      if (parsed.success) {
        Object.defineProperty(req, "params", {
          value: parsed.data,
          writable: true,
          configurable: true,
        });
      } else {
        for (const issue of parsed.error.issues) {
          errors.push({
            path: normalize("params", issue.path),
            message: issue.message,
          });
        }
      }
    }

    if (errors.length > 0) {
      next(new ValidationError(errors));
      return;
    }

    next();
  };
}

/** Re-export for route handlers that want to type their `req`. */
export type { ValidatedRequest };
