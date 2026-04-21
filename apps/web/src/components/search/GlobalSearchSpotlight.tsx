"use client";

import { useEffect, useState } from "react";
import { Spotlight, type SpotlightActionData } from "@mantine/spotlight";
import { useDebouncedValue } from "@mantine/hooks";
import { Text } from "@mantine/core";
import { IconSearch, IconUsers, IconUser } from "@tabler/icons-react";
import { api } from "@/lib/api";
import { useChat } from "@/context/ChatContext";
import "@mantine/spotlight/styles.css";

interface GlobalSearchResult {
  id: string;
  /** Server-extracted plaintext mirror — use for preview/snippets. */
  plainContent: string;
  createdAt: string;
  conversationId: string;
  conversation: { id: string; type: "direct" | "group"; name: string | null };
  senderId: string;
  sender: { id: string; name: string; image: string | null };
}

/** Window the plaintext around the matched query for a readable description. */
function snippet(plain: string, query: string): string {
  if (!query) return plain.slice(0, 140);
  const idx = plain.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return plain.slice(0, 140);
  const start = Math.max(0, idx - 30);
  const end = Math.min(plain.length, idx + query.length + 90);
  return (
    (start > 0 ? "…" : "") +
    plain.slice(start, end) +
    (end < plain.length ? "…" : "")
  );
}

export function GlobalSearchSpotlight() {
  const { jumpToMessage, conversations } = useChat();
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query, 250);
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (debounced.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .get<{ results: GlobalSearchResult[] }>(
        `/api/search?q=${encodeURIComponent(debounced)}`,
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
  }, [debounced]);

  // Build a display label per conversation. For direct chats we don't have
  // the "other user" info in the search payload, so fall back to the
  // conversations list the client already keeps in memory.
  const labelForConversation = (
    r: GlobalSearchResult,
  ): { label: string; isGroup: boolean } => {
    const c = conversations.find((x) => x.id === r.conversationId);
    const isGroup = r.conversation.type === "group";
    if (isGroup) {
      return { label: r.conversation.name ?? c?.name ?? "Group", isGroup };
    }
    // Direct chat: label by the other member's name.
    const other = c?.members.find((m) => m.userId !== r.sender.id);
    return { label: other?.user.name ?? r.sender.name, isGroup };
  };

  const actions: SpotlightActionData[] = results.map((r) => {
    const { label, isGroup } = labelForConversation(r);
    return {
      id: r.id,
      label: r.sender.name,
      description: snippet(r.plainContent, debounced),
      leftSection: isGroup ? (
        <IconUsers size={18} />
      ) : (
        <IconUser size={18} />
      ),
      rightSection: (
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      ),
      onClick: () => {
        void jumpToMessage(r.id, r.conversationId);
      },
    };
  });

  return (
    <Spotlight
      actions={actions}
      query={query}
      onQueryChange={setQuery}
      // Server already ranked by similarity — don't re-filter client-side.
      filter={(_q, items) => items}
      shortcut={["mod + K", "mod + /"]}
      searchProps={{
        leftSection: <IconSearch size={18} />,
        placeholder: "Search all your messages…",
      }}
      nothingFound={
        debounced.trim().length < 2
          ? "Type at least 2 characters to search."
          : loading
            ? "Searching…"
            : "No messages match."
      }
      scrollable
      maxHeight={420}
    />
  );
}
