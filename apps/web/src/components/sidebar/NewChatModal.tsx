"use client";

import { useState } from "react";
import {
  Modal,
  TextInput,
  Stack,
  Group,
  Text,
  UnstyledButton,
  Loader,
  Center,
  SegmentedControl,
  MultiSelect,
  Button,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { useChat } from "@/context/ChatContext";
import { UserAvatar } from "@/components/common/UserAvatar";
import type { SearchUser, Conversation } from "@/lib/types";

interface NewChatModalProps {
  opened: boolean;
  onClose: () => void;
}

export function NewChatModal({ opened, onClose }: NewChatModalProps) {
  const { setActiveConversation, refreshConversations } = useChat();
  const [mode, setMode] = useState<"direct" | "group">("direct");
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [results, setResults] = useState<SearchUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (debouncedSearch.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    api
      .get<SearchUser[]>(`/api/users/search?q=${encodeURIComponent(debouncedSearch)}`)
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, [debouncedSearch]);

  const startDirectChat = async (userId: string) => {
    setCreating(true);
    try {
      const conv = await api.post<Conversation>("/api/conversations", {
        type: "direct",
        memberIds: [userId],
      });
      await refreshConversations();
      setActiveConversation(conv.id);
      handleClose();
    } finally {
      setCreating(false);
    }
  };

  const createGroup = async () => {
    if (selectedIds.length === 0) return;
    setCreating(true);
    try {
      const conv = await api.post<Conversation>("/api/conversations", {
        type: "group",
        name: groupName || undefined,
        memberIds: selectedIds,
      });
      await refreshConversations();
      setActiveConversation(conv.id);
      handleClose();
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setSearch("");
    setResults([]);
    setGroupName("");
    setSelectedIds([]);
    setMode("direct");
    onClose();
  };

  return (
    <Modal opened={opened} onClose={handleClose} title="New Chat" size="md">
      <Stack>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as "direct" | "group")}
          data={[
            { label: "Direct Message", value: "direct" },
            { label: "Group Chat", value: "group" },
          ]}
          fullWidth
        />

        <TextInput
          placeholder="Search users by name or email..."
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />

        {mode === "group" && (
          <TextInput
            placeholder="Group name (optional)"
            value={groupName}
            onChange={(e) => setGroupName(e.currentTarget.value)}
          />
        )}

        {loading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : results.length > 0 ? (
          <Stack gap={4} mah={300} style={{ overflow: "auto" }}>
            {results.map((user) => (
              <UnstyledButton
                key={user.id}
                p="xs"
                style={{ borderRadius: "var(--mantine-radius-md)" }}
                onClick={() => {
                  if (mode === "direct") {
                    startDirectChat(user.id);
                  } else {
                    setSelectedIds((prev) =>
                      prev.includes(user.id)
                        ? prev.filter((id) => id !== user.id)
                        : [...prev, user.id],
                    );
                  }
                }}
              >
                <Group>
                  <UserAvatar
                    name={user.name}
                    image={user.image}
                    online={user.online}
                    size="sm"
                  />
                  <div>
                    <Text size="sm" fw={500}>
                      {user.name}
                      {mode === "group" && selectedIds.includes(user.id) && " ✓"}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {user.email}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        ) : debouncedSearch.length >= 2 ? (
          <Text c="dimmed" size="sm" ta="center" py="md">
            No users found
          </Text>
        ) : null}

        {mode === "group" && selectedIds.length > 0 && (
          <Button onClick={createGroup} loading={creating}>
            Create Group ({selectedIds.length} member
            {selectedIds.length !== 1 ? "s" : ""})
          </Button>
        )}
      </Stack>
    </Modal>
  );
}
