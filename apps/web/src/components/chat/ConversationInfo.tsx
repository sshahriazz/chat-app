"use client";

import { useEffect, useState } from "react";
import {
  Drawer,
  Stack,
  Text,
  Group,
  TextInput,
  Button,
  ActionIcon,
  Switch,
  Divider,
  Menu,
} from "@mantine/core";
import {
  IconEdit,
  IconUserPlus,
  IconDoorExit,
  IconDotsVertical,
  IconUserMinus,
  IconSearch,
} from "@tabler/icons-react";
import { useDebouncedValue } from "@mantine/hooks";
import { useAuth } from "@/context/AuthContext";
import { useChat } from "@/context/ChatContext";
import { UserAvatar } from "@/components/common/UserAvatar";
import { api } from "@/lib/api";
import type { SearchUser } from "@/lib/types";

interface ConversationInfoProps {
  opened: boolean;
  onClose: () => void;
}

export function ConversationInfo({ opened, onClose }: ConversationInfoProps) {
  const { user } = useAuth();
  const {
    conversations,
    activeConversationId,
    activeUserIds,
    muteConversation,
    renameGroup,
    addMembers,
    removeMember,
    leaveGroup,
  } = useChat();

  const conversation = conversations.find(
    (c) => c.id === activeConversationId,
  );

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [addingMembers, setAddingMembers] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(memberSearch, 300);
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  // Group name typed while converting a direct → group. Ignored for groups.
  const [promotionName, setPromotionName] = useState("");

  if (!conversation) return null;

  const isGroup = conversation.type === "group";
  const myMembership = conversation.members.find(
    (m) => m.userId === user?.id,
  );
  const isAdmin =
    myMembership?.role === "owner" || myMembership?.role === "admin";

  const handleRename = async () => {
    if (nameValue.trim()) {
      await renameGroup(nameValue.trim());
    }
    setEditingName(false);
  };

  // Run the search when the debounced query or panel visibility changes.
  // Calling fetch during render (as was done before) fires on every render,
  // can't be cancelled, and swallows errors at the wrong boundary.
  useEffect(() => {
    if (!addingMembers) return;
    if (debouncedSearch.length < 2) {
      setSearchResults([]);
      return;
    }

    const controller = new AbortController();
    (async () => {
      try {
        const results = await api.get<SearchUser[]>(
          `/api/users/search?q=${encodeURIComponent(debouncedSearch)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const existingIds = new Set(conversation.members.map((m) => m.userId));
        setSearchResults(results.filter((u) => !existingIds.has(u.id)));
      } catch {
        if (!controller.signal.aborted) setSearchResults([]);
      }
    })();

    return () => controller.abort();
  }, [debouncedSearch, addingMembers, conversation.members]);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="Conversation Info"
      position="right"
      size="sm"
    >
      <Stack>
        {/* Group name */}
        {isGroup && (
          <>
            {editingName ? (
              <Group>
                <TextInput
                  value={nameValue}
                  onChange={(e) => setNameValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  style={{ flex: 1 }}
                  autoFocus
                />
                <Button size="xs" onClick={handleRename}>
                  Save
                </Button>
              </Group>
            ) : (
              <Group justify="space-between">
                <Text fw={700} size="lg">
                  {conversation.name}
                </Text>
                {isAdmin && (
                  <ActionIcon
                    variant="subtle"
                    onClick={() => {
                      setNameValue(conversation.name || "");
                      setEditingName(true);
                    }}
                  >
                    <IconEdit size={16} />
                  </ActionIcon>
                )}
              </Group>
            )}
          </>
        )}

        {/* Mute toggle */}
        <Switch
          label="Mute notifications"
          checked={conversation.muted}
          onChange={(e) => muteConversation(e.currentTarget.checked)}
        />

        <Divider />

        {/* Members */}
        <Group justify="space-between">
          <Text fw={600} size="sm">
            Members ({conversation.members.length})
          </Text>
          {/* Any member of a direct chat can promote it to a group by adding
              a third user. For groups, keep the owner/admin gate. */}
          {(!isGroup || isAdmin) && (
            <ActionIcon
              variant="light"
              size="sm"
              onClick={() => setAddingMembers(!addingMembers)}
              title={isGroup ? "Add members" : "Add people — turns this into a group"}
            >
              <IconUserPlus size={14} />
            </ActionIcon>
          )}
        </Group>

        {/* Add members search */}
        {addingMembers && (
          <Stack gap="xs">
            {!isGroup && (
              <TextInput
                placeholder="Group name (optional)"
                value={promotionName}
                onChange={(e) => setPromotionName(e.currentTarget.value)}
                size="xs"
              />
            )}
            <TextInput
              placeholder="Search users to add..."
              leftSection={<IconSearch size={14} />}
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.currentTarget.value)}
              size="xs"
            />
            {searchResults.map((u) => (
              <Group key={u.id} justify="space-between" px="xs">
                <Group gap="xs">
                  <UserAvatar name={u.name} size="sm" online={u.online} />
                  <Text size="sm">{u.name}</Text>
                </Group>
                <Button
                  size="xs"
                  variant="light"
                  onClick={async () => {
                    await addMembers(
                      [u.id],
                      !isGroup ? promotionName : undefined,
                    );
                    setSearchResults((prev) =>
                      prev.filter((r) => r.id !== u.id),
                    );
                    // After the first add on a direct, the convo flips to
                    // group — clear the pending name so it doesn't linger.
                    if (!isGroup) setPromotionName("");
                  }}
                >
                  Add
                </Button>
              </Group>
            ))}
          </Stack>
        )}

        {/* Member list */}
        <Stack gap="xs">
          {conversation.members.map((m) => (
            <Group key={m.id} justify="space-between">
              <Group gap="xs">
                <UserAvatar
                  name={m.user.name}
                  image={m.user.image}
                  online={activeUserIds.has(m.userId)}
                  size="sm"
                />
                <div>
                  <Text size="sm" fw={500}>
                    {m.user.name}
                    {m.userId === user?.id && " (you)"}
                  </Text>
                  <Text size="xs" c="dimmed" tt="capitalize">
                    {m.role}
                  </Text>
                </div>
              </Group>
              {isGroup && isAdmin && m.userId !== user?.id && (
                <Menu shadow="sm">
                  <Menu.Target>
                    <ActionIcon variant="subtle" size="sm">
                      <IconDotsVertical size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconUserMinus size={14} />}
                      color="red"
                      onClick={() => removeMember(m.userId)}
                    >
                      Remove
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
          ))}
        </Stack>

        {/* Leave group */}
        {isGroup && (
          <>
            <Divider />
            <Button
              variant="subtle"
              color="red"
              leftSection={<IconDoorExit size={16} />}
              onClick={async () => {
                await leaveGroup();
                onClose();
              }}
            >
              Leave group
            </Button>
          </>
        )}
      </Stack>
    </Drawer>
  );
}
