/* Orion OS service worker. Deliberately conservative: the app needs the network for its data, so this exists to make
   the OS installable, keep the static bundle fast, and show a friendly page when offline. It never caches API, auth or
   Supabase traffic, nor any non-GET request, and navigations always go to the network first so a deploy is picked up
   on the next load. Bump VERSION to drop old caches. */
const VERSION = 'v2';
const ASSET_CACHE = `orion-assets-${VERSION}`;
const OFFLINE_CACHE = `orion-offline-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const OFFLINE_PRECACHE = [OFFLINE_URL, '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((c) => c.addAll(OFFLINE_PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('orion-') && k !== ASSET_CACHE && k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, fonts, Twilio, ... are never touched

  // Navigations: network first; offline falls back to the offline page.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Hashed build output (Vite writes /assets/<name>-<8 char hash>.<ext>, directly under /assets/) is immutable: cache first.
  // Files in public/assets/ subfolders (logos) are not hashed and are left to the network.
  if (/^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(js|css|woff2?|png|svg|webp)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(req).then((hit) => hit || fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })),
      ),
    );
  }
  // Everything else (including /sw.js and the manifest) goes straight to the network.
});

// ── Web push ──────────────────────────────────────────────────────────────────────────────────────────────
// send-push (an edge function) delivers {title, body, url, tag}. Same tag replaces the earlier notification.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Orion OS', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Orion OS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          return w.focus().then(() => ('navigate' in w ? w.navigate(target.href) : undefined));
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
