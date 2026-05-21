import { describe, it, expect } from "vitest";
import {
  bytesMatchContentType,
  extForContentType,
  isInlineSafeContentType,
} from "./file-signature";

const buf = (...bytes: number[]) => Buffer.from(bytes);
const ascii = (s: string) => Buffer.from(s, "ascii");

describe("bytesMatchContentType", () => {
  it("accepts a real PNG signature for image/png", () => {
    expect(
      bytesMatchContentType(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png"),
    ).toBe(true);
  });

  it("rejects HTML bytes declared as image/png (polyglot block)", () => {
    expect(bytesMatchContentType(ascii("<script>alert(1)"), "image/png")).toBe(false);
  });

  it("rejects HTML bytes declared as image/jpeg", () => {
    expect(bytesMatchContentType(ascii("<!DOCTYPE html>"), "image/jpeg")).toBe(false);
  });

  it("accepts a real JPEG signature", () => {
    expect(bytesMatchContentType(buf(0xff, 0xd8, 0xff, 0xe0), "image/jpeg")).toBe(true);
  });

  it("accepts a real PDF signature", () => {
    expect(bytesMatchContentType(ascii("%PDF-1.7"), "application/pdf")).toBe(true);
  });

  it("rejects a non-PDF declared as application/pdf", () => {
    expect(bytesMatchContentType(ascii("GIF89a"), "application/pdf")).toBe(false);
  });

  it("accepts text/plain with any bytes (no deterministic signature)", () => {
    expect(bytesMatchContentType(ascii("anything at all"), "text/plain")).toBe(true);
  });

  it("rejects an unknown / non-allowlisted content type", () => {
    expect(bytesMatchContentType(ascii("<svg>"), "image/svg+xml")).toBe(false);
    expect(bytesMatchContentType(ascii("<html>"), "text/html")).toBe(false);
  });

  it("accepts WEBP only with the RIFF....WEBP envelope", () => {
    const webp = Buffer.concat([ascii("RIFF"), buf(0, 0, 0, 0), ascii("WEBP")]);
    expect(bytesMatchContentType(webp, "image/webp")).toBe(true);
    expect(bytesMatchContentType(ascii("RIFFxxxxWAVE"), "image/webp")).toBe(false);
  });
});

describe("extForContentType", () => {
  it("maps known MIMEs to canonical extensions", () => {
    expect(extForContentType("image/png")).toBe(".png");
    expect(extForContentType("image/jpeg")).toBe(".jpg");
    expect(extForContentType("video/quicktime")).toBe(".mov");
  });

  it("returns empty string for unknown MIME", () => {
    expect(extForContentType("application/x-msdownload")).toBe("");
  });
});

describe("isInlineSafeContentType", () => {
  it("treats image/video/audio as inline-safe", () => {
    expect(isInlineSafeContentType("image/png")).toBe(true);
    expect(isInlineSafeContentType("video/mp4")).toBe(true);
    expect(isInlineSafeContentType("audio/mpeg")).toBe(true);
  });

  it("treats documents / archives / html as NOT inline-safe", () => {
    expect(isInlineSafeContentType("application/pdf")).toBe(false);
    expect(isInlineSafeContentType("application/zip")).toBe(false);
    expect(isInlineSafeContentType("text/html")).toBe(false);
  });

  it("never treats SVG/XML as inline-safe despite the image/ prefix", () => {
    expect(isInlineSafeContentType("image/svg+xml")).toBe(false);
    expect(isInlineSafeContentType("application/xml")).toBe(false);
    expect(isInlineSafeContentType("application/xhtml+xml")).toBe(false);
  });
});
