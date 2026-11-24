// Service worker de Studoo : affiche les notifications envoyées par le serveur de tâches
// (« Ton podcast est prêt ! ») même quand le site est fermé.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Studoo", body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Studoo", {
    body: data.body || "Ta génération est terminée.",
    icon: "/icon-192.png",
    badge: "/favicon-32.png",
    data: { url: data.url || "/" },
    lang: "fr",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if ("focus" in w) { await w.navigate(url).catch(() => {}); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
