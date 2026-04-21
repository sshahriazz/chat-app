import { describe, it, expect } from "vitest";
import {
  BadRequestError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
  ValidationError,
  isDomainError,
} from "./errors";

/**
 * These tests pin the (httpStatus, code) pair for every DomainError
 * subclass. The OpenAPI document + client codegen depend on the mapping
 * being stable; a test breaks loudly on accidental changes.
 */
describe("DomainError hierarchy", () => {
  const cases: {
    name: string;
    make: () => DomainError;
    status: number;
    code: string;
  }[] = [
    { name: "BadRequest", make: () => new BadRequestError(), status: 400, code: "BAD_REQUEST" },
    { name: "Unauthorized", make: () => new UnauthorizedError(), status: 401, code: "UNAUTHORIZED" },
    { name: "Forbidden", make: () => new ForbiddenError(), status: 403, code: "FORBIDDEN" },
    { name: "NotFound", make: () => new NotFoundError(), status: 404, code: "NOT_FOUND" },
    { name: "Conflict", make: () => new ConflictError(), status: 409, code: "CONFLICT" },
    { name: "PayloadTooLarge", make: () => new PayloadTooLargeError(), status: 413, code: "PAYLOAD_TOO_LARGE" },
    { name: "UnsupportedMediaType", make: () => new UnsupportedMediaTypeError(), status: 415, code: "UNSUPPORTED_MEDIA_TYPE" },
    { name: "TooManyRequests", make: () => new TooManyRequestsError(), status: 429, code: "TOO_MANY_REQUESTS" },
    { name: "ServiceUnavailable", make: () => new ServiceUnavailableError(), status: 503, code: "SERVICE_UNAVAILABLE" },
  ];

  for (const { name, make, status, code } of cases) {
    it(`${name} maps to ${status} / ${code}`, () => {
      const err = make();
      expect(err).toBeInstanceOf(DomainError);
      expect(err.httpStatus).toBe(status);
      expect(err.code).toBe(code);
    });
  }

  it("ValidationError carries structured details + 400/VALIDATION_ERROR", () => {
    const err = new ValidationError([
      { path: ["body", "name"], message: "required" },
    ]);
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.details).toEqual([
      { path: ["body", "name"], message: "required" },
    ]);
  });

  it("isDomainError narrows correctly", () => {
    expect(isDomainError(new NotFoundError())).toBe(true);
    expect(isDomainError(new Error("plain"))).toBe(false);
    expect(isDomainError("string")).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });

  it("preserves custom messages", () => {
    const err = new NotFoundError("Conversation not found");
    expect(err.message).toBe("Conversation not found");
  });

  it("defaults to a safe message when none provided", () => {
    const err = new ForbiddenError();
    expect(err.message).toBe("Forbidden");
  });
});
