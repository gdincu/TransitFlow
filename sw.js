/* TransitFlow service worker.
 * Uses relative URLs so the app works when hosted under a sub-path
 * (e.g. https://user.github.io/TransitFlow/).
 * Strategy: cache-first for versioned same-origin assets/data,
 * stale-while-revalidate for navigations/app shell. OSM tiles + CDN
 * libs are intentionally network-only (too large/volatile to precache).
 */
const CACHE_NAME = "transitflow-v3";

const BASE_ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "favicon.ico",
  "css/style.css",
  "js/script.js",
];

const DATA_ASSETS = [
  "data/gtfs_shapes.geojson",
  "data/route_colors.json",
  "data/bus_schedules.json",
  "data/gtfs_stops.geojson",
];

const ICON_ASSETS = [
  "assets/icons/app-icon.svg",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/bus-stop.png",
  "assets/icons/route_icon_1.png",
  "assets/icons/route_icon_10.png",
  "assets/icons/route_icon_11.png",
  "assets/icons/route_icon_12.png",
  "assets/icons/route_icon_13.png",
  "assets/icons/route_icon_17.png",
  "assets/icons/route_icon_20.png",
  "assets/icons/route_icon_23b.png",
  "assets/icons/route_icon_24.png",
  "assets/icons/route_icon_25.png",
  "assets/icons/route_icon_29b.png",
  "assets/icons/route_icon_2b.png",
  "assets/icons/route_icon_3b.png",
  "assets/icons/route_icon_4.png",
  "assets/icons/route_icon_5b.png",
  "assets/icons/route_icon_6.png",
  "assets/icons/route_icon_9.png",
  "assets/icons/route_icon_e1r.png",
  "assets/icons/route_icon_e1t.png",
  "assets/icons/route_icon_t100.png",
  "assets/icons/route_icon_t101.png",
  "assets/icons/route_icon_t102.png",
];

const ASSETS_TO_CACHE = [...BASE_ASSETS, ...DATA_ASSETS, ...ICON_ASSETS];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("TransitFlow: Pre-caching");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              console.log("TransitFlow: Removing old cache", key);
              return caches.delete(key);
            }
            return undefined;
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

function isImmutableAsset(pathname) {
  return pathname.includes("/assets/") || pathname.includes("/data/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Leaflet CDN + OSM tiles: network only

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        // Immutable assets + data: cache-first (never revalidate within a version).
        if (cached && isImmutableAsset(url.pathname)) return cached;

        // App shell / navigations: network first, fall back to cache when offline.
        return fetch(request)
          .then((response) => {
            if (response && response.status === 200) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached)
          .then((response) => {
            // Offline and nothing cached: fail soft instead of hanging.
            if (response) return response;
            if (request.mode === "navigate") return cache.match("index.html");
            throw new Error("TransitFlow: offline with no cached response");
          });
      })
    )
  );
});
