// kolm.ai service worker - retired.
//
// The current site ships no service worker: kolm-2026.js does not register one.
// This file remains only to deactivate any worker a returning visitor installed
// from the previous site, so they immediately receive the live pages instead of
// a stale cached shell. It claims open clients, deletes every cache it can find,
// unregisters itself, and reloads open tabs once.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    } catch (e) { /* Cache API unavailable */ }
    try { await self.clients.claim(); } catch (e) { /* no clients */ }
    try { await self.registration.unregister(); } catch (e) { /* already gone */ }
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try { client.navigate(client.url); } catch (e) { /* navigation blocked */ }
      }
    } catch (e) { /* no window clients */ }
  })());
});
