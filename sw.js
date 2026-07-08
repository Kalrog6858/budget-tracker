// Service worker: makes the app installable and usable offline.
// Strategy: network-first for GET requests, so whenever you have a connection
// you always get the latest version; when you're offline it falls back to the
// last cached copy. Bump CACHE when the asset list changes.
const CACHE = 'money-road-map-v7';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const sameOrigin = new URL(event.request.url).origin === self.location.origin;
  event.respondWith(
    fetch(event.request)
      .then(resp => {
        if (resp && resp.ok && sameOrigin) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then(cached => cached || caches.match('./index.html'))
      )
  );
});
