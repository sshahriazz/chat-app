"use client";

import { useEffect, useState } from "react";
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
  IconWorld,
} from "@tabler/icons-react";
import { notifications as mantineNotifications } from "@mantine/notifications";
import {
  getNotificationPermission,
  requestNotificationPermission,
  enablePushSubscription,
} from "@/lib/notify";
import { useChat } from "@/context/ChatContext";
import { getSessionMeta } from "@/lib/auth-client";
import { ConversationItem } from "./ConversationItem";
import { NewChatModal } from "./NewChatModal";
import { TenantDirectory } from "./TenantDirectory";

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
  const [directoryOpen, setDirectoryOpen] = useState(false);

  // The tenant directory is only actionable for unscoped identities —
  // the server's `requireTenantWide` gate 403s scoped callers, and it
  // would be confusing to show a launcher that always errors. Read
  // once per render; session meta is stable for the session.
  const canBrowseTenant = getSessionMeta()?.scope === null;

  const filtered = conversations.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    if (c.name?.toLowerCase().includes(q)) return true;
    return c.members.some((m) => m.user.name.toLowerCase().includes(q));
  });

  // Inline per-render click handlers. Previously cached in a ref-backed
  // Map to keep identity stable for memoized ConversationItem rows, but
  // React 19's `react-hooks/refs` rule forbids reading/writing refs
  // during render. The savings were marginal — the list is typically
  // <50 rows and ConversationItem's relevant props (active, conversation)
  // already flip per parent render when the active id changes — so
  // rebuilding closures is the simpler, rule-clean trade.

  return (
    <>
      <Stack gap={0} h="100%">
        <Group p="md" pb="xs" justify="space-between">
          <Text fw={700} size="lg">
            Chats
          </Text>
          <Group gap={4}>
            <NotificationsToggle />
            {canBrowseTenant && (
              <Tooltip label="Browse tenant directory" position="bottom">
                <ActionIcon
                  variant="light"
                  size="lg"
                  onClick={() => setDirectoryOpen(true)}
                  aria-label="Browse tenant directory"
                >
                  <IconWorld size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="New chat" position="bottom">
              <ActionIcon
                variant="light"
                size="lg"
                onClick={() => setNewChatOpen(true)}
                aria-label="New chat"
              >
                <IconPlus size={18} />
              </ActionIcon>
            </Tooltip>
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
                  onClick={() => {
                    setActiveConversation(c.id);
                    onSelect?.(c.id);
                  }}
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
      {canBrowseTenant && (
        <TenantDirectory
          opened={directoryOpen}
          onClose={() => setDirectoryOpen(false)}
        />
      )}
    </>
  );
}

function NotificationsToggle() {
  // Lazy initializer reads the current permission once on mount. The
  // component is "use client", so SSR never runs this — the Notification
  // global is always available at initializer-time. Previously this was
  // done in a useEffect, but React 19's `react-hooks/set-state-in-effect`
  // rule flags setState in effect bodies. Lazy init is the idiomatic
  // replacement when the value is synchronously available at mount.
  const [perm, setPerm] = useState<NotificationPermission>(() =>
    getNotificationPermission(),
  );

  // If the user has already granted permission in a past session, make sure
  // the browser is still registered for Web Push. Idempotent — re-subscribing
  // on an already-subscribed endpoint just refreshes the server row. Errors
  // are logged to the console (not toasted, to avoid nagging users whose
  // server doesn't have VAPID configured — those failures are expected and
  // not actionable by the user).
  useEffect(() => {
    if (perm !== "granted") return;
    enablePushSubscription().catch((err) => {
      console.error(
        "[push] re-subscribe on mount failed:",
        (err as Error)?.message ?? err,
        err,
      );
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
