// 主屏启动缓存：静态外壳和构建资源走缓存，Supabase 数据仍始终请求网络。
const CACHE = 'time-tracker-v2'
const CORE = ['./', './index.html', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

async function updateNavigation(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (!response.ok) return

    const cacheable = response.clone()
    const html = await response.text()
    await cache.put('./index.html', cacheable)

    // 预热新版 JS/CSS：下一次用新外壳启动时不用再等网络。
    const assets = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)]
      .map((match) => `./${match[1]}`)
    await Promise.all(assets.map(async (asset) => {
      try {
        if (!await cache.match(asset)) await cache.add(asset)
      } catch {
        // 单个资源预取失败不影响下次启动。
      }
    }))
  } catch {
    // 离线或网络慢时继续用已缓存外壳。
  }
}

async function handleNavigation(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match('./index.html')
  void updateNavigation(request)
  return cached || fetch(request)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(request)
    if (cached) return cached

    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  })())
})
