"use client";

import { Text } from "@mantine/core";
import { useChat } from "@/context/ChatContext";

export function TypingIndicator() {
  const { typingUsers } = useChat();

  if (typingUsers.length === 0) return null;

  const names = typingUsers.map((t) => t.name);
  let text: string;

  if (names.length === 1) {
    text = `${names[0]} is typing...`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing...`;
  } else {
    text = `${names[0]} and ${names.length - 1} others are typing...`;
  }

  return (
    <Text size="xs" c="dimmed" px="md" py={4} fs="italic">
      {text}
    </Text>
  );
}
