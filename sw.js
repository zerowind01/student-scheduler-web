// LessonMate PWA Service Worker
// 策略：页面导航 network-first（保更新，断网回退缓存）；静态资源 SWR；/api/* 永不缓存
// 更新版本号 CACHE 即可让全量客户端刷新
const CACHE = 'lessonmate-v51';
const CORE = [
  '/', '/mobile', '/index.html', '/mobile.html', '/manifest.json',
  '/icons/icon-192.png?v=6', '/icons/icon-512.png?v=6', '/icons/apple-touch-icon.png?v=6',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;        // POST /api/sync 等永远直连网络
  if (url.pathname.startsWith('/api/')) return;  // 同步与 ICS 不缓存
  if (url.origin !== location.origin) return;    // CDN（tailwind/gsap/fontawesome）直连

  // 页面导航：network-first，断网回退缓存
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('/mobile')))
    );
    return;
  }

  // 静态资源：stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});
