// Saves the page's own files so it opens without a connection. Your
// bookmarks themselves are kept by the page (IndexedDB), not here.
// Change VERSION when publishing new files so phones pick them up.
const VERSION = 'v8';
const FILES = [
  './', 'index.html', 'app.js', 'app.js?v=8', 'install.js', 'sync.js', 'store.js', 'manifest.webmanifest',
  'shared/drive-api.js', 'shared/user-fields.js', 'shared/reading.js', 'shared/config.js', 'shared/tokens.css', 'shared/card.css', 'shared/busy.css', 'shared/busy.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The page's own files: from the network when online (so updates show up),
// from the saved copy when offline. Everything else (Google, images) is
// left alone.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      throw new Error('offline');
    }
  })());
});
