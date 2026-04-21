"use client";

import { useRef, useState } from "react";
import { Box, Stack, Text, Center } from "@mantine/core";
import { IconPaperclip } from "@tabler/icons-react";
import { useChat } from "@/context/ChatContext";
import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { MessageInput, type MessageInputHandle } from "./MessageInput";
import { TypingIndicator } from "./TypingIndicator";
import { ConversationInfo } from "./ConversationInfo";
import { EmptyState } from "@/components/common/EmptyState";
import type { Message } from "@/lib/types";

export function ChatView() {
  const { activeConversationId, conversations } = useChat();
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const messageInputRef = useRef<MessageInputHandle>(null);

  if (!activeConversationId) {
    return <EmptyState />;
  }

  const conversation = conversations.find(
    (c) => c.id === activeConversationId,
  );
  const isGroupChat = conversation?.type === "group";

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragOver(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (hasFiles(e)) e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) messageInputRef.current?.addFiles(files);
  };

  return (
    <>
      <Box
        h="100%"
        pos="relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <Stack gap={0} h="100%">
          <ChatHeader onInfoClick={() => setInfoOpen(true)} />
          <MessageList
            isGroupChat={isGroupChat ?? false}
            onReply={setReplyTo}
          />
          <TypingIndicator />
          {/* `key` forces a remount on conversation switch. Tiptap's useEditor
              captures `sendMessage` / `sendTyping` in its extension closures on
              first mount and never re-binds. Without remounting, the Enter
              shortcut would keep sending to the previously-active conversation. */}
          <MessageInput
            ref={messageInputRef}
            key={activeConversationId}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
          />
        </Stack>
        {dragOver && (
          <Center
            pos="absolute"
            top={0}
            left={0}
            right={0}
            bottom={0}
            style={{
              background: "rgba(34, 139, 230, 0.12)",
              border: "3px dashed var(--mantine-color-blue-5)",
              borderRadius: 8,
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            <Stack align="center" gap={4}>
              <IconPaperclip size={36} color="var(--mantine-color-blue-5)" />
              <Text fw={600} c="blue.5">
                Drop files to attach
              </Text>
            </Stack>
          </Center>
        )}
      </Box>
      <ConversationInfo
        opened={infoOpen}
        onClose={() => setInfoOpen(false)}
      />
    </>
  );
}
