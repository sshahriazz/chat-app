import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  encryptWithKey,
  decryptWithKey,
  isEncrypted,
} from "./field-crypto";

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

describe("field-crypto (AES-256-GCM)", () => {
  it("round-trips plaintext", () => {
    const pt = "alice@example.com";
    expect(decryptWithKey(encryptWithKey(pt, KEY), KEY)).toBe(pt);
  });

  it("round-trips unicode + empty string", () => {
    for (const pt of ["", "🔐 café", "a".repeat(10_000)]) {
      expect(decryptWithKey(encryptWithKey(pt, KEY), KEY)).toBe(pt);
    }
  });

  it("uses a fresh nonce each call (ciphertexts differ, both decrypt)", () => {
    const pt = "same input";
    const a = encryptWithKey(pt, KEY);
    const b = encryptWithKey(pt, KEY);
    expect(a).not.toBe(b); // random IV → different ciphertext
    expect(decryptWithKey(a, KEY)).toBe(pt);
    expect(decryptWithKey(b, KEY)).toBe(pt);
  });

  it("is tamper-evident: flipping any byte fails authentication", () => {
    const blob = encryptWithKey("sensitive", KEY);
    const [prefix, iv, ct, tag] = blob.split(":");
    // Corrupt the ciphertext segment.
    const corruptCt = Buffer.from(ct, "base64url");
    corruptCt[0] ^= 0x01;
    const tampered = [prefix, iv, corruptCt.toString("base64url"), tag].join(":");
    expect(() => decryptWithKey(tampered, KEY)).toThrow();
  });

  it("fails to decrypt under the wrong key", () => {
    const blob = encryptWithKey("secret", KEY);
    expect(() => decryptWithKey(blob, OTHER_KEY)).toThrow();
  });

  it("rejects a non-32-byte key on both paths", () => {
    const short = crypto.randomBytes(16);
    expect(() => encryptWithKey("x", short)).toThrow(/32 bytes/);
    expect(() => decryptWithKey(encryptWithKey("x", KEY), short)).toThrow(/32 bytes/);
  });

  it("rejects malformed ciphertext", () => {
    expect(() => decryptWithKey("not-a-blob", KEY)).toThrow(/malformed/);
    expect(() => decryptWithKey("fenc1:only:three", KEY)).toThrow(/malformed/);
  });

  it("isEncrypted distinguishes ciphertext from legacy plaintext", () => {
    expect(isEncrypted(encryptWithKey("x", KEY))).toBe(true);
    expect(isEncrypted("plain@value.com")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(12345)).toBe(false);
  });
});
