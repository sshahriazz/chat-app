"use client";

import { Menu, ActionIcon, Text } from "@mantine/core";
import { IconMoodSmile } from "@tabler/icons-react";
import { api } from "@/lib/api";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

interface ReactionPickerProps {
  messageId: string;
  conversationId: string;
}

export function ReactionPicker({
  messageId,
  conversationId,
}: ReactionPickerProps) {
  const addReaction = (emoji: string) => {
    api
      .post(
        `/api/conversations/${conversationId}/messages/${messageId}/reactions`,
        { emoji },
      )
      .catch(() => {});
  };

  return (
    <Menu shadow="md" position="top">
      <Menu.Target>
        <ActionIcon variant="light" size="xs" radius="xl">
          <IconMoodSmile size={12} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown p={4}>
        <div style={{ display: "flex", gap: 4 }}>
          {QUICK_REACTIONS.map((emoji) => (
            <ActionIcon
              key={emoji}
              variant="subtle"
              size="md"
              onClick={() => addReaction(emoji)}
            >
              <Text size="md">{emoji}</Text>
            </ActionIcon>
          ))}
        </div>
      </Menu.Dropdown>
    </Menu>
  );
}
