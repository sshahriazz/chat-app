export interface User {
  id: string;
  name: string;
  email: string;
  image: string | null;
  lastActiveAt?: string | null;
}

export interface ConversationMember {
  id: string;
  conversationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
  user: User;
}

/**
 * Local delivery status. Server-authoritative messages have no status; only
 * messages sent from this client go through sending/sent/delivered/failed.
 */
export type MessageStatus = "sending" | "sent" | "delivered" | "failed";

export interface Attachment {
  id: string;
  url: string;
  contentType: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
}

/**
 * Tiptap JSON tree. We alias the shape the server ships — the full type from
 * @tiptap/core is imported where we actually invoke the renderer; elsewhere
 * this structural alias keeps types lightweight.
 */
export type MessageContent = {
  type: string;
  content?: MessageContent[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
};

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  /** Tiptap JSON AST. Render via generateHTML(content, extensions). */
  content: MessageContent;
  /** Flat text mirror from server — safe for previews, snippets, toasts. */
  plainContent: string;
  type: "text" | "system" | "image";
  replyToId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  seq?: number;
  clientMessageId?: string | null;
  status?: MessageStatus;
  sender: { id: string; name: string; image: string | null };
  replyTo?: {
    id: string;
    /** Tiptap JSON — same shape as message content. */
    content: MessageContent;
    plainContent?: string;
    senderId: string;
    deletedAt: string | null;
    sender: { id: string; name: string };
  } | null;
  reactions?: Reaction[];
  attachments?: Attachment[];
}

export interface Reaction {
  id: string;
  emoji: string;
  userId: string;
  user: { id: string; name: string };
}

export interface ReadPosition {
  userId: string;
  name: string;
  image: string | null;
  lastReadMessageId: string | null;
}

export interface Conversation {
  id: string;
  type: "direct" | "group";
  name: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  members: ConversationMember[];
  unreadCount: number;
  muted: boolean;
  lastMessage: {
    id: string;
    /** Tiptap JSON AST (server ships `content` from the messages row). */
    content: MessageContent;
    /** Flat text mirror from server — safe for sidebar previews. */
    plainContent: string;
    senderId: string;
    createdAt: string;
    sender: { id: string; name: string };
  } | null;
}

export interface InitResponse {
  conversations: Conversation[];
  /** ISO timestamp cursor for loading older conversations; null = no more. */
  nextCursor: string | null;
  centrifugoToken: string;
}

export interface ConversationsPage {
  conversations: Conversation[];
  nextCursor: string | null;
}

export interface MessagesResponse {
  messages: Message[];
  readPositions: ReadPosition[];
  nextCursor: string | null;
}

export interface SearchUser extends User {
  online: boolean;
}

// Real-time events delivered on the user's `user:{userId}` channel.
// Every event carries `type` and `conversationId`.

export interface MessageAddedEvent {
  type: "message_added";
  conversationId: string;
  message: {
    id: string;
    seq: number;
    senderId: string;
    senderName: string;
    /** Tiptap JSON AST. Shipped verbatim; no HTML on the wire. */
    content: MessageContent;
    /** Flat text mirror — used directly for previews/toasts without AST walking. */
    plainContent: string;
    msgType: "text" | "system" | "image";
    replyTo: Message["replyTo"];
    createdAt: string;
    clientMessageId: string | null;
    attachments?: Attachment[];
    /** User ids of members mentioned in this message — already scoped to actual conversation members server-side. */
    mentions?: string[];
  };
}

export interface MessageEditedEvent {
  type: "message_edited";
  conversationId: string;
  messageId: string;
  /** Tiptap JSON AST — the updated content. */
  content: MessageContent;
  editedAt: string;
}

export interface MessageDeletedEvent {
  type: "message_deleted";
  conversationId: string;
  messageId: string;
}

export interface ReadReceiptEvent {
  type: "read_receipt";
  conversationId: string;
  userId: string;
  userName: string;
  messageId: string;
}

export interface ReactionAddedEvent {
  type: "reaction_added";
  conversationId: string;
  messageId: string;
  reaction: { id: string; emoji: string; userId: string; userName: string };
}

export interface ReactionRemovedEvent {
  type: "reaction_removed";
  conversationId: string;
  messageId: string;
  emoji: string;
  userId: string;
}

export interface TypingStartedEvent {
  type: "typing_started";
  conversationId: string;
  userId: string;
  userName: string;
}

/**
 * Shape the server ships inside `conversation_updated` events. It is the
 * conversation as visible to every member (no per-user unread/mute state).
 * The client merges this into its list; missing fields preserve local state.
 */
export interface ConversationEventPayload {
  id: string;
  type: "direct" | "group";
  name: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  members: ConversationMember[];
}

export interface ConversationUpdatedEvent {
  type: "conversation_updated";
  conversation: ConversationEventPayload;
}

export interface ConversationLeftEvent {
  type: "conversation_left";
  conversationId: string;
}

export interface ConversationMuteChangedEvent {
  type: "conversation_mute_changed";
  conversationId: string;
  muted: boolean;
}

export interface UserUpdatedEvent {
  type: "user_updated";
  user: {
    id: string;
    name: string;
    image: string | null;
  };
}

export type UserChannelEvent =
  | MessageAddedEvent
  | MessageEditedEvent
  | MessageDeletedEvent
  | ReadReceiptEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | TypingStartedEvent
  | ConversationUpdatedEvent
  | ConversationLeftEvent
  | ConversationMuteChangedEvent
  | UserUpdatedEvent;
