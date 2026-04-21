"use client";

import { memo, useMemo, useState } from "react";
import {
  Box,
  Text,
  Group,
  ActionIcon,
  Tooltip,
  Paper,
  Menu,
  Stack,
} from "@mantine/core";
import { MessageEditor } from "./MessageEditor";
import {
  IconMoodSmile,
  IconDotsVertical,
  IconEdit,
  IconTrash,
  IconArrowBackUp,
  IconPaperclip,
  IconDownload,
  IconClockHour3,
  IconCheck,
  IconChecks,
  IconAlertCircle,
} from "@tabler/icons-react";
import { useAuth } from "@/context/AuthContext";
import { useChatActions } from "@/context/ChatContext";
import { UserAvatar } from "@/components/common/UserAvatar";
import { ReactionPicker } from "./ReactionPicker";
import { API_BASE_URL } from "@/lib/api";
import {
  isEmptyContent,
  renderMessageToHtml,
} from "@/lib/message-content";
import type { Attachment, Message, MessageContent } from "@/lib/types";

function MessageStatusIcon({
  status,
  onRetry,
}: {
  status: NonNullable<Message["status"]>;
  onRetry?: () => void;
}) {
  if (status === "failed") {
    return (
      <Tooltip label="Failed to send — click to retry" position="top">
        <ActionIcon
          size="xs"
          variant="transparent"
          color="red"
          onClick={onRetry}
          aria-label="Retry sending"
        >
          <IconAlertCircle size={14} />
        </ActionIcon>
      </Tooltip>
    );
  }

  const common = { size: 14, color: "var(--mantine-color-blue-1)" };
  if (status === "sending") {
    return (
      <Tooltip label="Sending…" position="top">
        <IconClockHour3 {...common} />
      </Tooltip>
    );
  }
  if (status === "sent") {
    return (
      <Tooltip label="Sent" position="top">
        <IconCheck {...common} />
      </Tooltip>
    );
  }
  return (
    <Tooltip label="Delivered" position="top">
      <IconChecks {...common} />
    </Tooltip>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}


function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.contentType.startsWith("image/");
  // Anchor to our own origin; server redirects to a signed S3 URL with
  // Content-Disposition: attachment so the browser actually downloads.
  const downloadHref = `${API_BASE_URL}/api/attachments/${attachment.id}/download`;

  if (isImage) {
    return (
      <Box style={{ position: "relative", display: "inline-block" }}>
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "inline-block" }}
        >
          <img
            src={attachment.url}
            alt={attachment.filename}
            // Intrinsic size when we know it — prevents layout shift as
            // thumbnails stream in during scroll. Legacy rows without
            // dimensions fall back to auto.
            width={attachment.width ?? undefined}
            height={attachment.height ?? undefined}
            loading="lazy"
            decoding="async"
            style={{
              maxWidth: 280,
              maxHeight: 280,
              borderRadius: 8,
              display: "block",
              height: "auto",
              width: "auto",
            }}
          />
        </a>
        <Tooltip label="Download">
          <ActionIcon
            component="a"
            href={downloadHref}
            variant="filled"
            color="dark"
            size="sm"
            radius="xl"
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              opacity: 0.85,
            }}
          >
            <IconDownload size={14} />
          </ActionIcon>
        </Tooltip>
      </Box>
    );
  }

  return (
    <Paper
      p="xs"
      radius="sm"
      withBorder
      style={{ maxWidth: 320, overflow: "hidden" }}
    >
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <IconPaperclip size={14} />
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" truncate>
            {attachment.filename}
          </Text>
          <Text size="xs" c="dimmed">
            {formatBytes(attachment.size)}
          </Text>
        </Box>
        <Tooltip label="Download">
          <ActionIcon
            component="a"
            href={downloadHref}
            variant="subtle"
            size="sm"
          >
            <IconDownload size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Paper>
  );
}

interface MessageBubbleProps {
  message: Message;
  isGroupChat: boolean;
  onReply: (message: Message) => void;
  compact?: boolean;
}

function MessageBubbleImpl({
  message,
  isGroupChat,
  onReply,
  compact = false,
}: MessageBubbleProps) {
  const { user } = useAuth();
  const { editMessage, deleteMessage, retrySendMessage } = useChatActions();
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);

  const isOwn = message.senderId === user?.id;
  const isDeleted = !!message.deletedAt;
  const isSystem = message.type === "system";

  if (isSystem) {
    // System messages carry a canonical Tiptap doc too, but plainContent is
    // sufficient — they never have formatting or mentions.
    return (
      <Text size="xs" c="dimmed" ta="center" py={4}>
        {message.plainContent}
      </Text>
    );
  }

  if (isDeleted) {
    return (
      <Box
        py={4}
        style={{
          display: "flex",
          justifyContent: isOwn ? "flex-end" : "flex-start",
        }}
      >
        <Text size="sm" c="dimmed" fs="italic">
          This message was deleted
        </Text>
      </Box>
    );
  }

  const isOwnTextMessage =
    isOwn && message.type === "text" && !message.deletedAt;
  const canEdit =
    isOwnTextMessage &&
    !isEmptyContent(message.content) &&
    !message.clientMessageId?.startsWith("temp_"); // skip optimistic placeholders
  const canDelete = isOwnTextMessage || (isOwn && message.type !== "system");

  const handleEdit = () => setEditing(true);

  const submitEdit = async (next: MessageContent) => {
    if (isEmptyContent(next)) {
      setEditing(false);
      return;
    }
    // Cheap structural diff — avoids an edit round-trip when nothing changed.
    const prevJson = JSON.stringify(message.content);
    const nextJson = JSON.stringify(next);
    if (nextJson !== prevJson) {
      await editMessage(message.id, next);
    }
    setEditing(false);
  };

  const cancelEdit = () => setEditing(false);

  // Memoized JSON → HTML render. Re-runs only when message.content identity
  // changes (we replace, never mutate in-place), so this is free during
  // typing / presence / reaction churn in sibling components.
  const renderedHtml = useMemo(
    () =>
      isEmptyContent(message.content) ? "" : renderMessageToHtml(message.content),
    [message.content],
  );

  // Group reactions by emoji
  const groupedReactions = (message.reactions || []).reduce(
    (acc, r) => {
      if (!acc[r.emoji]) acc[r.emoji] = { names: [], hasOwn: false };
      acc[r.emoji].names.push(r.user.name);
      if (r.userId === user?.id) acc[r.emoji].hasOwn = true;
      return acc;
    },
    {} as Record<string, { names: string[]; hasOwn: boolean }>,
  );

  return (
    <Box
      py={compact ? 1 : 4}
      style={{
        display: "flex",
        justifyContent: isOwn ? "flex-end" : "flex-start",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Group
        gap="xs"
        align="flex-start"
        wrap="nowrap"
        style={{ maxWidth: "75%", position: "relative" }}
      >
        {!isOwn && isGroupChat && !compact && (
          <UserAvatar name={message.sender.name} size="sm" />
        )}
        {!isOwn && isGroupChat && compact && <Box w={38} />}

        <Box>
          {!isOwn && isGroupChat && !compact && (
            <Text size="xs" fw={600} c="blue" mb={2}>
              {message.sender.name}
            </Text>
          )}

          {/* Reply preview */}
          {message.replyTo && (
            <Paper
              p={6}
              mb={4}
              radius="sm"
              style={{
                borderLeft: "3px solid var(--mantine-color-blue-5)",
                backgroundColor: "var(--mantine-color-default-hover)",
              }}
            >
              <Text size="xs" fw={600}>
                {message.replyTo.deletedAt
                  ? "Deleted message"
                  : message.replyTo.sender.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {message.replyTo.deletedAt
                  ? "This message was deleted"
                  : message.replyTo.plainContent || "📎 Attachment"}
              </Text>
            </Paper>
          )}

          {editing ? (
            <MessageEditor
              initialContent={message.content}
              onSave={(json) => {
                void submitEdit(json);
              }}
              onCancel={cancelEdit}
            />
          ) : (
            <Paper
              p="xs"
              px="sm"
              radius="lg"
              bg={isOwn ? "blue" : "var(--mantine-color-default)"}
              style={{
                borderBottomRightRadius: isOwn ? 4 : undefined,
                borderBottomLeftRadius: !isOwn ? 4 : undefined,
              }}
              onDoubleClick={() => onReply(message)}
            >
              {renderedHtml && (
                <Text
                  size="sm"
                  c={isOwn ? "white" : undefined}
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  dangerouslySetInnerHTML={{ __html: renderedHtml }}
                />
              )}
              {message.attachments && message.attachments.length > 0 && (
                <Stack gap={6} mt={renderedHtml ? 6 : 0}>
                  {message.attachments.map((a) => (
                    <AttachmentPreview key={a.id} attachment={a} />
                  ))}
                </Stack>
              )}
              <Group gap={4} mt={2} justify={isOwn ? "flex-end" : "flex-start"}>
                <Text size="xs" c={isOwn ? "blue.1" : "dimmed"}>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
                {message.editedAt && (
                  <Text size="xs" c={isOwn ? "blue.1" : "dimmed"}>
                    (edited)
                  </Text>
                )}
                {isOwn && message.status && (
                  <MessageStatusIcon
                    status={message.status}
                    onRetry={
                      message.status === "failed" && message.clientMessageId
                        ? () => retrySendMessage(message.clientMessageId!)
                        : undefined
                    }
                  />
                )}
              </Group>
            </Paper>
          )}

          {/* Reactions display — click to toggle */}
          {Object.keys(groupedReactions).length > 0 && (
            <Group gap={4} mt={4}>
              {Object.entries(groupedReactions).map(
                ([emoji, { names, hasOwn }]) => (
                  <ReactionBadge
                    key={emoji}
                    emoji={emoji}
                    names={names}
                    hasOwn={hasOwn}
                    messageId={message.id}
                  />
                ),
              )}
            </Group>
          )}
        </Box>

        {/* Action buttons on hover */}
        {hovered && !editing && (
          <Group
            gap={2}
            style={{
              position: "absolute",
              top: -12,
              right: isOwn ? 0 : undefined,
              left: !isOwn ? 0 : undefined,
            }}
          >
            <ReactionPicker
              messageId={message.id}
              conversationId={message.conversationId}
            />
            <ActionIcon
              variant="light"
              size="xs"
              radius="xl"
              onClick={() => onReply(message)}
            >
              <IconArrowBackUp size={12} />
            </ActionIcon>
            {(canEdit || canDelete) && (
              <Menu shadow="sm" position="top">
                <Menu.Target>
                  <ActionIcon variant="light" size="xs" radius="xl">
                    <IconDotsVertical size={12} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {canEdit && (
                    <Menu.Item
                      leftSection={<IconEdit size={14} />}
                      onClick={handleEdit}
                    >
                      Edit
                    </Menu.Item>
                  )}
                  {canDelete && (
                    <Menu.Item
                      leftSection={<IconTrash size={14} />}
                      color="red"
                      onClick={() => deleteMessage(message.id)}
                    >
                      Delete
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        )}
      </Group>
    </Box>
  );
}

/**
 * MessageBubble renders hundreds at a time in active conversations. With
 * the ChatContext split, actions are stable — so memoizing here cuts
 * per-bubble re-renders on typing/presence churn to zero.
 *
 * Custom comparator: message objects are replaced (not mutated) on every
 * server update, so reference equality is a correct + cheap staleness check.
 * The other props are primitives / stable callbacks from the parent.
 */
export const MessageBubble = memo(
  MessageBubbleImpl,
  (prev, next) =>
    prev.message === next.message &&
    prev.isGroupChat === next.isGroupChat &&
    prev.compact === next.compact &&
    prev.onReply === next.onReply,
);

function ReactionBadge({
  emoji,
  names,
  hasOwn,
  messageId,
}: {
  emoji: string;
  names: string[];
  hasOwn: boolean;
  messageId: string;
}) {
  const { toggleReaction } = useChatActions();

  return (
    <Tooltip label={names.join(", ")}>
      <Paper
        px={6}
        py={2}
        radius="xl"
        bg={
          hasOwn
            ? "var(--mantine-color-blue-light)"
            : "var(--mantine-color-default-hover)"
        }
        style={{
          cursor: "pointer",
          border: hasOwn
            ? "1px solid var(--mantine-color-blue-4)"
            : "1px solid transparent",
        }}
        onClick={() => toggleReaction(messageId, emoji)}
      >
        <Text size="xs">
          {emoji} {names.length}
        </Text>
      </Paper>
    </Tooltip>
  );
}
