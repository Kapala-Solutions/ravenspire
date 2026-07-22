// sw.js — Ravenspire service worker.
// Makes the control panel installable and resilient offline. Strategy:
//   - Dynamic data (/sessions, /event, /history, /roles, /status, WebSocket): never cached.
//   - App shell (HTML): network-first, fall back to cache when the server is down.
//   - Static assets (icons, manifest, scripts): cache-first, refreshed in the background.
const CACHE = 'ravenspire-v1';
const SHELL = [
  '/', '/dashboard', '/history', '/rpg',
  '/manifest.webmanifest',
  '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon-32.png',
];

// Data/control endpoints that must always hit the network (never cached).
// NB: '/history' (no suffix) is the HTML page, handled by the navigation branch —
// only the data routes '/history.csv' and '/history/sessions' are bypassed here.
const BYPASS = ['/sessions', '/event', '/history.csv', '/history/sessions', '/responses', '/notify-config', '/notify-test', '/roles', '/status', '/debug', '/focus', '/open-folder', '/role', '/rename', '/clear', '/restart', '/autostart'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) return;

  // HTML / navigations: network-first so the UI stays fresh, cache as fallback.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // Static assets: cache-first, revalidate in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
