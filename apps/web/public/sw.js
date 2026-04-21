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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
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
