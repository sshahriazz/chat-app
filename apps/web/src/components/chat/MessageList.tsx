"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  ScrollArea,
  Center,
  Loader,
  Button,
  Stack,
  Text,
  Group,
  Tooltip,
  ActionIcon,
  Affix,
  Transition,
} from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
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

  const viewportRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Scroll to bottom on new messages if at bottom
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // Initial scroll to bottom
  useEffect(() => {
    if (!isLoadingMessages && messages.length > 0) {
      bottomRef.current?.scrollIntoView();
    }
  }, [isLoadingMessages]);

  // Mark as read when visible
  useEffect(() => {
    if (messages.length > 0 && isAtBottomRef.current) {
      markAsRead();
    }
  }, [messages.length, markAsRead]);

  // Scroll the highlighted message into view when jumpToMessage fires.
  useEffect(() => {
    if (!highlightedMessageId) return;
    const el = document.querySelector(
      `[data-message-id="${CSS.escape(highlightedMessageId)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedMessageId, messages.length]);

  const handleScroll = useCallback(
    ({ y }: { x: number; y: number }) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const atBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 50;
      isAtBottomRef.current = atBottom;
      setShowScrollDown(!atBottom);
      if (atBottom) markAsRead();
    },
    [markAsRead],
  );

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Build read-by map
  const readByMessage = new Map<string, { name: string; image: string | null }[]>();
  for (const rp of readPositions) {
    if (rp.userId === user?.id || !rp.lastReadMessageId) continue;
    const existing = readByMessage.get(rp.lastReadMessageId) || [];
    existing.push({ name: rp.name, image: rp.image });
    readByMessage.set(rp.lastReadMessageId, existing);
  }

  // "N new messages" divider sits right before the first message the user
  // hadn't read when they opened this conversation. The anchor is captured
  // once per open, so the line stays put while subsequent reads fire.
  const anchorIdx = unreadAnchorId
    ? messages.findIndex((m) => m.id === unreadAnchorId)
    : -1;
  const firstUnreadIdx =
    unreadAnchorId === null && messages.length > 0
      ? 0
      : anchorIdx >= 0
        ? anchorIdx + 1
        : -1;
  const newFromOthersCount =
    firstUnreadIdx >= 0
      ? messages
          .slice(firstUnreadIdx)
          .filter((m) => m.senderId !== user?.id).length
      : 0;
  const dividerBeforeMessageId =
    newFromOthersCount > 0 && firstUnreadIdx < messages.length
      ? messages[firstUnreadIdx].id
      : null;

  // Group messages by calendar day, labelled relative to today.
  const groupedMessages: { key: string; label: string; messages: Message[] }[] =
    [];
  let currentKey = "";
  for (const msg of messages) {
    const date = new Date(msg.createdAt);
    const key = date.toDateString(); // stable per calendar day
    if (key !== currentKey) {
      currentKey = key;
      groupedMessages.push({ key, label: formatDaySeparator(date), messages: [] });
    }
    groupedMessages[groupedMessages.length - 1].messages.push(msg);
  }

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

  return (
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
      <ScrollArea
        h="100%"
        viewportRef={viewportRef}
        onScrollPositionChange={handleScroll}
      >
        <Stack gap={0} px="md" py="sm">
          {hasMoreMessages && (
            <Center py="sm">
              <Button variant="subtle" size="xs" onClick={loadMoreMessages}>
                Load older messages
              </Button>
            </Center>
          )}

          {groupedMessages.map((group) => (
            <div key={group.key}>
              <Text size="xs" c="dimmed" ta="center" py="sm" fw={500}>
                {group.label}
              </Text>
              {group.messages.map((msg, i) => {
                const prevMsg = i > 0 ? group.messages[i - 1] : null;
                const isConsecutive =
                  prevMsg &&
                  prevMsg.senderId === msg.senderId &&
                  prevMsg.type !== "system" &&
                  msg.type !== "system" &&
                  !msg.deletedAt &&
                  !prevMsg.deletedAt &&
                  new Date(msg.createdAt).getTime() -
                    new Date(prevMsg.createdAt).getTime() <
                    120000; // 2 min

                return (
                  <div
                    key={msg.id}
                    data-message-id={msg.id}
                    className={
                      highlightedMessageId === msg.id
                        ? "message-highlight"
                        : undefined
                    }
                  >
                    {msg.id === dividerBeforeMessageId && (
                      <Group
                        gap="xs"
                        my="xs"
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
                          {newFromOthersCount} new message
                          {newFromOthersCount === 1 ? "" : "s"}
                        </Text>
                        <div
                          style={{
                            flex: 1,
                            height: 1,
                            background: "var(--mantine-color-blue-3)",
                          }}
                        />
                      </Group>
                    )}
                    <MessageBubble
                      message={msg}
                      isGroupChat={isGroupChat}
                      onReply={onReply}
                      compact={!!isConsecutive}
                    />
                    {readByMessage.has(msg.id) && (
                      <Group
                        gap={4}
                        justify={msg.senderId === user?.id ? "flex-end" : "flex-start"}
                        px="xs"
                        pb={4}
                      >
                        <Text size="xs" c="dimmed">
                          Seen by
                        </Text>
                        {readByMessage.get(msg.id)!.map((r) => (
                          <Tooltip key={r.name} label={r.name}>
                            <div>
                              <UserAvatar name={r.name} image={r.image} size={16} />
                            </div>
                          </Tooltip>
                        ))}
                      </Group>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          <div ref={bottomRef} />
        </Stack>
      </ScrollArea>

      {/* Scroll to bottom button */}
      <Transition mounted={showScrollDown} transition="slide-up" duration={200}>
        {(styles) => (
          <ActionIcon
            style={{
              ...styles,
              position: "absolute",
              bottom: 16,
              right: 24,
              zIndex: 10,
            }}
            size="lg"
            radius="xl"
            variant="filled"
            onClick={scrollToBottom}
          >
            <IconArrowDown size={18} />
          </ActionIcon>
        )}
      </Transition>
    </div>
  );
}
