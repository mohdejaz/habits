// Service worker — the app is entirely offline, so the whole shell is
// precached and served cache-first. Bump CACHE to ship an update.
const CACHE = 'habit-budget-v3';

const SHELL = [
  '.',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/store.js',
  'vendor/sql-wasm.js',
  'vendor/sql-wasm.wasm',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(event.request)
        .then((res) => {
          // Cache same-origin responses so a first-run miss still works later.
          if (res.ok && new URL(event.request.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() =>
          event.request.mode === 'navigate' ? caches.match('index.html') : Response.error()
        );
    })
  );
});
