"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { notifications } from "@mantine/notifications";
import { api } from "@/lib/api";
import { showBrowserNotification } from "@/lib/notify";
import * as centrifugo from "@/lib/centrifugo";
import { useAuth } from "./AuthContext";
import type {
  Attachment,
  Conversation,
  ConversationsPage,
  Message,
  MessageContent,
  ReadPosition,
  InitResponse,
  MessagesResponse,
  UserChannelEvent,
} from "@/lib/types";
import {
  EMPTY_DOC,
  extractPlainTextFromContent,
} from "@/lib/message-content";

/**
 * Chat state is split across two contexts so high-frequency updates
 * (typingUsers, activeUserIds, incoming message bursts) don't re-render
 * the entire subtree.
 *
 * - `ChatStateContext` holds reactive state. Consumers re-render when
 *   their slice changes.
 * - `ChatActionsContext` holds a frozen actions object that proxies to
 *   the latest handlers via a ref. Its reference NEVER changes, so
 *   components that only need to trigger actions (MessageBubble, etc.)
 *   skip renders triggered by state churn elsewhere.
 *
 * `useChat()` merges both for backwards compatibility with existing
 * consumers. Perf-critical consumers should migrate to `useChatActions()`
 * so they escape the re-render storm.
 */

interface ChatStateSlice {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  readPositions: ReadPosition[];
  typingUsers: { userId: string; name: string }[];
  activeUserIds: Set<string>; // users currently viewing the active conversation
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  hasMoreMessages: boolean;
  hasMoreConversations: boolean;
  connectionLost: boolean;
  /**
   * Message id the current user had read *up to* at the moment this
   * conversation was opened. Null means they've never read it. Stays fixed
   * while the conversation is open so the "N new messages" divider doesn't
   * hop around as the user scrolls and subsequent reads fire.
   */
  unreadAnchorId: string | null;
  /** Message id currently flashing after a jump; cleared ~2s after set. */
  highlightedMessageId: string | null;
}

export interface ChatActions {
  setActiveConversation: (id: string | null) => void;
  /** Appends the next page of conversations to the sidebar. */
  loadMoreConversations: () => Promise<void>;
  sendMessage: (
    content: MessageContent,
    replyToId?: string,
    attachments?: Attachment[],
  ) => Promise<void>;
  retrySendMessage: (clientMessageId: string) => Promise<void>;
  /**
   * Scroll to a message and briefly flash it. If `conversationId` is
   * supplied and differs from the current active one, switches conversation
   * first — the conversation's fetch will use ?anchor=messageId so there's
   * only one HTTP round trip.
   */
  jumpToMessage: (messageId: string, conversationId?: string) => Promise<void>;
  editMessage: (messageId: string, content: MessageContent) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  sendTyping: () => void;
  markAsRead: () => void;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  muteConversation: (muted: boolean) => Promise<void>;
  renameGroup: (name: string) => Promise<void>;
  addMembers: (userIds: string[], name?: string) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  leaveGroup: () => Promise<void>;
  refreshConversations: () => Promise<void>;
}

type ChatState = ChatStateSlice & ChatActions;

const ChatStateContext = createContext<ChatStateSlice | null>(null);
const ChatActionsContext = createContext<ChatActions | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsCursor, setConversationsCursor] = useState<string | null>(
    null,
  );
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [readPositions, setReadPositions] = useState<ReadPosition[]>([]);
  const [typingUsers, setTypingUsers] = useState<{ userId: string; name: string }[]>([]);
  const [activeUserIds, setActiveUserIds] = useState<Set<string>>(new Set());
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [centrifugoReady, setCentrifugoReady] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [unreadAnchorId, setUnreadAnchorId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const typingTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const lastTypingSentRef = useRef(0);
  // Mirror frequently-read state into refs so stable callbacks can
  // reach the latest value without re-binding. Writes happen in a
  // `useEffect` (not during render) so concurrent rendering can
  // safely replay this component without producing inconsistent refs.
  const activeConvRef = useRef(activeConversationId);
  const conversationsRef = useRef(conversations);
  const userRef = useRef(user);
  const messagesRef = useRef(messages);
  useEffect(() => {
    activeConvRef.current = activeConversationId;
  }, [activeConversationId]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Highest seq we've seen for the currently-open conversation. A gap in
  // incoming seq values means we missed a message and need to refetch.
  const lastSeqActiveRef = useRef<number>(0);
  // When a cross-conversation jump is requested, the next conversation-switch
  // fetch uses ?anchor= instead of the default tail load, and flashes the
  // target message once the page paints. Keeps us to one HTTP round trip.
  const pendingJumpRef = useRef<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // ─── Real-time event dispatch (runs for every event on user:{me}) ───

  const handleUserEvent = useCallback((event: UserChannelEvent) => {
    const activeId = activeConvRef.current;
    const me = userRef.current;
    const eventConvId =
      event.type === "conversation_updated"
        ? event.conversation.id
        : event.type === "user_updated"
          ? null
          : event.conversationId;
    const isActive = eventConvId !== null && eventConvId === activeId;

    switch (event.type) {
      case "message_added": {
        const m = event.message;
        const newMsg: Message = {
          id: m.id,
          conversationId: event.conversationId,
          senderId: m.senderId,
          content: m.content,
          plainContent: m.plainContent,
          type: m.msgType,
          replyToId: m.replyTo?.id ?? null,
          editedAt: null,
          deletedAt: null,
          createdAt: m.createdAt,
          seq: m.seq,
          clientMessageId: m.clientMessageId,
          sender: { id: m.senderId, name: m.senderName, image: null },
          replyTo: m.replyTo,
          reactions: [],
          attachments: m.attachments ?? [],
          status: "delivered",
        };

        if (isActive && activeId) {
          // Gap detection: if we've missed a seq, refetch recent messages.
          // Skip this message for now — the refetch will include it.
          if (
            lastSeqActiveRef.current > 0 &&
            m.seq > lastSeqActiveRef.current + 1
          ) {
            api
              .get<MessagesResponse>(`/api/conversations/${activeId}/messages`)
              .then((data) => {
                setMessages(data.messages.reverse());
                setReadPositions(data.readPositions);
                setNextCursor(data.nextCursor);
                lastSeqActiveRef.current = data.messages.reduce(
                  (acc, x) => Math.max(acc, x.seq ?? 0),
                  0,
                );
              })
              .catch(() => {});
          } else {
            if (m.seq > lastSeqActiveRef.current) {
              lastSeqActiveRef.current = m.seq;
            }

            setMessages((prev) => {
              // Reconcile with an optimistic entry by clientMessageId.
              if (m.clientMessageId) {
                const idx = prev.findIndex(
                  (x) => x.clientMessageId === m.clientMessageId,
                );
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = { ...newMsg, status: "delivered" };
                  return next;
                }
              }
              // Standard dedup by server id.
              return prev.some((x) => x.id === newMsg.id)
                ? prev
                : [...prev, newMsg];
            });
          }
        }

        // Read-before-write: check toast eligibility against current state so
        // the setState updater stays pure (side-effects inside updaters can
        // trip React's "setState during render" guard).
        const target = conversationsRef.current.find(
          (c) => c.id === event.conversationId,
        );
        // An explicit mention of me bypasses mute + message-type filters.
        const mentionsMe =
          !!me && (m.mentions ?? []).includes(me.id);
        const shouldToast =
          !!target &&
          !isActive &&
          m.senderId !== me?.id &&
          m.msgType !== "system" &&
          (!target.muted || mentionsMe);

        setConversations((prev) =>
          prev
            .map((c) =>
              c.id === event.conversationId
                ? {
                    ...c,
                    updatedAt: m.createdAt,
                    unreadCount:
                      !isActive && m.senderId !== me?.id
                        ? c.unreadCount + 1
                        : c.unreadCount,
                    lastMessage: {
                      id: m.id,
                      content: m.content,
                      plainContent: m.plainContent,
                      senderId: m.senderId,
                      createdAt: m.createdAt,
                      sender: { id: m.senderId, name: m.senderName },
                    },
                  }
                : c,
            )
            .sort(
              (a, b) =>
                new Date(b.lastMessage?.createdAt ?? b.updatedAt).getTime() -
                new Date(a.lastMessage?.createdAt ?? a.updatedAt).getTime(),
            ),
        );

        if (shouldToast) {
          const preview =
            m.plainContent.length > 0
              ? m.plainContent.length > 60
                ? m.plainContent.slice(0, 60) + "..."
                : m.plainContent
              : "📎 Attachment";

          const toastTitle = mentionsMe
            ? `${m.senderName} mentioned you`
            : m.senderName;

          notifications.show({
            title: toastTitle,
            message: preview,
            color: mentionsMe ? "yellow" : undefined,
            autoClose: 4000,
          });

          // Mantine toasts only appear while the tab is focused. Mirror to
          // the native Notification API so users get pinged when the tab is
          // hidden — tag by conversation so we don't pile up dozens.
          showBrowserNotification({
            title: toastTitle,
            body: preview,
            tag: `conv:${event.conversationId}`,
            onClick: () => setActiveConversationId(event.conversationId),
          });
        }
        break;
      }

      case "message_edited": {
        if (!isActive) break;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId
              ? { ...m, content: event.content, editedAt: event.editedAt }
              : m,
          ),
        );
        break;
      }

      case "message_deleted": {
        if (isActive) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    content: EMPTY_DOC,
                    plainContent: "",
                    deletedAt: new Date().toISOString(),
                  }
                : m,
            ),
          );
        }
        break;
      }

      case "read_receipt": {
        if (!isActive) break;
        setReadPositions((prev) => {
          const filtered = prev.filter((r) => r.userId !== event.userId);
          return [
            ...filtered,
            {
              userId: event.userId,
              name: event.userName,
              image: null,
              lastReadMessageId: event.messageId,
            },
          ];
        });
        break;
      }

      case "reaction_added": {
        if (!isActive) break;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  reactions: [
                    ...(m.reactions || []),
                    {
                      id: event.reaction.id,
                      emoji: event.reaction.emoji,
                      userId: event.reaction.userId,
                      user: {
                        id: event.reaction.userId,
                        name: event.reaction.userName,
                      },
                    },
                  ],
                }
              : m,
          ),
        );
        break;
      }

      case "reaction_removed": {
        if (!isActive) break;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  reactions: (m.reactions || []).filter(
                    (r) => !(r.emoji === event.emoji && r.userId === event.userId),
                  ),
                }
              : m,
          ),
        );
        break;
      }

      case "typing_started": {
        if (!isActive || event.userId === me?.id) break;

        setTypingUsers((prev) => {
          const filtered = prev.filter((t) => t.userId !== event.userId);
          return [...filtered, { userId: event.userId, name: event.userName }];
        });

        const existing = typingTimeoutsRef.current.get(event.userId);
        if (existing) clearTimeout(existing);

        const timeout = setTimeout(() => {
          setTypingUsers((prev) => prev.filter((t) => t.userId !== event.userId));
          typingTimeoutsRef.current.delete(event.userId);
        }, 4000);
        typingTimeoutsRef.current.set(event.userId, timeout);
        break;
      }

      case "conversation_updated": {
        setConversations((prev) => {
          const existing = prev.find((c) => c.id === event.conversation.id);
          if (existing) {
            // Reject stale events (out-of-order delivery).
            if (event.conversation.version < existing.version) return prev;
            // Preserve per-user state (unreadCount, muted, lastMessage).
            return prev.map((c) =>
              c.id === existing.id
                ? {
                    ...c,
                    ...event.conversation,
                    unreadCount: c.unreadCount,
                    muted: c.muted,
                    lastMessage: c.lastMessage,
                  }
                : c,
            );
          }
          // New conversation for this user (e.g. they were just added to a group).
          return [
            {
              ...event.conversation,
              unreadCount: 0,
              muted: false,
              lastMessage: null,
            },
            ...prev,
          ];
        });
        break;
      }

      case "conversation_left": {
        setConversations((prev) => prev.filter((c) => c.id !== event.conversationId));
        if (activeConvRef.current === event.conversationId) {
          setActiveConversationId(null);
          setMessages([]);
          setReadPositions([]);
          setTypingUsers([]);
        }
        break;
      }

      case "conversation_mute_changed": {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === event.conversationId ? { ...c, muted: event.muted } : c,
          ),
        );
        break;
      }

      case "user_updated": {
        const u = event.user;
        // Patch every member reference across all conversations.
        setConversations((prev) =>
          prev.map((c) => ({
            ...c,
            members: c.members.map((mbr) =>
              mbr.userId === u.id
                ? {
                    ...mbr,
                    user: { ...mbr.user, name: u.name, image: u.image },
                  }
                : mbr,
            ),
            lastMessage:
              c.lastMessage && c.lastMessage.senderId === u.id
                ? {
                    ...c.lastMessage,
                    sender: { id: u.id, name: u.name },
                  }
                : c.lastMessage,
          })),
        );
        // Patch the currently-loaded message list as well.
        setMessages((prev) =>
          prev.map((msg) =>
            msg.senderId === u.id
              ? {
                  ...msg,
                  sender: { ...msg.sender, name: u.name, image: u.image },
                }
              : msg,
          ),
        );
        break;
      }
    }
  }, []);

  // ─── Connect once per session ────────────────────────────────

  useEffect(() => {
    if (!user) return;
    let mounted = true;

    async function init() {
      try {
        const data = await api.get<InitResponse>("/api/init");
        if (!mounted) return;

        setConversations(data.conversations);
        setConversationsCursor(data.nextCursor);
        setIsLoadingConversations(false);

        centrifugo.connect({
          token: data.centrifugoToken,
          getToken: async () => {
            const res = await api.post<{ token: string }>(
              "/api/centrifugo/connection-token",
            );
            return res.token;
          },
          onUserEvent: handleUserEvent,
          onConnected: () => {
            if (!mounted) return;
            setCentrifugoReady(true);
            setConnectionLost(false);
          },
          onDisconnected: () => {
            if (!mounted) return;
            setCentrifugoReady(false);
            setConnectionLost(true);
          },
          onRecoveryFailed: () => {
            if (!mounted) return;
            // Lost our place in the user channel's history — refetch the
            // conversation list and the active conversation's messages
            // so state is consistent again.
            api
              .get<InitResponse>("/api/init")
              .then((fresh) => {
                if (!mounted) return;
                setConversations(fresh.conversations);
                setConversationsCursor(fresh.nextCursor);
              })
              .catch(() => {});

            const activeId = activeConvRef.current;
            if (activeId) {
              api
                .get<MessagesResponse>(`/api/conversations/${activeId}/messages`)
                .then((mdata) => {
                  if (!mounted) return;
                  setMessages(mdata.messages.reverse());
                  setReadPositions(mdata.readPositions);
                  setNextCursor(mdata.nextCursor);
                  lastSeqActiveRef.current = mdata.messages.reduce(
                    (acc, x) => Math.max(acc, x.seq ?? 0),
                    0,
                  );
                })
                .catch(() => {});
            }
          },
        });
      } catch {
        if (mounted) setIsLoadingConversations(false);
      }
    }

    init();

    return () => {
      mounted = false;
      centrifugo.disconnect();
      setCentrifugoReady(false);
    };
  }, [user, handleUserEvent]);

  // ─── Load messages for the active conversation ──────────────
  //
  // Fires when the conversation id changes (or on first login). NOT gated
  // on centrifugoReady — the HTTP fetch doesn't need the socket, and
  // gating on it caused a visible full-chat reload every time the tab
  // refocused (WS reconnect → centrifugoReady flips → effect re-ran →
  // setMessages([]) + refetch). With `force_recovery: true` set on the
  // `user` namespace in centrifugo.json, the broker replays any missed
  // events on reconnect, so there's nothing for us to re-pull over HTTP.
  // Reset derived UI state synchronously when the active conversation
  // changes. React's "adjust state while rendering" pattern
  // (https://react.dev/learn/you-might-not-need-an-effect) — the new
  // conversation paints with cleared state on the first render,
  // without the cascading re-render that a setState-in-effect would
  // cause. The fetch + ref bookkeeping below still runs in useEffect
  // because it's an actual side effect.
  const [prevActiveConvId, setPrevActiveConvId] = useState(activeConversationId);
  if (prevActiveConvId !== activeConversationId) {
    setPrevActiveConvId(activeConversationId);
    if (activeConversationId) {
      setIsLoadingMessages(true);
      setMessages([]);
      setReadPositions([]);
      setTypingUsers([]);
      setUnreadAnchorId(null);
      setActiveUserIds(new Set());
      // Opening a conversation implies the sidebar should stop showing
      // unread count for it. The actual markAsRead HTTP call fires
      // later from the message list; this is just visual catch-up.
      const openedId = activeConversationId;
      setConversations((prev) =>
        prev.map((c) => (c.id === openedId ? { ...c, unreadCount: 0 } : c)),
      );
    }
  }

  useEffect(() => {
    if (!activeConversationId || !user) return;

    lastSeqActiveRef.current = 0;

    const me = user.id;
    const pending =
      pendingJumpRef.current?.conversationId === activeConversationId
        ? pendingJumpRef.current
        : null;
    const url = pending
      ? `/api/conversations/${activeConversationId}/messages?anchor=${encodeURIComponent(pending.messageId)}`
      : `/api/conversations/${activeConversationId}/messages`;

    api
      .get<MessagesResponse>(url)
      .then((data) => {
        setMessages(data.messages.reverse());
        setReadPositions(data.readPositions);
        setNextCursor(data.nextCursor);
        lastSeqActiveRef.current = data.messages.reduce(
          (acc, x) => Math.max(acc, x.seq ?? 0),
          0,
        );
        // Freeze the unread-divider anchor to where we were caught up at
        // open time. Subsequent markAsRead calls won't shift the line.
        const myPos = data.readPositions.find((p) => p.userId === me);
        setUnreadAnchorId(myPos?.lastReadMessageId ?? null);
        setIsLoadingMessages(false);
        if (pending) {
          setHighlightedMessageId(pending.messageId);
          pendingJumpRef.current = null;
        }
      })
      .catch(() => setIsLoadingMessages(false));

    api.post("/api/me/active").catch(() => {});
  }, [activeConversationId, user]);

  // ─── Presence subscription ──────────────────────────────────
  //
  // Re-runs on conversation change AND on WS reconnect, but only touches
  // `activeUserIds` (+ typing timeout cleanup). Message state is untouched.
  // The initial `setActiveUserIds(new Set())` reset is handled in the
  // adjust-during-render block above so this effect stays pure-side-effect.
  useEffect(() => {
    if (!activeConversationId || !centrifugoReady) return;

    centrifugo.subscribePresence(activeConversationId, {
      getToken: async (channel) => {
        const res = await api.post<{ token: string }>(
          "/api/centrifugo/subscription-token",
          { channel },
        );
        return res.token;
      },
      onJoin: (ctx) => {
        setActiveUserIds((prev) => new Set([...prev, ctx.info.user]));
      },
      onLeave: (ctx) => {
        setActiveUserIds((prev) => {
          const next = new Set(prev);
          next.delete(ctx.info.user);
          return next;
        });
      },
      onSubscribed: (userIds) => {
        setActiveUserIds(new Set(userIds));
      },
    });

    const convId = activeConversationId;
    return () => {
      centrifugo.unsubscribePresence(convId);
      typingTimeoutsRef.current.forEach((t) => clearTimeout(t));
      typingTimeoutsRef.current.clear();
    };
  }, [activeConversationId, centrifugoReady]);

  // ─── Actions ────────────────────────────────────────────────

  // Sends a message with optimistic UI. The local bubble appears instantly
  // with status=sending and is reconciled on HTTP response + Centrifugo echo.
  // Retries reuse the same clientMessageId — the server dedup on the unique
  // (conversationId, clientMessageId) index guarantees exactly-one insert.
  const sendMessageInternal = useCallback(
    async (
      conversationId: string,
      clientMessageId: string,
      content: MessageContent,
      replyToId: string | undefined,
      attachmentIds: string[],
    ) => {
      try {
        const saved = await api.post<Message>(
          `/api/conversations/${conversationId}/messages`,
          {
            content,
            replyToId,
            clientMessageId,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          },
        );
        setMessages((prev) =>
          prev.map((m) => {
            if (m.clientMessageId !== clientMessageId) return m;
            // If the Centrifugo echo already arrived, it will have set
            // status=delivered + the server id. Don't downgrade.
            if (m.status === "delivered") return m;
            return {
              ...m,
              id: saved.id,
              seq: saved.seq,
              createdAt: saved.createdAt,
              content: saved.content,
              plainContent: saved.plainContent,
              attachments: saved.attachments ?? m.attachments,
              status: "sent",
            };
          }),
        );
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.clientMessageId === clientMessageId
              ? { ...m, status: "failed" }
              : m,
          ),
        );
      }
    },
    [],
  );

  const sendMessage = useCallback(
    async (
      content: MessageContent,
      replyToId?: string,
      attachments?: Attachment[],
    ) => {
      if (!activeConversationId || !user) return;

      const clientMessageId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const replyTarget = replyToId
        ? messagesRef.current.find((m) => m.id === replyToId)
        : null;

      const attachmentList = attachments ?? [];
      // Optimistic plain-text so the bubble can show its own preview / reply
      // chip immediately. The server authoritative copy arrives on echo.
      const localPlain = extractPlainTextFromContent(content);

      const optimistic: Message = {
        id: `temp_${clientMessageId}`,
        clientMessageId,
        conversationId: activeConversationId,
        senderId: user.id,
        sender: { id: user.id, name: user.name, image: user.image ?? null },
        content,
        plainContent: localPlain,
        type: "text",
        replyToId: replyToId ?? null,
        replyTo: replyTarget
          ? {
              id: replyTarget.id,
              content: replyTarget.content,
              plainContent: replyTarget.plainContent,
              senderId: replyTarget.senderId,
              deletedAt: replyTarget.deletedAt,
              sender: {
                id: replyTarget.sender.id,
                name: replyTarget.sender.name,
              },
            }
          : null,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        reactions: [],
        attachments: attachmentList,
        status: "sending",
      };

      setMessages((prev) => [...prev, optimistic]);

      await sendMessageInternal(
        activeConversationId,
        clientMessageId,
        content,
        replyToId,
        attachmentList.map((a) => a.id),
      );
    },
    [activeConversationId, user, sendMessageInternal],
  );

  const retrySendMessage = useCallback(
    async (clientMessageId: string) => {
      const msg = messagesRef.current.find(
        (m) => m.clientMessageId === clientMessageId,
      );
      if (!msg || !activeConversationId) return;

      setMessages((prev) =>
        prev.map((m) =>
          m.clientMessageId === clientMessageId
            ? { ...m, status: "sending" }
            : m,
        ),
      );

      await sendMessageInternal(
        activeConversationId,
        clientMessageId,
        msg.content,
        msg.replyToId ?? undefined,
        msg.attachments?.map((a) => a.id) ?? [],
      );
    },
    [activeConversationId, sendMessageInternal],
  );

  const editMessage = useCallback(
    async (messageId: string, content: MessageContent) => {
      if (!activeConversationId) return;
      await api.put(
        `/api/conversations/${activeConversationId}/messages/${messageId}`,
        { content },
      );
    },
    [activeConversationId],
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      if (!activeConversationId) return;
      await api.delete(
        `/api/conversations/${activeConversationId}/messages/${messageId}`,
      );
    },
    [activeConversationId],
  );

  const loadMoreMessages = useCallback(async () => {
    if (!activeConversationId || !nextCursor) return;
    const data = await api.get<MessagesResponse>(
      `/api/conversations/${activeConversationId}/messages?before=${nextCursor}`,
    );
    setMessages((prev) => [...data.messages.reverse(), ...prev]);
    setNextCursor(data.nextCursor);
  }, [activeConversationId, nextCursor]);

  const jumpToMessage = useCallback(
    async (messageId: string, conversationId?: string) => {
      const target = conversationId ?? activeConversationId;
      if (!target) return;

      // Cross-conversation: let the conversation-switch effect do the
      // (anchored) fetch. pendingJumpRef tells it which anchor to use.
      if (target !== activeConversationId) {
        pendingJumpRef.current = { conversationId: target, messageId };
        setActiveConversationId(target);
        return;
      }

      // Same conversation + message already on screen → just flash.
      if (messagesRef.current.some((m) => m.id === messageId)) {
        setHighlightedMessageId(messageId);
        return;
      }

      // Same conversation, message outside current window → re-fetch centered.
      try {
        const data = await api.get<MessagesResponse>(
          `/api/conversations/${target}/messages?anchor=${encodeURIComponent(messageId)}`,
        );
        setMessages(data.messages.reverse());
        setReadPositions(data.readPositions);
        setNextCursor(data.nextCursor);
        lastSeqActiveRef.current = data.messages.reduce(
          (acc, x) => Math.max(acc, x.seq ?? 0),
          0,
        );
        setHighlightedMessageId(messageId);
      } catch {
        // Silent — the search-result card stays visible, just no jump.
      }
    },
    [activeConversationId],
  );

  // Auto-clear the flash after 2 seconds so revisiting the same id re-triggers.
  useEffect(() => {
    if (!highlightedMessageId) return;
    const handle = setTimeout(() => setHighlightedMessageId(null), 2000);
    return () => clearTimeout(handle);
  }, [highlightedMessageId]);

  const sendTyping = useCallback(() => {
    if (!activeConversationId || !user) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 3000) return;
    lastTypingSentRef.current = now;
    api.post(`/api/conversations/${activeConversationId}/typing`).catch(() => {});
  }, [activeConversationId, user]);

  const markAsRead = useCallback(() => {
    // Read from refs so this callback's identity stays stable across message
    // churn. (It's called from scroll/visibility handlers, not during render.)
    const activeId = activeConvRef.current;
    const me = userRef.current;
    const msgs = messagesRef.current;
    if (!activeId || msgs.length === 0) return;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.senderId === me?.id) return;
    api
      .post(`/api/conversations/${activeId}/read`, { messageId: lastMsg.id })
      .catch(() => {});
  }, []);

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const activeId = activeConvRef.current;
      const me = userRef.current;
      const msgs = messagesRef.current;
      if (!activeId || !me) return;
      const msg = msgs.find((m) => m.id === messageId);
      const existing = msg?.reactions?.find(
        (r) => r.emoji === emoji && r.userId === me.id,
      );
      if (existing) {
        await api.delete(
          `/api/conversations/${activeId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        );
      } else {
        await api.post(
          `/api/conversations/${activeId}/messages/${messageId}/reactions`,
          { emoji },
        );
      }
    },
    [],
  );

  const refreshConversations = useCallback(async () => {
    const page = await api.get<ConversationsPage>("/api/conversations");
    setConversations(page.conversations);
    setConversationsCursor(page.nextCursor);
  }, []);

  const loadMoreConversations = useCallback(async () => {
    // Fall-through if we've already loaded the tail.
    const cursor = conversationsCursor;
    if (!cursor) return;
    const page = await api.get<ConversationsPage>(
      `/api/conversations?before=${encodeURIComponent(cursor)}`,
    );
    setConversations((prev) => {
      // De-dupe on id — a realtime `conversation_updated` could've already
      // bumped one of the older conversations into `prev` while we were
      // fetching this page.
      const seen = new Set(prev.map((c) => c.id));
      const merged = [...prev];
      for (const c of page.conversations) {
        if (!seen.has(c.id)) merged.push(c);
      }
      return merged;
    });
    setConversationsCursor(page.nextCursor);
  }, [conversationsCursor]);

  const muteConversation = useCallback(
    async (muted: boolean) => {
      if (!activeConversationId) return;
      await api.post(`/api/conversations/${activeConversationId}/mute`, { muted });
      setConversations((prev) =>
        prev.map((c) => (c.id === activeConversationId ? { ...c, muted } : c)),
      );
    },
    [activeConversationId],
  );

  const renameGroup = useCallback(
    async (name: string) => {
      if (!activeConversationId) return;
      await api.put(`/api/conversations/${activeConversationId}`, { name });
      await refreshConversations();
    },
    [activeConversationId, refreshConversations],
  );

  const addMembers = useCallback(
    async (userIds: string[], name?: string) => {
      if (!activeConversationId) return;
      await api.post(`/api/conversations/${activeConversationId}/members`, {
        userIds,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });
      await refreshConversations();
    },
    [activeConversationId, refreshConversations],
  );

  const removeMember = useCallback(
    async (userId: string) => {
      if (!activeConversationId) return;
      await api.delete(
        `/api/conversations/${activeConversationId}/members/${userId}`,
      );
      await refreshConversations();
    },
    [activeConversationId, refreshConversations],
  );

  const leaveGroup = useCallback(async () => {
    if (!activeConversationId || !user) return;
    await api.delete(
      `/api/conversations/${activeConversationId}/members/${user.id}`,
    );
    setActiveConversationId(null);
    await refreshConversations();
  }, [activeConversationId, user, refreshConversations]);

  const setActiveConversation = useCallback((id: string | null) => {
    setActiveConversationId(id);
  }, []);

  // Latest-handler ref. Written in a layout effect — not during render
  // — so concurrent rendering can replay this component without
  // leaving stale implementations visible to children. `useLayoutEffect`
  // (rather than `useEffect`) guarantees children that mount after us
  // see the fresh handlers synchronously on their first render.
  const actionsRef = useRef<ChatActions | null>(null);
  useLayoutEffect(() => {
    actionsRef.current = {
      sendMessage,
      retrySendMessage,
      editMessage,
      deleteMessage,
      loadMoreMessages,
      jumpToMessage,
      sendTyping,
      markAsRead,
      toggleReaction,
      muteConversation,
      renameGroup,
      addMembers,
      removeMember,
      leaveGroup,
      refreshConversations,
      setActiveConversation,
      loadMoreConversations,
    };
  });

  // Frozen proxy object — its identity never changes, so consumers of
  // `useChatActions()` don't re-render on state churn. Each method reads
  // the latest implementation through the ref.
  const stableActions = useMemo(
    (): ChatActions => ({
      sendMessage: (content, replyToId, attachments) =>
        actionsRef.current!.sendMessage(content, replyToId, attachments),
      retrySendMessage: (clientMessageId) =>
        actionsRef.current!.retrySendMessage(clientMessageId),
      editMessage: (messageId, content) =>
        actionsRef.current!.editMessage(messageId, content),
      deleteMessage: (messageId) =>
        actionsRef.current!.deleteMessage(messageId),
      loadMoreMessages: () => actionsRef.current!.loadMoreMessages(),
      jumpToMessage: (messageId, conversationId) =>
        actionsRef.current!.jumpToMessage(messageId, conversationId),
      sendTyping: () => actionsRef.current!.sendTyping(),
      markAsRead: () => actionsRef.current!.markAsRead(),
      toggleReaction: (messageId, emoji) =>
        actionsRef.current!.toggleReaction(messageId, emoji),
      muteConversation: (muted) =>
        actionsRef.current!.muteConversation(muted),
      renameGroup: (name) => actionsRef.current!.renameGroup(name),
      addMembers: (userIds, name) =>
        actionsRef.current!.addMembers(userIds, name),
      removeMember: (userId) => actionsRef.current!.removeMember(userId),
      leaveGroup: () => actionsRef.current!.leaveGroup(),
      refreshConversations: () => actionsRef.current!.refreshConversations(),
      setActiveConversation: (id) =>
        actionsRef.current!.setActiveConversation(id),
      loadMoreConversations: () =>
        actionsRef.current!.loadMoreConversations(),
    }),
    [],
  );

  const state: ChatStateSlice = {
    conversations,
    activeConversationId,
    messages,
    readPositions,
    typingUsers,
    activeUserIds,
    isLoadingConversations,
    isLoadingMessages,
    hasMoreMessages: nextCursor !== null,
    hasMoreConversations: conversationsCursor !== null,
    connectionLost,
    unreadAnchorId,
    highlightedMessageId,
  };

  return (
    <ChatActionsContext.Provider value={stableActions}>
      <ChatStateContext.Provider value={state}>
        {children}
      </ChatStateContext.Provider>
    </ChatActionsContext.Provider>
  );
}

/**
 * Combines state + actions. Preserves the original API so every existing
 * consumer keeps working. Prefer `useChatActions()` or `useChatState()` in
 * perf-sensitive components.
 */
export function useChat(): ChatState {
  const state = useContext(ChatStateContext);
  const actions = useContext(ChatActionsContext);
  if (!state || !actions) {
    throw new Error("useChat must be used within ChatProvider");
  }
  return { ...state, ...actions };
}

/**
 * Subscribe to actions only. The returned object's identity is stable for
 * the lifetime of the provider — calling components never re-render due to
 * unrelated state churn (typing, presence, incoming messages).
 */
export function useChatActions(): ChatActions {
  const actions = useContext(ChatActionsContext);
  if (!actions) {
    throw new Error("useChatActions must be used within ChatProvider");
  }
  return actions;
}

/** Reactive state slice. Consumers re-render whenever any field changes. */
export function useChatState(): ChatStateSlice {
  const state = useContext(ChatStateContext);
  if (!state) {
    throw new Error("useChatState must be used within ChatProvider");
  }
  return state;
}
