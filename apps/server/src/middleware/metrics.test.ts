import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";

/**
 * Verifies `httpMetrics` records a histogram observation + counter
 * increment on `res.finish`, using the route *template* rather than
 * the raw URL so high-cardinality paths (like `/conversations/abc-123`)
 * collapse to `/conversations/:id`.
 */

const observeMock = vi.fn();
const incMock = vi.fn();

vi.mock("../infra/metrics", () => ({
  httpRequestDuration: { observe: observeMock },
  httpRequestsTotal: { inc: incMock },
}));

type MetricsModule = typeof import("./metrics");
let metrics: MetricsModule;

beforeEach(async () => {
  observeMock.mockReset();
  incMock.mockReset();
  metrics = await import("./metrics");
});

function makeReqRes(init: { method?: string; route?: string; path?: string }) {
  const res = new EventEmitter() as unknown as Response;
  (res as unknown as { statusCode: number }).statusCode = 200;
  const req = {
    method: init.method ?? "GET",
    route: init.route ? { path: init.route } : undefined,
    path: init.path ?? "/raw-url",
    baseUrl: "",
  } as unknown as Request;
  return { req, res };
}

describe("httpMetrics middleware", () => {
  it("records histogram + counter with route template", () => {
    const { req, res } = makeReqRes({
      method: "GET",
      route: "/conversations/:id",
    });
    const next = vi.fn();
    metrics.httpMetrics(req, res, next);
    expect(next).toHaveBeenCalled();

    // Simulate response completion.
    (res as unknown as EventEmitter).emit("finish");

    expect(observeMock).toHaveBeenCalledOnce();
    expect(incMock).toHaveBeenCalledOnce();
    const labels = observeMock.mock.calls[0][0] as {
      method: string;
      route: string;
      status_code: string;
    };
    expect(labels.method).toBe("GET");
    expect(labels.route).toBe("/conversations/:id");
    expect(labels.status_code).toBe("200");
    // Duration must be a non-negative number.
    const duration = observeMock.mock.calls[0][1] as number;
    expect(typeof duration).toBe("number");
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("falls back to a path string when no Express route matched", () => {
    const { req, res } = makeReqRes({ method: "POST", path: "/unknown" });
    metrics.httpMetrics(req, res, () => {});
    (res as unknown as EventEmitter).emit("finish");
    const labels = observeMock.mock.calls[0][0] as { route: string };
    expect(labels.route).toBe("/unknown");
  });
});
