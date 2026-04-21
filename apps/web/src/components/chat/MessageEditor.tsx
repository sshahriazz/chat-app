"use client";

import { Stack, Text } from "@mantine/core";
import { RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import { Extension, type JSONContent } from "@tiptap/core";
import { useAuth } from "@/context/AuthContext";
import { useChat } from "@/context/ChatContext";
import {
  createMentionSuggestion,
  type MentionCandidate,
} from "@/lib/mention-suggestion";
import { isEmptyContent } from "@/lib/message-content";
import type { MessageContent } from "@/lib/types";

interface MessageEditorProps {
  initialContent: MessageContent;
  onSave: (content: MessageContent) => void;
  onCancel: () => void;
}

/**
 * Inline Tiptap editor for message editing. Shares extension config with the
 * send-path input so mentions survive the round-trip: the original JSON is
 * loaded directly via setContent, edited in-place, and `editor.getJSON()`
 * is handed back. No HTML ever enters or leaves this component.
 */
export function MessageEditor({
  initialContent,
  onSave,
  onCancel,
}: MessageEditorProps) {
  const { conversations, activeConversationId } = useChat();
  const { user } = useAuth();

  const getCandidates = (): MentionCandidate[] => {
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv) return [];
    return conv.members
      .filter((m) => m.userId !== user?.id)
      .map((m) => ({ id: m.userId, name: m.user.name }));
  };

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        codeBlock: false,
      }),
      Placeholder.configure({ placeholder: "Edit message…" }),
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        suggestion: createMentionSuggestion({
          getCandidates,
        }),
      }),
      Extension.create({
        name: "editSave",
        addKeyboardShortcuts() {
          return {
            Enter: ({ editor: e }) => {
              const json = e.getJSON() as unknown as MessageContent;
              if (isEmptyContent(json)) {
                onCancel();
              } else {
                onSave(json);
              }
              return true;
            },
            "Shift-Enter": ({ editor: e }) => {
              e.commands.enter();
              return true;
            },
            Escape: () => {
              onCancel();
              return true;
            },
          };
        },
      }),
    ],
    content: initialContent as JSONContent,
    autofocus: "end",
  });

  return (
    <Stack gap={4}>
      <RichTextEditor
        editor={editor}
        styles={{
          root: {
            border: "1px solid var(--mantine-color-default-border)",
            borderRadius: "var(--mantine-radius-md)",
          },
          content: {
            minHeight: 36,
            maxHeight: 220,
            overflowY: "auto",
            fontSize: "var(--mantine-font-size-sm)",
          },
        }}
      >
        <RichTextEditor.Content />
      </RichTextEditor>
      <Text size="xs" c="dimmed">
        Enter to save · Shift+Enter for newline · Esc to cancel
      </Text>
    </Stack>
  );
}
