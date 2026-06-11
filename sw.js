// Task Adventurer service worker
// - App shell + art assets precached (cache-first)
// - index.html network-first so updates land, cached copy serves offline
// - Google Fonts (CSS + woff2) runtime-cached so the pixel font works offline
// - presets.tsv network-first (runtime cache): edits go live on next online reload,
//   no SW version bump needed; offline falls back to runtime cache, then app inline fallback
const VERSION = 'ta-v6';
const SHELL = VERSION + '-shell';
const FONTS = VERSION + '-fonts';
const DATA  = 'ta-data-v1';

// PRECACHE is passed to cache.addAll() which is atomic — one missing or
// renamed file silently aborts the entire SW install. Verify every entry
// exists in the deploy folder before pushing a rename or delete.
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './wizard_sprite.png',
  './merchant_sprite.png',
  './fighter_sprite.png',
  './bard_sprite.png',
  './rogue_sprite.png',
  './merchant_sheet.png',
  './fighter_sheet.png',
  './bard_sheet.png',
  './rogue_sheet.png',
  './wizard_confident.png',
  './wizard_tired.png',
  './wizard_hurt.png',
  './wizard_critical.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !k.startsWith(VERSION) && k !== DATA).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Fonts: cache-first, populate on first online load
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONTS).then(c =>
        c.match(e.request).then(hit =>
          hit || fetch(e.request).then(res => { c.put(e.request, res.clone()); return res; })
        )
      )
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // presets.tsv: network-first into a runtime cache so edits go live on next
  // online reload without a VERSION bump; offline falls back to cached copy
  if (url.pathname.endsWith('/presets.tsv')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(DATA).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.open(DATA).then(c => c.match(e.request)))
    );
    return;
  }

  // HTML: network-first so deploys show up, cache fallback offline
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Everything else (sprites, icons): cache-first
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy));
        return res;
      })
    )
  );
});
