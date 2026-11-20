// perch's service worker: push notifications, and one offline page. No cache of the app itself
// (perch is live data; a stale copy would show conversations that already moved on). When the Mac
// can't be reached, the offline page links to conversations that are continuing in the cloud.
const OFFLINE = 'perch-offline-v1'
self.addEventListener('install', e => { e.waitUntil(caches.open(OFFLINE).then(c => c.add('/offline.html')).catch(() => {})); self.skipWaiting() })
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return
  e.respondWith(fetch(e.request).catch(async () => (await caches.match('/offline.html')) || Response.error()))
})
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  let n = {}
  try { n = e.data ? e.data.json() : {} } catch { n = { title: 'perch', body: e.data ? e.data.text() : '' } }
  e.waitUntil((async () => {
    // Already looking at perch on this device: don't buzz.
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (open.some(c => c.visibilityState === 'visible' && c.focused)) return
    await self.registration.showNotification(n.title || 'perch', { body: n.body || '', tag: n.tag, renotify: !!n.tag, data: { url: n.url || '/#home' }, icon: '/icon-180.png', badge: '/icon-180.png' })
  })())
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/#home'
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) { await w.focus(); w.navigate ? await w.navigate(url) : w.postMessage({ open: url }); return }
    await self.clients.openWindow(url)
  })())
})
