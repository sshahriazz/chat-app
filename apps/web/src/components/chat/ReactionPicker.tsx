"use client";

import { Menu, ActionIcon, Text } from "@mantine/core";
import { IconMoodSmile } from "@tabler/icons-react";
import { api } from "@/lib/api";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

interface ReactionPickerProps {
  messageId: string;
  conversationId: string;
  /** Controlled open state. The parent tracks this so the containing
   *  hover-actions row stays mounted while the dropdown is open — otherwise
   *  moving the mouse to the portal'd dropdown unmounts the trigger and
   *  kills the menu mid-interaction. */
  opened: boolean;
  onOpenChange: (opened: boolean) => void;
}

export function ReactionPicker({
  messageId,
  conversationId,
  opened,
  onOpenChange,
}: ReactionPickerProps) {
  const addReaction = (emoji: string) => {
    api
      .post(
        `/api/conversations/${conversationId}/messages/${messageId}/reactions`,
        { emoji },
      )
      .catch(() => {});
    onOpenChange(false);
  };

  return (
    <Menu shadow="md" position="top" opened={opened} onChange={onOpenChange}>
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
