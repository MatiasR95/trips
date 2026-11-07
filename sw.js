// Offline support for use abroad (and the Mojave, where there's no signal).
// - App shell + hashed assets: cached on first visit. Navigations go network-first (fresh
//   itinerary when online), falling back to the cached shell.
// - Map tiles, glyphs and elevation: cache-first in their own cache, so every tile you've seen,
//   plus everything "Save the map for offline" prefetched, keeps working with no connection.
//   The OpenFreeMap TileJSON is network-first so tiles follow their newest build when online.
// - The sealed trip (data/*.sealed.json) is network-first: the newest published plan when online,
//   the last one seen when not. It is ciphertext, so caching it is safe.
// Paths are relative to the scope: the app is published under a sub-path (GitHub Pages).
const CACHE = 'trips-v4'
const TILES = 'trips-tiles-v1'
const TILE_HOSTS = ['tiles.openfreemap.org', 'elevation-tiles-prod.s3.amazonaws.com']

self.addEventListener('install', (e) => {
  const at = (p) => new URL(p, self.registration.scope).href
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([at('./'), at('manifest.webmanifest'), at('favicon.svg'), at('icon-192.png')])))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k)))),
  )
  self.clients.claim()
})

// Network-first, but a bad signal (the Mojave, roaming) never holds the app hostage: after `wait` ms
// the cached copy answers and the network keeps going in the background to refresh the cache.
function networkFirst(req, cacheName, fallbackKey, wait = 2500) {
  const key = fallbackKey ?? req
  const net = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone()
      caches.open(cacheName).then((c) => c.put(key, copy))
    }
    return res
  })
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => {
      if (!done && r) {
        done = true
        resolve(r)
      }
    }
    const slow = setTimeout(() => caches.match(key).then(finish), wait)
    net
      .then((res) => {
        clearTimeout(slow)
        finish(res)
      })
      .catch(() => {
        clearTimeout(slow)
        caches.match(key).then((hit) => {
          if (hit) finish(hit)
          else if (!done) {
            done = true
            resolve(Response.error())
          }
        })
      })
  })
}

function cacheFirst(req, cacheName) {
  return caches.match(req).then(
    (hit) =>
      hit ??
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(cacheName).then((c) => c.put(req, copy))
        }
        return res
      }),
  )
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Forecast: fresh when online, last good answer on the road with no signal.
  if (url.hostname === 'api.open-meteo.com') {
    e.respondWith(networkFirst(req, CACHE, undefined, 4000))
    return
  }

  if (TILE_HOSTS.includes(url.hostname)) {
    // TileJSON (the /planet index) changes with each tile build; everything under it is immutable.
    if (url.pathname === '/planet') e.respondWith(networkFirst(req, TILES))
    else e.respondWith(cacheFirst(req, TILES))
    return
  }
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, CACHE, new URL('./', self.registration.scope).href))
    return
  }
  if (url.pathname.endsWith('.sealed.json')) {
    e.respondWith(networkFirst(req, CACHE, url.origin + url.pathname))
    return
  }
  e.respondWith(cacheFirst(req, CACHE))
})
