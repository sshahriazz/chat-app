"use client";

import { Group, Stack, Text, Badge, UnstyledButton, Box } from "@mantine/core";
import { UserAvatar } from "@/components/common/UserAvatar";
import { useAuth } from "@/context/AuthContext";
import type { Conversation } from "@/lib/types";

interface ConversationItemProps {
  conversation: Conversation;
  active: boolean;
  onClick: () => void;
}

export function ConversationItem({
  conversation,
  active,
  onClick,
}: ConversationItemProps) {
  const { user } = useAuth();
  const otherMember = conversation.type === "direct"
    ? conversation.members.find((m) => m.userId !== user?.id)
    : null;

  const displayName = conversation.type === "direct"
    ? otherMember?.user.name ?? "Unknown"
    : conversation.name ?? "Group";

  const lastMsg = conversation.lastMessage;
  const timeStr = lastMsg
    ? formatTime(lastMsg.createdAt)
    : formatTime(conversation.createdAt);

  return (
    <UnstyledButton
      onClick={onClick}
      p="sm"
      w="100%"
      style={{
        borderRadius: "var(--mantine-radius-md)",
        backgroundColor: active
          ? "var(--mantine-color-blue-light)"
          : undefined,
      }}
    >
      <Group wrap="nowrap" gap="sm">
        <UserAvatar
          name={displayName}
          size="md"
        />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" wrap="nowrap" gap={4}>
            <Text size="sm" fw={600} truncate>
              {displayName}
            </Text>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {timeStr}
            </Text>
          </Group>
          <Group justify="space-between" wrap="nowrap" gap={4}>
            <Text size="xs" c="dimmed" truncate>
              {lastMsg
                ? `${lastMsg.sender.name}: ${lastMsg.plainContent || "📎 Attachment"}`
                : "No messages yet"}
            </Text>
            {conversation.unreadCount > 0 && (
              <Badge size="sm" circle color="blue" style={{ flexShrink: 0 }}>
                {conversation.unreadCount > 99
                  ? "99+"
                  : conversation.unreadCount}
              </Badge>
            )}
          </Group>
        </Box>
      </Group>
    </UnstyledButton>
  );
}

function formatTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (days === 1) {
    return "Yesterday";
  } else if (days < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
