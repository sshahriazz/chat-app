import { generateHTML } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { JSONContent, Extensions } from "@tiptap/core";
import type { MessageContent } from "./types";

/**
 * Same extensions the server uses for canonicalization. Sharing the exact
 * set here guarantees that `generateHTML(content, messageExtensions)` on
 * the client produces the same output the server would.
 *
 * NOTE: this is used both for rendering stored messages (read path) and
 * by the compose/edit editors (write path). Keep the disabled options in
 * sync with apps/server/src/lib/message-content.ts.
 */
export const messageExtensions: Extensions = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    horizontalRule: false,
    codeBlock: false,
    link: false,
  }),
  Mention.configure({
    HTMLAttributes: { class: "mention" },
  }),
];

/**
 * Render Tiptap JSON to HTML for display. We feed the result to
 * `dangerouslySetInnerHTML`, which is safe because the HTML was generated
 * from server-canonicalized JSON through our own extension schema — no
 * raw user-supplied HTML ever reaches this function.
 */
export function renderMessageToHtml(content: MessageContent): string {
  return generateHTML(content as JSONContent, messageExtensions);
}

/** True for docs that contain no visible text and no mention/image nodes. */
export function isEmptyContent(content: MessageContent | undefined | null): boolean {
  if (!content) return true;
  const walk = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    const node = n as {
      type?: string;
      text?: string;
      content?: unknown[];
    };
    if (typeof node.text === "string" && node.text.length > 0) return true;
    if (node.type === "mention") return true;
    if (Array.isArray(node.content)) return node.content.some(walk);
    return false;
  };
  return !walk(content);
}

/** Fallback plaintext extractor used when a payload lacks `plainContent`. */
export function extractPlainTextFromContent(
  content: MessageContent | undefined | null,
): string {
  if (!content) return "";
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const node = n as {
      type?: string;
      text?: string;
      attrs?: { label?: string };
      content?: unknown[];
    };
    if (typeof node.text === "string") parts.push(node.text);
    if (node.type === "mention" && node.attrs?.label) {
      parts.push(`@${node.attrs.label}`);
    }
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
      if (node.type === "paragraph") parts.push("\n");
    }
  };
  walk(content);
  return parts.join("").replace(/\n+$/, "").trim();
}

export const EMPTY_DOC: MessageContent = { type: "doc", content: [] };
