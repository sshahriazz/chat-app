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

  const clearAttachments = () => setAttachments([]);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploadingCount((n) => n + files.length);

    await Promise.all(
      files.map(async (f) => {
        try {
          const att = await uploadFile(f);
          setAttachments((prev) => [...prev, att]);
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
        Enter: () => {
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
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        codeBlock: false,
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
    onUpdate: () => {
      sendTyping();
    },
  });

  const handleSubmit = () => {
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
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id))
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
          </RichTextEditor.Toolbar>
          <RichTextEditor.Content />
        </RichTextEditor>
        <ActionIcon size="lg" variant="filled" onClick={handleSubmit} mb={4}>
          <IconSend size={18} />
        </ActionIcon>
      </Group>
    </Box>
  );
}
