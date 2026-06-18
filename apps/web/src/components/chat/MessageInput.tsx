"use client";

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  Group,
  ActionIcon,
  Paper,
  Text,
  CloseButton,
  Box,
  Loader,
  Stack,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { RichTextEditor } from "@mantine/tiptap";
import { useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import { Extension } from "@tiptap/core";
import {
  createMentionSuggestion,
  type MentionCandidate,
} from "@/lib/mention-suggestion";
import { useAuth } from "@/context/AuthContext";
import {
  IconSend,
  IconBold,
  IconItalic,
  IconStrikethrough,
  IconCode,
  IconPaperclip,
  IconFile,
  IconH1,
  IconH2,
  IconH3,
  IconBlockquote,
  IconList,
  IconListNumbers,
  IconCodePlus,
  IconSeparatorHorizontal,
} from "@tabler/icons-react";
import { useChat } from "@/context/ChatContext";
import { uploadFile } from "@/lib/upload";
import { isEmptyContent } from "@/lib/message-content";
import type { Attachment, Message, MessageContent } from "@/lib/types";

export interface MessageInputHandle {
  /**
   * Imperative hook used by ChatView's drop-zone. Accepts a list of Files,
   * runs them through the presign+PUT pipeline, stages them on submit.
   */
  addFiles: (files: File[]) => void;
}

interface MessageInputProps {
  replyTo: Message | null;
  onCancelReply: () => void;
  ref?: Ref<MessageInputHandle>;
}

function submitFromEditor(
  editor: Editor | null,
  sendMessage: (
    content: MessageContent,
    replyToId?: string,
    attachments?: Attachment[],
  ) => Promise<void>,
  replyTo: Message | null,
  onCancelReply: () => void,
  attachments: Attachment[],
  clearAttachments: () => void,
) {
  if (!editor) return;
  const json = editor.getJSON() as unknown as MessageContent;
  if (isEmptyContent(json) && attachments.length === 0) return;

  sendMessage(json, replyTo?.id, attachments);
  onCancelReply();
  clearAttachments();
  editor.commands.clearContent();
  editor.commands.focus();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Mirror of server enforcement in apps/server/src/http/schemas.ts —
// keep these in sync with MAX_ATTACHMENT_SIZE and the `.max(10)` on
// attachmentIds. Client-side guard is purely UX (fail fast before
// uploading bytes the server will reject anyway).
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Mirror of MAX_MENTIONS_PER_MESSAGE in lib/message-content.ts on the
// server. Sending a 51st mention is a 400 there; we fail fast in the UI
// to give a clear message instead of a generic API error.
const MAX_MENTIONS_PER_MESSAGE = 50;

function countMentions(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as { type?: string; content?: unknown[] };
  let n_count = n.type === "mention" ? 1 : 0;
  if (Array.isArray(n.content)) {
    for (const child of n.content) n_count += countMentions(child);
  }
  return n_count;
}

export function MessageInput({ replyTo, onCancelReply, ref }: MessageInputProps) {
  const { sendMessage, sendTyping, conversations, activeConversationId } =
    useChat();
  const { user } = useAuth();

  // Thunked so the Tiptap extension always sees the latest member list if
  // the conversation's members change while the input stays mounted.
  const getMentionCandidates = (): MentionCandidate[] => {
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv) return [];
    return conv.members
      .filter((m) => m.userId !== user?.id)
      .map((m) => ({ id: m.userId, name: m.user.name }));
  };
  const editorRef = useRef<Editor | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  // Mirrors the server-side `MAX_MENTIONS_PER_MESSAGE` cap; recomputed
  // on every editor update so the submit button can disable + a hint
  // can render before the user hits send.
  const [mentionCount, setMentionCount] = useState(0);

  const clearAttachments = () =>
    setAttachments((prev) => {
      // Release any blob: preview URLs we created in handleFiles.
      for (const a of prev) {
        if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
      }
      return [];
    });

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const oversized = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const sized = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
    if (oversized.length > 0) {
      notifications.show({
        title: oversized.length === 1 ? "File too large" : "Some files too large",
        message: `${oversized.map((f) => f.name).join(", ")} — max ${formatBytes(MAX_ATTACHMENT_BYTES)} each`,
        color: "red",
        autoClose: 5000,
      });
    }

    const remaining =
      MAX_ATTACHMENTS_PER_MESSAGE - attachments.length - uploadingCount;
    const accepted = sized.slice(0, Math.max(0, remaining));
    const dropped = sized.slice(accepted.length);
    if (dropped.length > 0) {
      notifications.show({
        title: "Attachment limit reached",
        message: `Max ${MAX_ATTACHMENTS_PER_MESSAGE} files per message — dropped ${dropped.length}`,
        color: "red",
        autoClose: 5000,
      });
    }
    if (accepted.length === 0) return;

    setUploadingCount((n) => n + accepted.length);
    await Promise.all(
      accepted.map(async (f) => {
        try {
          const att = await uploadFile(f);
          // The bucket is private, so `att.url` (the public URL) won't
          // load in the compose preview. Only `attachmentIds` are sent
          // on submit, so the `url` field here is preview-only — use a
          // local blob URL for an instant, network-free thumbnail.
          const previewUrl = f.type.startsWith("image/")
            ? URL.createObjectURL(f)
            : att.url;
          setAttachments((prev) => [...prev, { ...att, url: previewUrl }]);
        } catch (err) {
          notifications.show({
            title: "Upload failed",
            message: `${f.name}: ${(err as Error).message}`,
            color: "red",
            autoClose: 5000,
          });
        } finally {
          setUploadingCount((n) => n - 1);
        }
      }),
    );
  };

  useImperativeHandle(ref, () => ({
    addFiles: (files) => {
      void handleFiles(files);
    },
  }));

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void handleFiles(files);
    }
  };

  const EnterSubmit = Extension.create({
    name: "enterSubmit",
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor: e }) => {
          // Inside multi-line blocks let Tiptap's default Enter handle the
          // new line / next list item; submit only from inline contexts.
          if (
            e.isActive("codeBlock") ||
            e.isActive("listItem") ||
            e.isActive("blockquote")
          ) {
            return false;
          }
          submitFromEditor(
            editorRef.current,
            sendMessage,
            replyTo,
            onCancelReply,
            attachments,
            clearAttachments,
          );
          return true;
        },
        "Shift-Enter": ({ editor: e }) => {
          e.commands.enter();
          return true;
        },
      };
    },
  });

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        link: false,
      }),
      Placeholder.configure({
        placeholder: "Type a message... (Shift+Enter for new line)",
      }),
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        // The default renderLabel puts "@name" in the rendered text.
        suggestion: createMentionSuggestion({
          getCandidates: getMentionCandidates,
        }),
      }),
      EnterSubmit,
    ],
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
    },
    onUpdate: ({ editor: e }) => {
      sendTyping();
      setMentionCount(countMentions(e.getJSON()));
    },
  });

  const overMentionCap = mentionCount > MAX_MENTIONS_PER_MESSAGE;
  const handleSubmit = () => {
    if (overMentionCap) {
      notifications.show({
        title: "Too many mentions",
        message: `Max ${MAX_MENTIONS_PER_MESSAGE} per message — currently ${mentionCount}.`,
        color: "red",
        autoClose: 4000,
      });
      return;
    }
    submitFromEditor(
      editor,
      sendMessage,
      replyTo,
      onCancelReply,
      attachments,
      clearAttachments,
    );
  };

  return (
    <Box
      px="md"
      py="sm"
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
      onPaste={handlePaste}
    >
      {replyTo && (
        <Paper
          p="xs"
          mb="xs"
          radius="sm"
          bg="var(--mantine-color-default-hover)"
          style={{ borderLeft: "3px solid var(--mantine-color-blue-5)" }}
        >
          <Group justify="space-between">
            <div>
              <Text size="xs" fw={600}>
                Replying to {replyTo.sender.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {replyTo.plainContent || "📎 Attachment"}
              </Text>
            </div>
            <CloseButton size="sm" onClick={onCancelReply} />
          </Group>
        </Paper>
      )}

      {(attachments.length > 0 || uploadingCount > 0) && (
        <Stack gap={4} mb="xs">
          {attachments.map((a) => (
            <Paper
              key={a.id}
              p="xs"
              radius="sm"
              bg="var(--mantine-color-default-hover)"
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  {a.contentType.startsWith("image/") ? (
                    <img
                      src={a.url}
                      alt={a.filename}
                      width={40}
                      height={40}
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: 40,
                        height: 40,
                        objectFit: "cover",
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <IconFile size={20} />
                  )}
                  <Box style={{ minWidth: 0 }}>
                    <Text size="xs" truncate>
                      {a.filename}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatBytes(a.size)}
                    </Text>
                  </Box>
                </Group>
                <CloseButton
                  size="xs"
                  onClick={() =>
                    setAttachments((prev) => {
                      if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
                      return prev.filter((x) => x.id !== a.id);
                    })
                  }
                />
              </Group>
            </Paper>
          ))}
          {uploadingCount > 0 && (
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                Uploading {uploadingCount} file{uploadingCount === 1 ? "" : "s"}…
              </Text>
            </Group>
          )}
        </Stack>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void handleFiles(Array.from(e.target.files ?? []));
          e.target.value = ""; // allow selecting the same file again later
        }}
      />

      <Group gap="xs" align="flex-end">
        <ActionIcon
          size="lg"
          variant="subtle"
          onClick={() => fileInputRef.current?.click()}
          mb={4}
          title="Attach files"
        >
          <IconPaperclip size={18} />
        </ActionIcon>
        <RichTextEditor
          editor={editor}
          style={{ flex: 1 }}
          styles={{
            root: {
              border: "1px solid var(--mantine-color-default-border)",
              borderRadius: "var(--mantine-radius-md)",
            },
            content: {
              minHeight: 38,
              maxHeight: 150,
              overflowY: "auto",
              fontSize: "var(--mantine-font-size-sm)",
            },
            toolbar: {
              borderBottom: "1px solid var(--mantine-color-default-border)",
              padding: 4,
              gap: 2,
            },
          }}
        >
          <RichTextEditor.Toolbar>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.Bold icon={() => <IconBold size={14} />} />
              <RichTextEditor.Italic icon={() => <IconItalic size={14} />} />
              <RichTextEditor.Strikethrough
                icon={() => <IconStrikethrough size={14} />}
              />
              <RichTextEditor.Code icon={() => <IconCode size={14} />} />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.H1 icon={() => <IconH1 size={14} />} />
              <RichTextEditor.H2 icon={() => <IconH2 size={14} />} />
              <RichTextEditor.H3 icon={() => <IconH3 size={14} />} />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.BulletList icon={() => <IconList size={14} />} />
              <RichTextEditor.OrderedList
                icon={() => <IconListNumbers size={14} />}
              />
              <RichTextEditor.Blockquote
                icon={() => <IconBlockquote size={14} />}
              />
              <RichTextEditor.CodeBlock
                icon={() => <IconCodePlus size={14} />}
              />
              <RichTextEditor.Hr
                icon={() => <IconSeparatorHorizontal size={14} />}
              />
            </RichTextEditor.ControlsGroup>
          </RichTextEditor.Toolbar>
          <RichTextEditor.Content />
        </RichTextEditor>
        <ActionIcon
          size="lg"
          variant="filled"
          onClick={handleSubmit}
          mb={4}
          disabled={overMentionCap}
          aria-label="Send"
        >
          <IconSend size={18} />
        </ActionIcon>
      </Group>
      {overMentionCap && (
        <Text size="xs" c="red" mt={4} px="xs">
          Too many mentions ({mentionCount} / {MAX_MENTIONS_PER_MESSAGE}). Remove some before sending.
        </Text>
      )}
    </Box>
  );
}
