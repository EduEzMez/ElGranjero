// Service worker de DonGranjero.
// Estrategia "primero la red": con conexión siempre trae lo último (no quedan versiones viejas
// después de un deploy); sin conexión usa la última copia guardada de la web y de los datos.
const CACHE = "dongranjero-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/js/app.js", "/js/engine.js", "/js/data.js", "/js/insights.js", "/js/icons.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/settings")) return; // nunca se guardan ajustes en caché
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : Response.error())))
  );
});
