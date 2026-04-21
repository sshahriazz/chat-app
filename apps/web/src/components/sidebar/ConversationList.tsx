"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Stack,
  TextInput,
  ScrollArea,
  Group,
  ActionIcon,
  Text,
  Loader,
  Center,
  Tooltip,
  Button,
} from "@mantine/core";
import {
  IconSearch,
  IconPlus,
  IconBell,
  IconBellOff,
} from "@tabler/icons-react";
import { notifications as mantineNotifications } from "@mantine/notifications";
import {
  getNotificationPermission,
  requestNotificationPermission,
  enablePushSubscription,
} from "@/lib/notify";
import { useChat } from "@/context/ChatContext";
import { ConversationItem } from "./ConversationItem";
import { NewChatModal } from "./NewChatModal";

interface ConversationListProps {
  onSelect?: (id: string) => void;
}

export function ConversationList({ onSelect }: ConversationListProps) {
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    isLoadingConversations,
    hasMoreConversations,
    loadMoreConversations,
  } = useChat();
  const [search, setSearch] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);

  const filtered = conversations.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    if (c.name?.toLowerCase().includes(q)) return true;
    return c.members.some((m) => m.user.name.toLowerCase().includes(q));
  });

  // Stable per-id click handlers so memoized ConversationItem rows don't
  // invalidate on every parent render. onSelect is pinned to a ref because
  // it's a prop (potentially changes identity) but we never want a click
  // handler's identity to flip for that reason.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const clickersRef = useRef(new Map<string, () => void>());
  const getClicker = useCallback(
    (id: string) => {
      let fn = clickersRef.current.get(id);
      if (!fn) {
        fn = () => {
          setActiveConversation(id);
          onSelectRef.current?.(id);
        };
        clickersRef.current.set(id, fn);
      }
      return fn;
    },
    [setActiveConversation],
  );

  return (
    <>
      <Stack gap={0} h="100%">
        <Group p="md" pb="xs" justify="space-between">
          <Text fw={700} size="lg">
            Chats
          </Text>
          <Group gap={4}>
            <NotificationsToggle />
            <ActionIcon
              variant="light"
              size="lg"
              onClick={() => setNewChatOpen(true)}
            >
              <IconPlus size={18} />
            </ActionIcon>
          </Group>
        </Group>

        <TextInput
          placeholder="Search conversations..."
          leftSection={<IconSearch size={16} />}
          mx="md"
          mb="xs"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />

        <ScrollArea style={{ flex: 1 }} px="xs">
          {isLoadingConversations ? (
            <Center py="xl">
              <Loader size="sm" />
            </Center>
          ) : filtered.length === 0 ? (
            <Text c="dimmed" size="sm" ta="center" py="xl">
              No conversations found
            </Text>
          ) : (
            <Stack gap={2}>
              {filtered.map((c) => (
                <ConversationItem
                  key={c.id}
                  conversation={c}
                  active={c.id === activeConversationId}
                  onClick={getClicker(c.id)}
                />
              ))}
              {/* Only show "Load more" when there's no search filter active —
                  the filter lives entirely in client state so more-results
                  would only matter once the user clears it. */}
              {!search && hasMoreConversations && (
                <Center py="sm">
                  <Button
                    variant="subtle"
                    size="xs"
                    onClick={() => void loadMoreConversations()}
                  >
                    Load more
                  </Button>
                </Center>
              )}
            </Stack>
          )}
        </ScrollArea>
      </Stack>

      <NewChatModal
        opened={newChatOpen}
        onClose={() => setNewChatOpen(false)}
      />
    </>
  );
}

function NotificationsToggle() {
  const [perm, setPerm] = useState<NotificationPermission>("default");

  useEffect(() => {
    setPerm(getNotificationPermission());
  }, []);

  // If the user has already granted permission in a past session, make sure
  // the browser is still registered for Web Push. Idempotent — re-subscribing
  // on an already-subscribed endpoint just refreshes the server row.
  useEffect(() => {
    if (perm !== "granted") return;
    enablePushSubscription().catch(() => {
      // Swallow — most likely reason is VAPID not configured server-side,
      // which we've already surfaced on first enable.
    });
  }, [perm]);

  const handleClick = async () => {
    if (perm === "default") {
      const next = await requestNotificationPermission();
      setPerm(next);
      if (next === "granted") {
        try {
          await enablePushSubscription();
        } catch (err) {
          mantineNotifications.show({
            title: "Push not available",
            message: (err as Error).message,
            color: "yellow",
          });
        }
      }
    }
    // "granted" → already on; "denied" → can only be undone in browser settings.
  };

  const enabled = perm === "granted";
  const denied = perm === "denied";
  const Icon = enabled ? IconBell : IconBellOff;

  const tooltip = enabled
    ? "Desktop notifications on"
    : denied
      ? "Notifications blocked — change in browser settings"
      : "Enable desktop notifications";

  return (
    <Tooltip label={tooltip} position="bottom">
      <ActionIcon
        variant="light"
        size="lg"
        color={enabled ? "blue" : "gray"}
        onClick={handleClick}
        disabled={denied}
        aria-label={tooltip}
      >
        <Icon size={18} />
      </ActionIcon>
    </Tooltip>
  );
}
