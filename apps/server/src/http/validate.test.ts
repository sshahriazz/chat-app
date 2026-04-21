import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { validate } from "./validate";
import { ValidationError } from "./errors";

/**
 * `validate()` is the single entry point for route input checks. These
 * tests verify:
 *   - valid input replaces req.body/query/params with parsed data
 *   - invalid input produces a ValidationError with structured details
 *   - unspecified sections pass through untouched
 */

function makeReqRes(init: Partial<Request> = {}) {
  const req = {
    body: undefined,
    query: {},
    params: {},
    ...init,
  } as unknown as Request;
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe("validate() middleware", () => {
  it("parses req.body and replaces with coerced data", () => {
    const schema = z.object({ limit: z.coerce.number() });
    const { req, res, next } = makeReqRes({
      body: { limit: "25" } as unknown as Request["body"],
    });
    validate({ body: schema })(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ limit: 25 });
  });

  it("throws ValidationError with structured details on invalid body", () => {
    const schema = z.object({ name: z.string().min(1) });
    const { req, res, next } = makeReqRes({
      body: { name: "" } as unknown as Request["body"],
    });
    validate({ body: schema })(req, res, next);

    const nextCall = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(nextCall).toBeInstanceOf(ValidationError);
    expect(nextCall.details).toBeDefined();
    expect(nextCall.details[0].path[0]).toBe("body");
    expect(nextCall.details[0].path[1]).toBe("name");
  });

  it("parses req.query + replaces the getter value", () => {
    const schema = z.object({ q: z.string().min(2) });
    const { req, res, next } = makeReqRes({
      query: { q: "hi" } as unknown as Request["query"],
    });
    validate({ query: schema })(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.query).toEqual({ q: "hi" });
  });

  it("aggregates errors across body + query", () => {
    const bodySchema = z.object({ name: z.string().min(1) });
    const querySchema = z.object({ q: z.string().min(2) });
    const { req, res, next } = makeReqRes({
      body: { name: "" } as unknown as Request["body"],
      query: { q: "a" } as unknown as Request["query"],
    });
    validate({ body: bodySchema, query: querySchema })(req, res, next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(ValidationError);
    // One issue from body + one from query
    expect(err.details.length).toBe(2);
    const paths = err.details.map((d: { path: unknown[] }) => d.path[0]);
    expect(paths).toContain("body");
    expect(paths).toContain("query");
  });

  it("passes through when no schema provided", () => {
    const { req, res, next } = makeReqRes({
      body: { anything: true } as unknown as Request["body"],
    });
    validate({})(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ anything: true });
  });
});
