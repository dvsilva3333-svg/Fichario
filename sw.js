/* Fichário — service worker: keeps the app working with no internet.
   App files: try the network first (so updates arrive), fall back to the saved copy.
   Libraries and icons: saved copy first, they only change when VERSION changes. */
const VERSION = 'fichario-v3';
const SHELL = [
  './', 'index.html', 'css/fichario.css', 'js/core.js', 'js/app.js', 'manifest.webmanifest',
  'vendor/ts-fsrs.umd.js', 'vendor/jszip.min.js', 'vendor/fzstd.js', 'vendor/sql-asm.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const fixed = /\/(vendor|icons)\//.test(url.pathname);
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (fixed) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      // 'no-cache' makes the browser check with the server instead of trusting its own
      // copy for 10 minutes, so an update shows up the next time the app is opened
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
