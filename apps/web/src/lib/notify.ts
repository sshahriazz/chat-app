/**
 * Thin wrapper over the browser Notification API. Falls back to a no-op
 * when:
 *  - the API is unavailable (SSR, old browsers)
 *  - the user hasn't granted permission
 *  - the tab is already focused (Mantine toast in-app is enough)
 *
 * Callers don't need to check those conditions themselves.
 */

export interface BrowserNotificationOpts {
  title: string;
  body: string;
  /** Deduping tag so repeated messages in the same conversation don't stack. */
  tag?: string;
  icon?: string;
  onClick?: () => void;
}

export function showBrowserNotification(opts: BrowserNotificationOpts): void {
  if (typeof window === "undefined") return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;

  let notif: Notification;
  try {
    notif = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: opts.icon,
    });
  } catch {
    // Some browsers throw if permissions get revoked between the check and
    // the construction — swallow silently.
    return;
  }

  if (opts.onClick) {
    notif.onclick = (e) => {
      e.preventDefault();
      window.focus();
      opts.onClick?.();
      notif.close();
    };
  }
}

export function getNotificationPermission(): NotificationPermission {
  if (typeof window === "undefined") return "default";
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined") return "default";
  if (typeof Notification === "undefined") return "denied";
  return Notification.requestPermission();
}

/* --- Web Push subscription ---------------------------------------------- */

function urlBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

function bufferToBase64(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Idempotent service-worker + Push subscription flow. Safe to call multiple
 * times — re-subscribe replaces the existing record by endpoint.
 *
 * Throws on any hard failure so the caller can surface a toast.
 *
 * Each step is logged to `console.debug` so a stuck subscription can be
 * traced in DevTools — "which step did we get to?" is the first question
 * when notifications aren't firing.
 */
export async function enablePushSubscription(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push not supported in this browser");
  }

  console.debug("[push] 1/5 registering /sw.js");
  const reg =
    (await navigator.serviceWorker.getRegistration("/sw.js")) ??
    (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  console.debug("[push] 2/5 service worker ready", {
    scope: reg.scope,
    state:
      reg.active?.state ?? reg.installing?.state ?? reg.waiting?.state ?? "none",
  });

  // Lazy import so this file stays tree-shakable for SSR.
  const { api } = await import("./api");
  const { key } = await api.get<{ key: string }>("/api/push/vapid-public-key");
  console.debug("[push] 3/5 fetched VAPID public key", { keyLength: key.length });

  // `pushManager.subscribe` throws if an existing subscription was minted
  // with a different applicationServerKey (e.g. you rotated VAPID keys).
  // Try once; on `InvalidStateError` or `InvalidAccessError`, unsubscribe
  // the stale one and retry fresh.
  let subscription: PushSubscription;
  try {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToArrayBuffer(key),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "InvalidStateError" || name === "InvalidAccessError") {
      console.warn(
        "[push] stale subscription detected — unsubscribing and retrying",
        name,
      );
      const existing = await reg.pushManager.getSubscription();
      if (existing) await existing.unsubscribe().catch(() => {});
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(key),
      });
    } else {
      throw err;
    }
  }
  console.debug("[push] 4/5 got PushSubscription", {
    endpointHead: subscription.endpoint.slice(0, 60),
  });

  await api.post("/api/push/subscribe", {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: bufferToBase64(subscription.getKey("p256dh")),
      auth: bufferToBase64(subscription.getKey("auth")),
    },
  });
  console.debug("[push] 5/5 server registered the subscription");
}

export async function disablePushSubscription(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  const { api } = await import("./api");
  await api.post("/api/push/unsubscribe", { endpoint }).catch(() => {});
}
