import { describe, expect, it } from "vitest";

import {
  MAX_THUMBNAIL_SIZE,
  UploadUrlBodySchema,
} from "./schemas";

const base = {
  filename: "photo.png",
  contentType: "image/png",
  size: 1024,
  purpose: "attachment" as const,
};

const thumbnail = {
  contentType: "image/jpeg" as const,
  size: 20_000,
  width: 480,
  height: 320,
};

describe("UploadUrlBodySchema — device-generated thumbnails", () => {
  it("accepts an upload with no thumbnail at all", () => {
    // An older client, or a file type the device cannot render, must still be
    // able to upload. The whole feature is additive.
    const parsed = UploadUrlBodySchema.parse(base);
    expect(parsed.thumbnail).toBeUndefined();
  });

  it("accepts a JPEG or WebP thumbnail", () => {
    expect(
      UploadUrlBodySchema.parse({ ...base, thumbnail }).thumbnail,
    ).toEqual(thumbnail);
    expect(
      UploadUrlBodySchema.parse({
        ...base,
        thumbnail: { ...thumbnail, contentType: "image/webp" },
      }).thumbnail?.contentType,
    ).toBe("image/webp");
  });

  it("rejects an SVG thumbnail", () => {
    // The thumbnail is rendered inline by every viewer. SVG is the one image
    // type that can carry script, so it must never reach that path.
    expect(() =>
      UploadUrlBodySchema.parse({
        ...base,
        thumbnail: { ...thumbnail, contentType: "image/svg+xml" },
      }),
    ).toThrow();
  });

  it("rejects a thumbnail larger than the cap", () => {
    // Nothing server-side inspects these bytes, so the cap is the only thing
    // stopping the field being used as unmetered storage.
    expect(() =>
      UploadUrlBodySchema.parse({
        ...base,
        thumbnail: { ...thumbnail, size: MAX_THUMBNAIL_SIZE + 1 },
      }),
    ).toThrow();
  });

  it("rejects a zero or negative thumbnail size", () => {
    for (const size of [0, -1]) {
      expect(() =>
        UploadUrlBodySchema.parse({ ...base, thumbnail: { ...thumbnail, size } }),
      ).toThrow();
    }
  });

  it("rejects a thumbnail on an avatar upload", () => {
    // Avatars are not tracked in the attachments table, so there is no row to
    // record a thumbnail key on — accepting one would presign an upload whose
    // location is never stored.
    expect(() =>
      UploadUrlBodySchema.parse({
        ...base,
        purpose: "avatar",
        thumbnail,
      }),
    ).toThrow(/thumbnail/i);
  });

  it("still rejects a non-image avatar", () => {
    // Guards the pre-existing refinement against the new one shadowing it.
    expect(() =>
      UploadUrlBodySchema.parse({
        ...base,
        filename: "doc.pdf",
        contentType: "application/pdf",
        purpose: "avatar",
      }),
    ).toThrow();
  });
});
