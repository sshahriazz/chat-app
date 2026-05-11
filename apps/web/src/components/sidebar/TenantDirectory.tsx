"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Drawer,
  Stack,
  Group,
  Text,
  UnstyledButton,
  Loader,
  Center,
  Badge,
} from "@mantine/core";
import { IconWorld } from "@tabler/icons-react";
import { notifications as mantineNotifications } from "@mantine/notifications";
import { api } from "@/lib/api";
import { useChat } from "@/context/ChatContext";
import { UserAvatar } from "@/components/common/UserAvatar";
import type { SearchUser, Conversation } from "@/lib/types";

/**
 * Browseable directory of every user in the current tenant, served by
 * the keyset-paginated `GET /api/users/tenant` endpoint. Reachable only
 * to tenant-wide identities — the server-side `requireTenantWide` gate
 * 403s scoped callers, so the parent hides the launcher button for
 * them entirely.
 *
 * Cursor-based pagination (sorted `(name, id) ASC`) is wired up as
 * infinite scroll: an IntersectionObserver watches a sentinel below
 * the list, and when it enters the viewport we fetch the next page
 * using the opaque `nextCursor` the server returned.
 *
 * Clicking a user starts a direct chat via `/api/conversations/tenant`,
 * whose advisory-lock dedup means a double-click can't create two
 * parallel DMs — the second call either serializes behind the first
 * and finds the row it created, or lands first and dedup's the retry.
 */

interface TenantDirectoryProps {
  opened: boolean;
  onClose: () => void;
}

interface TenantUserListResponse {
  users: SearchUser[];
  nextCursor: string | null;
}

const PAGE_SIZE = 30;

export function TenantDirectory({ opened, onClose }: TenantDirectoryProps) {
  const { setActiveConversation, refreshConversations } = useChat();
  const [users, setUsers] = useState<SearchUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [startingFor, setStartingFor] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset + load first page when the drawer opens. Closing clears state
  // so the next open starts fresh; otherwise a re-open would briefly
  // flash the previous tenant's users before the fetch completes.
  useEffect(() => {
    if (!opened) {
      setUsers([]);
      setCursor(null);
      setExhausted(false);
      return;
    }

    const controller = new AbortController();
    setInitialLoading(true);
    setExhausted(false);
    api
      .get<TenantUserListResponse>(`/api/users/tenant?limit=${PAGE_SIZE}`, {
        signal: controller.signal,
      })
      .then((r) => {
        setUsers(r.users);
        setCursor(r.nextCursor);
        if (!r.nextCursor) setExhausted(true);
      })
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        mantineNotifications.show({
          title: "Could not load directory",
          message: (err as Error).message,
          color: "red",
        });
      })
      .finally(() => setInitialLoading(false));

    return () => controller.abort();
  }, [opened]);

  const loadNext = useCallback(async () => {
    if (!cursor || loadingMore || exhausted) return;
    setLoadingMore(true);
    try {
      const r = await api.get<TenantUserListResponse>(
        `/api/users/tenant?cursor=${encodeURIComponent(cursor)}&limit=${PAGE_SIZE}`,
      );
      // De-dupe defensively: if the sentinel fires twice in flight
      // (rare, but IntersectionObserver + React concurrent mode can
      // race a rapid flush), the same `cursor` would be sent twice
      // and produce overlapping rows. Merge by id to keep the list
      // a set.
      setUsers((prev) => {
        const seen = new Set(prev.map((u) => u.id));
        return [...prev, ...r.users.filter((u) => !seen.has(u.id))];
      });
      setCursor(r.nextCursor);
      if (!r.nextCursor) setExhausted(true);
    } catch (err) {
      mantineNotifications.show({
        title: "Could not load more",
        message: (err as Error).message,
        color: "red",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, exhausted]);

  // Infinite scroll via IntersectionObserver. The `rootMargin` preloads
  // the next page before the sentinel actually hits the viewport so the
  // scroll feels seamless.
  useEffect(() => {
    if (!opened) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadNext();
      },
      { root: null, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [opened, loadNext]);

  const startDirectChat = async (userId: string) => {
    if (startingFor) return;
    setStartingFor(userId);
    try {
      const conv = await api.post<Conversation>("/api/conversations/tenant", {
        type: "direct",
        memberIds: [userId],
      });
      await refreshConversations();
      setActiveConversation(conv.id);
      onClose();
    } catch (err) {
      mantineNotifications.show({
        title: "Could not start chat",
        message: (err as Error).message,
        color: "red",
      });
    } finally {
      setStartingFor(null);
    }
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={
        <Group gap={8}>
          <IconWorld size={18} />
          <Text fw={600}>Tenant Directory</Text>
        </Group>
      }
    >
      <Text size="xs" c="dimmed" mb="md">
        Everyone in this tenant, regardless of scope. Click a name to start a
        direct chat — it will cross scope boundaries.
      </Text>

      {initialLoading ? (
        <Center py="xl">
          <Loader size="sm" />
        </Center>
      ) : users.length === 0 ? (
        <Text c="dimmed" size="sm" ta="center" py="xl">
          No other users in this tenant.
        </Text>
      ) : (
        <Stack gap={2}>
          {users.map((u) => (
            <UnstyledButton
              key={u.id}
              p="xs"
              style={{ borderRadius: "var(--mantine-radius-md)" }}
              disabled={startingFor !== null}
              onClick={() => startDirectChat(u.id)}
            >
              <Group wrap="nowrap">
                <UserAvatar
                  name={u.name}
                  image={u.image}
                  online={u.online}
                  size="sm"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={500} truncate>
                    {u.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {u.email}
                  </Text>
                </div>
                {startingFor === u.id && <Loader size="xs" />}
              </Group>
            </UnstyledButton>
          ))}

          {!exhausted && (
            <div ref={sentinelRef}>
              <Center py="md">
                {loadingMore ? (
                  <Loader size="xs" />
                ) : (
                  <Badge variant="dot" color="gray">
                    Loading more on scroll
                  </Badge>
                )}
              </Center>
            </div>
          )}
          {exhausted && (
            <Text c="dimmed" size="xs" ta="center" py="md">
              {users.length} {users.length === 1 ? "user" : "users"} — end of
              list
            </Text>
          )}
        </Stack>
      )}
    </Drawer>
  );
}
