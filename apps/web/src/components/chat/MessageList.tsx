"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Center,
  Loader,
  Button,
  Text,
  Group,
  Tooltip,
  ActionIcon,
  Transition,
  Box,
} from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useChat } from "@/context/ChatContext";
import { useAuth } from "@/context/AuthContext";
import { MessageBubble } from "./MessageBubble";
import { UserAvatar } from "@/components/common/UserAvatar";
import type { Message } from "@/lib/types";

interface MessageListProps {
  isGroupChat: boolean;
  onReply: (message: Message) => void;
}

const MS_PER_DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" / "Yesterday" / weekday (within ~6 days) / absolute date. */
function formatDaySeparator(date: Date): string {
  const now = new Date();
  const diffDays = Math.round(
    (startOfDay(now) - startOfDay(date)) / MS_PER_DAY,
  );

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  }
  const sameYear = now.getFullYear() === date.getFullYear();
  return date.toLocaleDateString(
    [],
    sameYear
      ? { month: "long", day: "numeric" }
      : { year: "numeric", month: "long", day: "numeric" },
  );
}

/** Flat row model for the virtualizer — every day-header, divider and
 *  message is its own sibling row, so Virtuoso can height-measure them
 *  independently. */
type Row =
  | { kind: "load-more" }
  | { kind: "date"; key: string; label: string }
  | { kind: "unread-divider"; count: number }
  | {
      kind: "message";
      msg: Message;
      compact: boolean;
      readBy?: { name: string; image: string | null }[];
    };

const LOAD_MORE_ROW: Row = { kind: "load-more" };

export function MessageList({ isGroupChat, onReply }: MessageListProps) {
  const { user } = useAuth();
  const {
    messages,
    readPositions,
    isLoadingMessages,
    hasMoreMessages,
    loadMoreMessages,
    markAsRead,
    unreadAnchorId,
    highlightedMessageId,
  } = useChat();

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // --- Read-by map (who has last-read-message-id pointing here) ---
  const readByMessage = useMemo(() => {
    const map = new Map<string, { name: string; image: string | null }[]>();
    for (const rp of readPositions) {
      if (rp.userId === user?.id || !rp.lastReadMessageId) continue;
      const existing = map.get(rp.lastReadMessageId) ?? [];
      existing.push({ name: rp.name, image: rp.image });
      map.set(rp.lastReadMessageId, existing);
    }
    return map;
  }, [readPositions, user?.id]);

  // --- Unread divider placement (frozen per open) ---
  const { dividerBeforeMessageId, newFromOthersCount } = useMemo(() => {
    const anchorIdx = unreadAnchorId
      ? messages.findIndex((m) => m.id === unreadAnchorId)
      : -1;
    const firstUnreadIdx =
      unreadAnchorId === null && messages.length > 0
        ? 0
        : anchorIdx >= 0
          ? anchorIdx + 1
          : -1;
    const count =
      firstUnreadIdx >= 0
        ? messages
            .slice(firstUnreadIdx)
            .filter((m) => m.senderId !== user?.id).length
        : 0;
    return {
      dividerBeforeMessageId:
        count > 0 && firstUnreadIdx < messages.length
          ? messages[firstUnreadIdx].id
          : null,
      newFromOthersCount: count,
    };
  }, [messages, unreadAnchorId, user?.id]);

  // --- Flatten to virtualizer rows ---
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (hasMoreMessages) out.push(LOAD_MORE_ROW);
    let currentKey = "";
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const date = new Date(msg.createdAt);
      const key = date.toDateString();
      if (key !== currentKey) {
        currentKey = key;
        out.push({ kind: "date", key, label: formatDaySeparator(date) });
      }
      if (dividerBeforeMessageId === msg.id) {
        out.push({ kind: "unread-divider", count: newFromOthersCount });
      }
      const prev = i > 0 ? messages[i - 1] : null;
      const isConsecutive =
        !!prev &&
        prev.senderId === msg.senderId &&
        prev.type !== "system" &&
        msg.type !== "system" &&
        !msg.deletedAt &&
        !prev.deletedAt &&
        new Date(msg.createdAt).getTime() -
          new Date(prev.createdAt).getTime() <
          120_000;
      const readBy = readByMessage.get(msg.id);
      out.push({
        kind: "message",
        msg,
        compact: isConsecutive,
        readBy,
      });
    }
    return out;
  }, [
    messages,
    hasMoreMessages,
    dividerBeforeMessageId,
    newFromOthersCount,
    readByMessage,
  ]);

  // --- Auto-scroll to bottom on new messages if we're already at bottom ---
  // Virtuoso passes the current atBottom into `followOutput` — return
  // "smooth" only when the user is pinned, so incoming bursts don't yank
  // them mid-scroll if they've scrolled up.
  const followOutput = useCallback(
    (isAtBottom: boolean) =>
      isAtBottom ? ("smooth" as const) : (false as const),
    [],
  );

  // --- markAsRead when new messages arrive while at the bottom ---
  useEffect(() => {
    if (atBottom && messages.length > 0) markAsRead();
  }, [messages.length, atBottom, markAsRead]);

  // --- Jump-to-message: scroll to the row index for the target id ---
  useEffect(() => {
    if (!highlightedMessageId) return;
    const idx = rows.findIndex(
      (r) => r.kind === "message" && r.msg.id === highlightedMessageId,
    );
    if (idx < 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: idx,
      align: "center",
      behavior: "smooth",
    });
  }, [highlightedMessageId, rows]);

  if (isLoadingMessages) {
    return (
      <Center style={{ flex: 1 }}>
        <Loader size="sm" />
      </Center>
    );
  }

  if (messages.length === 0) {
    return (
      <Center style={{ flex: 1 }}>
        <Text c="dimmed" size="sm">
          No messages yet. Say hello!
        </Text>
      </Center>
    );
  }

  const renderRow = (_index: number, row: Row) => {
    switch (row.kind) {
      case "load-more":
        return (
          <Center py="sm" px="md">
            <Button variant="subtle" size="xs" onClick={loadMoreMessages}>
              Load older messages
            </Button>
          </Center>
        );
      case "date":
        return (
          <Text size="xs" c="dimmed" ta="center" py="sm" fw={500} px="md">
            {row.label}
          </Text>
        );
      case "unread-divider":
        return (
          <Group
            gap="xs"
            my="xs"
            mx="md"
            wrap="nowrap"
            align="center"
            style={{ color: "var(--mantine-color-blue-6)" }}
          >
            <div
              style={{
                flex: 1,
                height: 1,
                background: "var(--mantine-color-blue-3)",
              }}
            />
            <Text size="xs" fw={600} c="blue.6">
              {row.count} new message{row.count === 1 ? "" : "s"}
            </Text>
            <div
              style={{
                flex: 1,
                height: 1,
                background: "var(--mantine-color-blue-3)",
              }}
            />
          </Group>
        );
      case "message": {
        const { msg, compact, readBy } = row;
        return (
          <div
            data-message-id={msg.id}
            className={
              highlightedMessageId === msg.id ? "message-highlight" : undefined
            }
            style={{ padding: "0 var(--mantine-spacing-md)" }}
          >
            <MessageBubble
              message={msg}
              isGroupChat={isGroupChat}
              onReply={onReply}
              compact={compact}
            />
            {readBy && (
              <Group
                gap={4}
                justify={msg.senderId === user?.id ? "flex-end" : "flex-start"}
                px="xs"
                pb={4}
              >
                <Text size="xs" c="dimmed">
                  Seen by
                </Text>
                {readBy.map((r) => (
                  <Tooltip key={r.name} label={r.name}>
                    <UserAvatar name={r.name} image={r.image} size={16} />
                  </Tooltip>
                ))}
              </Group>
            )}
          </div>
        );
      }
    }
  };

  const computeItemKey = (index: number, row: Row): string => {
    switch (row.kind) {
      case "load-more":
        return "load-more";
      case "date":
        return `date:${row.key}`;
      case "unread-divider":
        return "unread-divider";
      case "message":
        return `msg:${row.msg.id}`;
      default:
        return String(index);
    }
  };

  return (
    <Box style={{ flex: 1, position: "relative", minHeight: 0 }}>
      <Virtuoso
        ref={virtuosoRef}
        data={rows}
        itemContent={renderRow}
        computeItemKey={computeItemKey}
        initialTopMostItemIndex={Math.max(0, rows.length - 1)}
        followOutput={followOutput}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={40}
        style={{ height: "100%" }}
        increaseViewportBy={{ top: 400, bottom: 400 }}
      />

      <Transition mounted={!atBottom} transition="fade" duration={150}>
        {(styles) => (
          <ActionIcon
            onClick={() =>
              virtuosoRef.current?.scrollToIndex({
                index: rows.length - 1,
                align: "end",
                behavior: "smooth",
              })
            }
            variant="filled"
            color="blue"
            radius="xl"
            size="lg"
            aria-label="Scroll to latest"
            style={{
              ...styles,
              position: "absolute",
              right: 16,
              bottom: 16,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            <IconArrowDown size={18} />
          </ActionIcon>
        )}
      </Transition>
    </Box>
  );
}
