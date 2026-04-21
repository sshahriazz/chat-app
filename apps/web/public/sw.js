// Chat app service worker — only handles Web Push + notification clicks.
// No caching / no offline mode (yet).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Message", body: event.data.text() };
  }

  event.waitUntil(
    (async () => {
      // De-dupe against live tabs: if any window of this app is visible +
      // focused, the in-app toast is already firing — skip the OS notification.
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const hasVisibleTab = clients.some(
        (c) => c.visibilityState === "visible" && c.focused,
      );
      if (hasVisibleTab) return;

      await self.registration.showNotification(data.title || "New message", {
        body: data.body || "",
        tag: data.tag,
        icon: data.icon,
        data: { url: data.url || "/" },
      });
    })(),
  );
});

// Same-origin check for openWindow. Push payloads come from our server
// today, but defense-in-depth: a compromised server or buggy future
// feature could send a `javascript:` or external URL. Coerce to same-
// origin relative URL and fall back to "/" on anything suspicious.
function safeSameOriginUrl(raw) {
  try {
    const scopeOrigin = new URL(self.registration.scope).origin;
    const target = new URL(raw || "/", self.registration.scope);
    if (target.origin !== scopeOrigin) return "/";
    return target.toString();
  } catch {
    return "/";
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = safeSameOriginUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const c of clients) {
        if ("focus" in c) {
          await c.focus();
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })(),
  );
});
