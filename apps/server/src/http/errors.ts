import { ERROR_CODES, type ErrorCode } from "./openapi-shared";

/**
 * Domain-error hierarchy. Every handler-time failure throws one of
 * these; the terminal error middleware serializes them into the
 * `errorResponseSchema` envelope (status + error + code + requestId +
 * optional details).
 *
 * Why `throw` over `res.status().json()`:
 *   - Express 5 catches thrown errors from async handlers and routes
 *     them to error middleware, so the handler stays linear and the
 *     "and now return" suffix goes away.
 *   - One envelope for every error response. OpenAPI docs match reality.
 *   - Structured code + details means the client can branch on a
 *     stable enum instead of parsing human-readable strings.
 *
 * Unknown errors (anything that isn't a DomainError) are logged with
 * full context and surfaced to clients as a generic 500 — we don't
 * want a Prisma stack trace leaking the DB schema.
 */

export interface FieldError {
  path: (string | number)[];
  message: string;
}

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  /** Optional structured per-field errors (validation failures mostly). */
  readonly details?: FieldError[];

  constructor(message: string, details?: FieldError[]) {
    super(message);
    this.name = this.constructor.name;
    if (details) this.details = details;
  }
}

export class ValidationError extends DomainError {
  readonly code = ERROR_CODES.VALIDATION_ERROR;
  readonly httpStatus = 400;
  constructor(details: FieldError[], message = "Invalid request") {
    super(message, details);
  }
}

export class BadRequestError extends DomainError {
  readonly code = ERROR_CODES.BAD_REQUEST;
  readonly httpStatus = 400;
  constructor(message = "Bad request") {
    super(message);
  }
}

export class UnauthorizedError extends DomainError {
  readonly code = ERROR_CODES.UNAUTHORIZED;
  readonly httpStatus = 401;
  constructor(message = "Unauthorized") {
    super(message);
  }
}

export class ForbiddenError extends DomainError {
  readonly code = ERROR_CODES.FORBIDDEN;
  readonly httpStatus = 403;
  constructor(message = "Forbidden") {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly httpStatus = 404;
  constructor(message = "Not found") {
    super(message);
  }
}

export class ConflictError extends DomainError {
  readonly code = ERROR_CODES.CONFLICT;
  readonly httpStatus = 409;
  constructor(message = "Conflict") {
    super(message);
  }
}

export class PayloadTooLargeError extends DomainError {
  readonly code = ERROR_CODES.PAYLOAD_TOO_LARGE;
  readonly httpStatus = 413;
  constructor(message = "Payload too large") {
    super(message);
  }
}

export class UnsupportedMediaTypeError extends DomainError {
  readonly code = ERROR_CODES.UNSUPPORTED_MEDIA_TYPE;
  readonly httpStatus = 415;
  constructor(message = "Unsupported media type") {
    super(message);
  }
}

export class TooManyRequestsError extends DomainError {
  readonly code = ERROR_CODES.TOO_MANY_REQUESTS;
  readonly httpStatus = 429;
  constructor(message = "Too many requests") {
    super(message);
  }
}

export class ServiceUnavailableError extends DomainError {
  readonly code = ERROR_CODES.SERVICE_UNAVAILABLE;
  readonly httpStatus = 503;
  constructor(message = "Service unavailable") {
    super(message);
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
