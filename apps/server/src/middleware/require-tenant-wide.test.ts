import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireTenantWide } from "./require-tenant-wide";
import { ForbiddenError } from "../http/errors";

/**
 * `requireTenantWide` gates endpoints that can cross scope boundaries.
 * It MUST reject anything except an explicitly null scope — a missing
 * scope (e.g. auth didn't populate it) is treated as not-authorized.
 * That's the whole point: we shouldn't let scope-crossing access
 * depend on whether upstream middleware happens to write the field.
 */

function makeReqResNext(scope: unknown) {
  const req = { scope } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe("requireTenantWide", () => {
  it("allows requests whose scope is explicitly null", () => {
    const { req, res, next } = makeReqResNext(null);
    requireTenantWide(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Called with no error → passes through.
    const mock = next as unknown as { mock: { calls: unknown[][] } };
    expect(mock.mock.calls[0].length).toBe(0);
  });

  it("rejects requests with a non-null scope", () => {
    const { req, res, next } = makeReqResNext("project-a");
    requireTenantWide(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    const mock = next as unknown as { mock: { calls: unknown[][] } };
    const [err] = mock.mock.calls[0];
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).httpStatus).toBe(403);
  });

  it("rejects requests with an undefined scope", () => {
    // Defensive: if upstream auth middleware hasn't populated scope,
    // we treat it as not-authorized rather than silently allowing.
    const { req, res, next } = makeReqResNext(undefined);
    requireTenantWide(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    const mock = next as unknown as { mock: { calls: unknown[][] } };
    const [err] = mock.mock.calls[0];
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it("rejects empty-string scope (treated as scoped, not tenant-wide)", () => {
    // Belt-and-braces: the JWT schema shouldn't ever emit "" as a
    // scope value, but if it did, the semantic is "has a scope,
    // just an empty one" — not "tenant-wide". Keep the strict
    // check so it fails closed.
    const { req, res, next } = makeReqResNext("");
    requireTenantWide(req, res, next);
    const mock = next as unknown as { mock: { calls: unknown[][] } };
    const [err] = mock.mock.calls[0];
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});
