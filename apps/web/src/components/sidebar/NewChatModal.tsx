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
  Button,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch, IconShield, IconWorld } from "@tabler/icons-react";
import { notifications as mantineNotifications } from "@mantine/notifications";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { getSessionMeta } from "@/lib/auth-client";
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

  // Tenant-wide identities (scope === null) hit the cross-scope endpoints
  // so their searches return every user in the tenant and their created
  // chats can include peers from any scope. Scoped users keep the default
  // surface, which enforces same-scope + tenant-wide visibility via
  // `userScopeFilter` on the server. The distinction is resolved once
  // on open (session meta is stable for the session) so re-renders
  // don't re-read session state on every keystroke.
  const meta = getSessionMeta();
  const isTenantWide = meta?.scope === null;
  const searchPath = isTenantWide ? "/api/users/tenant/search" : "/api/users/search";
  const createPath = isTenantWide ? "/api/conversations/tenant" : "/api/conversations";

  useEffect(() => {
    if (debouncedSearch.length < 2) {
      setResults([]);
      return;
    }
    // Abort in-flight request on each new keystroke to avoid a slow
    // earlier response overwriting a faster later one (last-write-wins
    // with server-side ordering would otherwise flicker stale results).
    const controller = new AbortController();
    setLoading(true);
    api
      .get<SearchUser[]>(
        `${searchPath}?q=${encodeURIComponent(debouncedSearch)}`,
        { signal: controller.signal },
      )
      .then(setResults)
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        setResults([]);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [debouncedSearch, searchPath]);

  const startDirectChat = async (userId: string) => {
    if (creating) return; // Re-entrancy guard: double-click / fast enter
    setCreating(true);
    try {
      const conv = await api.post<Conversation>(createPath, {
        type: "direct",
        memberIds: [userId],
      });
      await refreshConversations();
      setActiveConversation(conv.id);
      handleClose();
    } catch (err) {
      // The server surfaces actionable 4xx reasons here (e.g. the
      // 1000-member group cap, or a member id the caller can't see
      // under their scope). Show the message verbatim — it's authored
      // server-side specifically to be end-user-readable.
      mantineNotifications.show({
        title: "Could not start chat",
        message: (err as Error).message,
        color: "red",
      });
    } finally {
      setCreating(false);
    }
  };

  const createGroup = async () => {
    if (selectedIds.length === 0) return;
    if (creating) return;
    setCreating(true);
    try {
      const conv = await api.post<Conversation>(createPath, {
        type: "group",
        name: groupName || undefined,
        memberIds: selectedIds,
      });
      await refreshConversations();
      setActiveConversation(conv.id);
      handleClose();
    } catch (err) {
      mantineNotifications.show({
        title: "Could not create group",
        message: (err as Error).message,
        color: "red",
      });
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

        <ScopeHint />

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
          <Stack gap={4}>
            {/* Soft hint for the server-side caps. The hard 50-per-request
                cap is enforced by the zod schema (`memberIds.max(50)`);
                the 1000-total cap is enforced at the conversation level,
                counting existing members at add-members time. */}
            <Text size="xs" c="dimmed">
              {selectedIds.length}/50 selected this batch · groups cap at 1000
              members total
            </Text>
            <Button onClick={createGroup} loading={creating}>
              Create Group ({selectedIds.length} member
              {selectedIds.length !== 1 ? "s" : ""})
            </Button>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

/**
 * Tells the signed-in user WHICH peers this search can return:
 *   - Scoped requester → "same-scope + tenant-wide only"
 *   - Tenant-wide requester → "every user in this tenant"
 *
 * For scoped users the hint answers the inevitable "where's Carlos?"
 * question up-front. For tenant-wide users it makes explicit that
 * they're about to start a cross-scope conversation — relevant
 * because the members list in the resulting chat will mix scopes,
 * which surprises people used to the scoped default.
 */
function ScopeHint() {
  const meta = getSessionMeta();
  if (!meta) return null;
  if (meta.scope === null) {
    return (
      <Group gap={6} wrap="nowrap" c="dimmed">
        <IconWorld size={14} />
        <Text size="xs">
          Tenant-wide — every user in this tenant will appear.
        </Text>
      </Group>
    );
  }
  return (
    <Group gap={6} wrap="nowrap" c="dimmed">
      <IconShield size={14} />
      <Text size="xs">
        Scoped to <code>{meta.scope}</code> — only same-scope + tenant-wide
        users will appear.
      </Text>
    </Group>
  );
}
