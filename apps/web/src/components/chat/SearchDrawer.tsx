"use client";

import { useEffect, useState } from "react";
import {
  Drawer,
  TextInput,
  Stack,
  Paper,
  Text,
  Loader,
  Center,
  Group,
  UnstyledButton,
} from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useDebouncedValue } from "@mantine/hooks";
import { api } from "@/lib/api";
import { UserAvatar } from "@/components/common/UserAvatar";
import { useChat } from "@/context/ChatContext";

interface SearchResult {
  id: string;
  /** Server-extracted plaintext mirror — use for preview/snippets. */
  plainContent: string;
  createdAt: string;
  senderId: string;
  sender: { id: string; name: string; image: string | null };
}

interface SearchDrawerProps {
  conversationId: string;
  opened: boolean;
  onClose: () => void;
}

// Window the plaintext around the matched query so the preview stays short.
function snippet(plain: string, query: string): string {
  if (!query) return plain.slice(0, 140);
  const idx = plain.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return plain.slice(0, 140);
  const start = Math.max(0, idx - 30);
  const end = Math.min(plain.length, idx + query.length + 80);
  return (
    (start > 0 ? "…" : "") +
    plain.slice(start, end) +
    (end < plain.length ? "…" : "")
  );
}

export function SearchDrawer({
  conversationId,
  opened,
  onClose,
}: SearchDrawerProps) {
  const { jumpToMessage } = useChat();
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query, 250);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!opened) return;
    if (debounced.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .get<{ results: SearchResult[] }>(
        `/api/conversations/${conversationId}/search?q=${encodeURIComponent(debounced)}`,
        { signal: controller.signal },
      )
      .then((r) => {
        if (!controller.signal.aborted) setResults(r.results);
      })
      .catch(() => {
        if (!controller.signal.aborted) setResults([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debounced, conversationId, opened]);

  // Reset when closing so the next open starts fresh.
  useEffect(() => {
    if (!opened) {
      setQuery("");
      setResults([]);
    }
  }, [opened]);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="sm"
      title="Search messages"
    >
      <Stack gap="xs">
        <TextInput
          placeholder="Search this conversation..."
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          autoFocus
        />

        {loading && (
          <Center py="sm">
            <Loader size="xs" />
          </Center>
        )}

        {!loading && debounced.trim().length >= 2 && results.length === 0 && (
          <Text size="xs" c="dimmed" ta="center" py="sm">
            No matches.
          </Text>
        )}

        {results.map((r) => (
          <UnstyledButton
            key={r.id}
            onClick={() => {
              void jumpToMessage(r.id);
              onClose();
            }}
          >
            <Paper
              p="xs"
              radius="sm"
              withBorder
              style={{ cursor: "pointer" }}
            >
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <UserAvatar
                  name={r.sender.name}
                  image={r.sender.image}
                  size="sm"
                />
                <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                  <Group gap={4} wrap="nowrap">
                    <Text size="xs" fw={600} truncate>
                      {r.sender.name}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {new Date(r.createdAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Text>
                  </Group>
                  <Text size="xs" style={{ wordBreak: "break-word" }}>
                    {snippet(r.plainContent, debounced)}
                  </Text>
                </Stack>
              </Group>
            </Paper>
          </UnstyledButton>
        ))}
      </Stack>
    </Drawer>
  );
}
