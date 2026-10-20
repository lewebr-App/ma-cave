/* Mise en cache pour un usage hors connexion (dans la cave). */
const CACHE = "ma-cave-v2";
const SHELL = ["./", "index.html", "config.js", "remote.js", "vendor/supabase.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // Les échanges avec Supabase ne passent jamais par le cache.
  if (/supabase\.co/.test(new URL(e.request.url).hostname)) return;
  // Réseau d'abord pour récupérer les mises à jour, cache si pas de réseau.
  e.respondWith(fetch(e.request).then(r => {
    if (r && (r.ok || r.type === "opaque")) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || caches.match("index.html"))));
});
