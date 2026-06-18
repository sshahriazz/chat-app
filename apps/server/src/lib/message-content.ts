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
    // `link` is intentionally off — adds href-validation attack surface
    // (javascript:, data:, open-redirect) and we don't have link previews.
    link: false,
  }),
  Mention.configure({
    HTMLAttributes: { class: "mention" },
  }),
];

export type MessageContentJson = JSONContent;

/** Hard cap on mention nodes per message. A single message mentioning
 *  hundreds of users is a notification-flood / push-amplification
 *  vector (each mention bypasses mute). 50 is far above any legitimate
 *  use. */
export const MAX_MENTIONS_PER_MESSAGE = 50;

/** Thrown when content exceeds a structural limit (mentions, etc.).
 *  Callers map this to a 400. */
export class MessageContentError extends Error {}

/** Max nesting depth of the Tiptap tree. Real documents are a handful
 *  deep (doc > list > listItem > paragraph > text). 32 is generous. */
export const MAX_CONTENT_DEPTH = 32;
/** Max total node count. A 512 KB payload can encode ~10^4-10^5 tiny
 *  nodes; both generateHTML and generateJSON are recursive over the
 *  tree and materialize a DOM, so an unbounded tree pegs the event
 *  loop. 5000 covers any legitimate message. */
export const MAX_CONTENT_NODES = 5000;

/**
 * Walk the RAW (pre-canonicalization) tree once and reject trees that
 * are too deep or too large BEFORE handing them to the recursive,
 * DOM-materializing generateHTML/generateJSON pair. This is the cheap
 * guard that turns a CPU-DoS payload into a fast 400.
 */
function assertWithinStructuralLimits(raw: unknown): void {
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object") return;
    if (depth > MAX_CONTENT_DEPTH) {
      throw new MessageContentError(
        `content nesting too deep (max ${MAX_CONTENT_DEPTH})`,
      );
    }
    nodes++;
    if (nodes > MAX_CONTENT_NODES) {
      throw new MessageContentError(
        `content has too many nodes (max ${MAX_CONTENT_NODES})`,
      );
    }
    const n = node as { content?: unknown };
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child, depth + 1);
    }
  };
  walk(raw, 0);
}

function countMentions(json: MessageContentJson): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; content?: unknown[] };
    if (n.type === "mention") count++;
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(json);
  return count;
}

/**
 * Defense in depth: normalize a client-supplied Tiptap JSON tree by
 * round-tripping it through the extension schema. Unknown node types,
 * forbidden marks, stray attributes all disappear. Throws on input that
 * isn't even structurally JSON, that is too deep/large, or that exceeds
 * the mention cap.
 */
export function canonicalizeFromJson(raw: unknown): MessageContentJson {
  if (!raw || typeof raw !== "object") {
    throw new Error("content must be a Tiptap JSON document");
  }
  // Bound the tree BEFORE the expensive recursive HTML round-trip.
  assertWithinStructuralLimits(raw);
  const html = generateHTML(raw as JSONContent, messageExtensions);
  const json = generateJSON(html, messageExtensions) as MessageContentJson;
  if (countMentions(json) > MAX_MENTIONS_PER_MESSAGE) {
    throw new MessageContentError(
      `too many mentions (max ${MAX_MENTIONS_PER_MESSAGE})`,
    );
  }
  return json;
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

const BLOCK_BOUNDARY_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "horizontalRule",
]);

/**
 * Collapse the AST to plain text for trigram search + sidebar previews.
 * Mentions expand as "@label"; block-level nodes separate with newlines.
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
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type && BLOCK_BOUNDARY_TYPES.has(n.type)) parts.push("\n");
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

/**
 * Rewrite every mention node's `attrs.label` to the canonical name
 * looked up by `attrs.id`. Prevents a client from displaying "@alice"
 * text while pointing at Bob's user id. IDs outside the lookup map are
 * left alone — the caller has already validated which ids are
 * legitimate mentions (current conversation members).
 */
export function canonicalizeMentionLabels(
  json: MessageContentJson,
  namesByUserId: Map<string, string>,
): void {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      attrs?: { id?: string; label?: string };
      content?: unknown[];
    };
    if (n.type === "mention" && n.attrs && typeof n.attrs.id === "string") {
      const canonical = namesByUserId.get(n.attrs.id);
      if (canonical) n.attrs.label = canonical;
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(json);
}

/** Hard cap on plain-text length. Prevents paste-bombs independent of the JSON shape. */
export const MAX_MESSAGE_PLAIN_CHARS = 50_000;
