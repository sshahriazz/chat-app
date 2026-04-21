import { generateHTML, generateJSON } from "@tiptap/html/server";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { JSONContent } from "@tiptap/core";

/**
 * Tiptap extension set used for server-side canonicalization. Must match the
 * client's set (same nodes, same attrs) so round-tripping JSON → HTML → JSON
 * is lossless for well-formed input and strips anything unknown.
 */
const messageExtensions = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    horizontalRule: false,
    codeBlock: false,
    // `link` is intentionally off for now — adds another attack surface
    // (href validation) and we don't have link previews yet.
    link: false,
  }),
  Mention.configure({
    HTMLAttributes: { class: "mention" },
  }),
];

export type MessageContentJson = JSONContent;

/**
 * Defense in depth: normalize a client-supplied Tiptap JSON tree by
 * round-tripping it through the extension schema. Unknown node types,
 * forbidden marks, stray attributes all disappear. Throws on input that
 * isn't even structurally JSON.
 */
export function canonicalizeFromJson(raw: unknown): MessageContentJson {
  if (!raw || typeof raw !== "object") {
    throw new Error("content must be a Tiptap JSON document");
  }
  const html = generateHTML(raw as JSONContent, messageExtensions);
  return generateJSON(html, messageExtensions) as MessageContentJson;
}

/**
 * Used by the backfill migration to parse the legacy HTML column into the
 * new JSON representation. Also useful if an old client sends HTML by
 * mistake (we don't accept that, but handy for recovery).
 */
export function canonicalizeFromHtml(html: string): MessageContentJson {
  return generateJSON(html, messageExtensions) as MessageContentJson;
}

/** Render canonical JSON to HTML — only needed if we ever need to serve HTML. */
export function renderToHtml(json: MessageContentJson): string {
  return generateHTML(json, messageExtensions);
}

/**
 * Collapse the AST to plain text for trigram search + sidebar previews.
 * Mentions expand as "@label"; paragraphs separate with newlines.
 */
export function extractPlainText(json: MessageContentJson): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      text?: string;
      attrs?: { label?: string };
      content?: unknown[];
    };
    if (typeof n.text === "string") parts.push(n.text);
    if (n.type === "mention" && n.attrs?.label) {
      parts.push(`@${n.attrs.label}`);
    }
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      if (n.type === "paragraph") parts.push("\n");
    }
  };
  walk(json);
  return parts.join("").replace(/\n+$/, "").trim();
}

/** Collect `data-id` values from mention nodes. Replaces the old regex. */
export function extractMentions(json: MessageContentJson): string[] {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      attrs?: { id?: string };
      content?: unknown[];
    };
    if (n.type === "mention" && typeof n.attrs?.id === "string") {
      ids.add(n.attrs.id);
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(json);
  return Array.from(ids);
}

export function isEmptyContent(json: MessageContentJson): boolean {
  return extractPlainText(json).length === 0;
}

/** Hard cap on plain-text length. Prevents paste-bombs independent of the JSON shape. */
export const MAX_MESSAGE_PLAIN_CHARS = 50_000;
