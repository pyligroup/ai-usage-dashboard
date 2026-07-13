'use strict';
// Minimal service worker for the AI Usage Dashboard.
//
// Two jobs:
//   1. Satisfy Android Chrome's installability criteria. A registered service
//      worker with a fetch handler is what turns "Add to Home screen" (a Chrome
//      shortcut that opens inside the browser) into "Install app" — a real
//      standalone WebAPK with its own launcher icon and no browser chrome.
//      NOTE: this only takes effect on a secure context (HTTPS, or
//      localhost/127.0.0.1). Over a plain http:// LAN IP the browser refuses to
//      register a service worker at all — that's expected, not a bug.
//   2. Cache the static shell so the app opens instantly and still paints its
//      chrome offline (data then shows the usual connection-error / skeletons).
//
// Live usage data (/api/*) is NEVER cached — it must always come from the running
// server. Caching it would resurface stale rate-limit %s, exactly the kind of
// dishonest number this project avoids.

const CACHE = 'ai-usage-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle our own origin; let the live API and anything cross-origin
  // (e.g. Tailscale/proxy control paths) go straight to the network.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // live data — always network, never cached

  // Network-first: a restarted / updated server always wins (no build step here,
  // so this is how fresh app.js/styles.css reach an installed app). Fall back to
  // the cached shell only when the network is unavailable.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html'))),
  );
});
