import {
  Centrifuge,
  type Subscription,
  type JoinContext,
  type LeaveContext,
} from "centrifuge";
import type { UserChannelEvent } from "./types";

let client: Centrifuge | null = null;
let connected = false;
const presenceSubs = new Map<string, Subscription>();

function getWsUrl() {
  // Same-origin by default: `ws(s)://<page-host>/connection/websocket`
  // is proxied to Centrifugo by the custom Next server (`server.mjs`).
  // Keeping the browser on one origin means one TLS cert and no CORS;
  // the Centrifugo container doesn't need a public host port at all.
  //
  // Override with `NEXT_PUBLIC_CENTRIFUGO_URL` if you want the browser
  // to connect to Centrifugo directly (e.g. dedicated subdomain +
  // Traefik route).
  const explicit = process.env.NEXT_PUBLIC_CENTRIFUGO_URL;
  if (explicit) return explicit;
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/connection/websocket`;
  }
  return "ws://localhost:3000/connection/websocket";
}

export interface ConnectOptions {
  token: string;
  getToken: () => Promise<string>;
  onUserEvent: (event: UserChannelEvent) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  /**
   * Fires when the user: channel subscribes *after* a reconnect and Centrifugo
   * could not recover the missed message history (client fell behind the
   * server's history window). Treat as "state LOST, resync from scratch."
   */
  onRecoveryFailed?: () => void;
}

export function connect(opts: ConnectOptions) {
  if (client) {
    client.disconnect();
  }

  client = new Centrifuge(getWsUrl(), {
    token: opts.token,
    getToken: opts.getToken,
  });

  client.on("connected", () => {
    connected = true;
    opts.onConnected?.();
  });

  client.on("disconnected", () => {
    connected = false;
    opts.onDisconnected?.();
  });

  // All realtime events for this user arrive on `user:{userId}` via the
  // JWT `subs` claim — surfaced here as a client-level publication handler.
  client.on("publication", (ctx) => {
    if (ctx.channel.startsWith("user:")) {
      opts.onUserEvent(ctx.data as UserChannelEvent);
    }
  });

  client.on("subscribed", (ctx) => {
    if (
      ctx.channel.startsWith("user:") &&
      ctx.wasRecovering &&
      !ctx.recovered
    ) {
      opts.onRecoveryFailed?.();
    }
  });

  client.connect();
  return client;
}

export function disconnect() {
  if (!client) return;
  presenceSubs.forEach((sub) => {
    sub.unsubscribe();
    sub.removeAllListeners();
  });
  presenceSubs.clear();
  client.disconnect();
  client = null;
  connected = false;
}

export interface PresenceCallbacks {
  getToken: (channel: string) => Promise<string>;
  onJoin: (ctx: JoinContext) => void;
  onLeave: (ctx: LeaveContext) => void;
  onSubscribed?: (presentUserIds: string[]) => void;
}

export function subscribePresence(
  conversationId: string,
  cb: PresenceCallbacks,
): Subscription | null {
  if (!client) return null;

  const channel = `presence:conv_${conversationId}`;

  // Drop any stale sub for this channel.
  const existing = presenceSubs.get(channel);
  if (existing) {
    existing.unsubscribe();
    existing.removeAllListeners();
    client.removeSubscription(existing);
    presenceSubs.delete(channel);
  }

  const sub = client.newSubscription(channel, {
    joinLeave: true,
    getToken: () => cb.getToken(channel),
  });

  sub.on("join", cb.onJoin);
  sub.on("leave", cb.onLeave);
  sub.on("subscribed", () => {
    if (!cb.onSubscribed) return;
    sub
      .presence()
      .then((data) => {
        const userIds = Object.values(data.clients).map((c) => c.user);
        cb.onSubscribed!(userIds);
      })
      .catch(() => {});
  });

  sub.subscribe();
  presenceSubs.set(channel, sub);
  return sub;
}

export function unsubscribePresence(conversationId: string) {
  const channel = `presence:conv_${conversationId}`;
  const sub = presenceSubs.get(channel);
  if (!sub) return;
  sub.unsubscribe();
  sub.removeAllListeners();
  client?.removeSubscription(sub);
  presenceSubs.delete(channel);
}

export function isConnected() {
  return connected && client !== null;
}

export function getClient() {
  return client;
}
