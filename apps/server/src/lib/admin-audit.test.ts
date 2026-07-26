import { describe, it, expect } from "vitest";
import { computeAuditHash, type AuditHashInput } from "./admin-audit";

const base: AuditHashInput = {
  action: "tenant.create",
  tenantId: "t_123",
  actorIp: "10.0.0.1",
  requestId: "req-abc",
  details: { keyPrefix: "AbCdEf12" },
  createdAt: new Date("2026-07-26T12:00:00.000Z"),
};

describe("computeAuditHash (audit chain)", () => {
  it("is deterministic for identical input + prevHash", () => {
    expect(computeAuditHash("prev", base)).toBe(computeAuditHash("prev", base));
  });

  it("produces a 64-char hex sha256", () => {
    expect(computeAuditHash(null, base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to detail key ORDER but sensitive to detail VALUES", () => {
    const reordered: AuditHashInput = {
      ...base,
      details: { z: 1, a: 2 },
    };
    const sameLogical: AuditHashInput = {
      ...base,
      details: { a: 2, z: 1 },
    };
    expect(computeAuditHash("p", reordered)).toBe(computeAuditHash("p", sameLogical));

    const changed: AuditHashInput = { ...base, details: { a: 2, z: 999 } };
    expect(computeAuditHash("p", changed)).not.toBe(computeAuditHash("p", sameLogical));
  });

  it("chains: changing prevHash changes the hash (link integrity)", () => {
    expect(computeAuditHash("A", base)).not.toBe(computeAuditHash("B", base));
  });

  it("is sensitive to every hashed field (tamper detection)", () => {
    const genesis = computeAuditHash(null, base);
    const mutations: AuditHashInput[] = [
      { ...base, action: "tenant.delete" },
      { ...base, tenantId: "t_999" },
      { ...base, actorIp: "10.0.0.2" },
      { ...base, requestId: "req-xyz" },
      { ...base, createdAt: new Date("2026-07-26T12:00:01.000Z") },
    ];
    for (const m of mutations) {
      expect(computeAuditHash(null, m)).not.toBe(genesis);
    }
  });

  it("distinguishes genesis (null prev) from an empty-string prev", () => {
    expect(computeAuditHash(null, base)).not.toBe(computeAuditHash("", base));
  });
});
