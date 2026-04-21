import type { Request, Response, NextFunction } from "express";
import { httpRequestDuration, httpRequestsTotal } from "../infra/metrics";

/**
 * Request timing middleware. Records duration + count into the histograms
 * at `infra/metrics.ts`, using the *Express route template* (not the
 * raw URL) as the label so cardinality stays bounded.
 *
 * Must be mounted BEFORE route handlers so the timer captures the full
 * handler duration, and the `res.on("finish")` hook reads the final
 * status code after every error/middleware has written the response.
 */
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const startHr = process.hrtime.bigint();
  res.on("finish", () => {
    // `req.route?.path` is the template ("/conversations/:id") when the
    // request matched a route. Falls back to the URL path (without
    // query) when there's no match (404s, static files).
    const routeTemplate =
      req.route?.path ??
      (req.baseUrl ? req.baseUrl + (req.route?.path ?? "") : req.path);
    const labels = {
      method: req.method,
      route: routeTemplate || "unknown",
      status_code: String(res.statusCode),
    };
    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9;
    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });
  next();
}
