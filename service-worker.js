// Stack — service worker
// Strategy: cache-first for the app shell, network-with-cache-fallback for everything else.
// Bump CACHE_VERSION whenever you change app shell files.

const CACHE_VERSION = 'memory-stacks-v8';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './jszip.min.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './favicon-32.png',
];

// ----- Install: precache the app shell -----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ----- Activate: clean up old caches -----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ----- Fetch: cache-first for shell, network-first for fonts/CDN -----
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // App shell: cache first, fall back to network, then populate cache.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return resp;
        }).catch(() => cached);
      })
    );
  } else {
    // External (fonts.googleapis.com, etc.): network first, fall back to cache.
    event.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return resp;
      }).catch(() => caches.match(req))
    );
  }
});

// ----- Allow page to trigger an update -----
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
