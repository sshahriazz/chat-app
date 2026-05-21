import { describe, it, expect } from "vitest";
import {
  canonicalizeFromJson,
  canonicalizeMentionLabels,
  extractMentions,
  extractPlainText,
  isEmptyContent,
  MAX_MENTIONS_PER_MESSAGE,
  MAX_CONTENT_DEPTH,
  MAX_CONTENT_NODES,
  MessageContentError,
} from "./message-content";

/**
 * message-content is the trust boundary for incoming Tiptap JSON. These
 * tests lock down the behavior that stops XSS + mention-spoofing:
 *   - unknown nodes / attrs get stripped
 *   - mention ids we don't trust still render, but the label is
 *     rewritten to the DB-canonical name
 *   - plain-text extraction stays consistent with what we persist in
 *     `plain_content` for the trigram index.
 */

describe("canonicalizeFromJson", () => {
  it("round-trips a minimal doc", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    };
    const out = canonicalizeFromJson(doc);
    expect(out.type).toBe("doc");
    expect(JSON.stringify(out)).toContain("hello");
  });

  it("rejects non-objects", () => {
    expect(() => canonicalizeFromJson("bare string" as unknown)).toThrow();
    expect(() => canonicalizeFromJson(42 as unknown)).toThrow();
    expect(() => canonicalizeFromJson(null as unknown)).toThrow();
  });

  it("rejects a doc exceeding the mention cap", () => {
    const mentions = Array.from(
      { length: MAX_MENTIONS_PER_MESSAGE + 1 },
      (_, i) => ({
        type: "mention",
        attrs: { id: `u${i}`, label: `User ${i}` },
      }),
    );
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: mentions }],
    };
    expect(() => canonicalizeFromJson(doc)).toThrow(MessageContentError);
  });

  it("accepts a doc at exactly the mention cap", () => {
    const mentions = Array.from(
      { length: MAX_MENTIONS_PER_MESSAGE },
      (_, i) => ({
        type: "mention",
        attrs: { id: `u${i}`, label: `User ${i}` },
      }),
    );
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: mentions }],
    };
    expect(() => canonicalizeFromJson(doc)).not.toThrow();
  });

  it("rejects a tree deeper than MAX_CONTENT_DEPTH before HTML round-trip", () => {
    // Build a paragraph nested far past the depth cap.
    let inner: Record<string, unknown> = { type: "text", text: "x" };
    for (let i = 0; i < MAX_CONTENT_DEPTH + 5; i++) {
      inner = { type: "paragraph", content: [inner] };
    }
    const doc = { type: "doc", content: [inner] };
    expect(() => canonicalizeFromJson(doc)).toThrow(MessageContentError);
  });

  it("rejects a tree with more than MAX_CONTENT_NODES nodes", () => {
    const many = Array.from({ length: MAX_CONTENT_NODES + 10 }, () => ({
      type: "paragraph",
      content: [{ type: "text", text: "x" }],
    }));
    const doc = { type: "doc", content: many };
    expect(() => canonicalizeFromJson(doc)).toThrow(MessageContentError);
  });

  it("normalizes a non-doc root type into a doc", () => {
    // Tiptap's server schema wraps non-doc input rather than rejecting —
    // this lets a mis-shapen client message still make it through without
    // its content being trusted verbatim. The root of the returned value
    // is always `doc`.
    const out = canonicalizeFromJson({
      type: "paragraph",
      content: [{ type: "text", text: "x" }],
    });
    expect(out.type).toBe("doc");
  });
});

describe("extractPlainText", () => {
  it("joins text nodes into plain text", () => {
    const doc = canonicalizeFromJson({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    expect(extractPlainText(doc)).toContain("hello");
    expect(extractPlainText(doc)).toContain("world");
  });

  it("returns empty string for an empty doc", () => {
    const doc = canonicalizeFromJson({ type: "doc", content: [] });
    
    expect(extractPlainText(doc)).toBe("");
  });
});

describe("extractMentions", () => {
  it("returns userIds from mention nodes", () => {
    const doc = canonicalizeFromJson({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hey " },
            {
              type: "mention",
              attrs: { id: "user-1", label: "Alice" },
            },
            { type: "text", text: " and " },
            {
              type: "mention",
              attrs: { id: "user-2", label: "Bob" },
            },
          ],
        },
      ],
    });
    expect(extractMentions(doc).sort()).toEqual(["user-1", "user-2"]);
  });

  it("returns an empty array when there are no mentions", () => {
    const doc = canonicalizeFromJson({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      ],
    });
    expect(extractMentions(doc)).toEqual([]);
  });
});

describe("canonicalizeMentionLabels", () => {
  it("rewrites mention labels from the supplied lookup", () => {
    const doc = canonicalizeFromJson({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { id: "user-1", label: "attacker-supplied" },
            },
          ],
        },
      ],
    });
    const lookup = new Map([["user-1", "Alice"]]);
    canonicalizeMentionLabels(doc, lookup);
    // The plaintext should now reflect the canonical name.
    expect(extractPlainText(doc)).toContain("Alice");
    expect(extractPlainText(doc)).not.toContain("attacker-supplied");
  });
});

describe("isEmptyContent", () => {
  it("detects an empty doc", () => {
    const doc = canonicalizeFromJson({ type: "doc", content: [] });
    expect(isEmptyContent(doc)).toBe(true);
  });

  it("detects a paragraph with no children", () => {
    const doc = canonicalizeFromJson({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(isEmptyContent(doc)).toBe(true);
  });

  it("detects non-empty content", () => {
    const doc = canonicalizeFromJson({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
      ],
    });
    expect(isEmptyContent(doc)).toBe(false);
  });
});
