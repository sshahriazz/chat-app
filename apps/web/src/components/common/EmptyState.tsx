"use client";

import { Center, Stack, Text } from "@mantine/core";
import { IconMessage } from "@tabler/icons-react";

export function EmptyState() {
  return (
    <Center h="100%">
      <Stack align="center" gap="xs">
        <IconMessage size={48} stroke={1.2} color="var(--mantine-color-dimmed)" />
        <Text size="lg" fw={500} c="dimmed">
          Select a conversation
        </Text>
        <Text size="sm" c="dimmed">
          Choose from your existing conversations or start a new one
        </Text>
      </Stack>
    </Center>
  );
}
