"use client";

import { useState } from "react";
import { Group, Text, ActionIcon } from "@mantine/core";
import { IconInfoCircle, IconSearch } from "@tabler/icons-react";
import { UserAvatar } from "@/components/common/UserAvatar";
import { useAuth } from "@/context/AuthContext";
import { useChat } from "@/context/ChatContext";
import { SearchDrawer } from "./SearchDrawer";

interface ChatHeaderProps {
  onInfoClick?: () => void;
}

export function ChatHeader({ onInfoClick }: ChatHeaderProps) {
  const { user } = useAuth();
  const { conversations, activeConversationId, activeUserIds } = useChat();
  const [searchOpen, setSearchOpen] = useState(false);

  const conversation = conversations.find((c) => c.id === activeConversationId);
  if (!conversation) return null;

  const isGroup = conversation.type === "group";
  const otherMember = conversation.members.find((m) => m.userId !== user?.id);

  const displayName = isGroup
    ? conversation.name ?? "Group"
    : otherMember?.user.name ?? "Unknown";

  const isActive = otherMember ? activeUserIds.has(otherMember.userId) : false;

  const activeMemberCount = isGroup
    ? conversation.members.filter((m) => activeUserIds.has(m.userId) && m.userId !== user?.id).length
    : 0;

  let subtitle: string;
  let subtitleColor: string;

  if (isGroup) {
    subtitle = `${conversation.members.length} members`;
    if (activeMemberCount > 0) {
      subtitle += `, ${activeMemberCount} active`;
    }
    subtitleColor = activeMemberCount > 0 ? "green" : "dimmed";
  } else if (isActive) {
    subtitle = "Active now";
    subtitleColor = "green";
  } else {
    subtitle = formatLastSeen(otherMember?.user.lastActiveAt);
    subtitleColor = "dimmed";
  }

  return (
    <Group
      px="md"
      py="sm"
      justify="space-between"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Group gap="sm">
        <UserAvatar
          name={displayName}
          size="md"
          online={!isGroup ? isActive : undefined}
        />
        <div>
          <Text fw={600} size="sm">
            {displayName}
          </Text>
          <Text size="xs" c={subtitleColor}>
            {subtitle}
          </Text>
        </div>
      </Group>
      <Group gap={4}>
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={() => setSearchOpen(true)}
          aria-label="Search in conversation"
        >
          <IconSearch size={18} />
        </ActionIcon>
        <ActionIcon variant="subtle" size="lg" onClick={onInfoClick}>
          <IconInfoCircle size={20} />
        </ActionIcon>
      </Group>
      <SearchDrawer
        conversationId={conversation.id}
        opened={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </Group>
  );
}

function formatLastSeen(dateStr?: string | null): string {
  if (!dateStr) return "Offline";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffMin < 1) return "Last seen just now";
  if (diffMin < 60) return `Last seen ${diffMin}m ago`;
  if (diffHr < 24) return `Last seen ${diffHr}h ago`;
  if (diffDays === 1) return "Last seen yesterday";
  return `Last seen ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
