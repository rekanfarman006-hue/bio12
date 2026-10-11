// Minimal service worker: lets the site be installed as an app. Always uses the network (no stale copies).
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});
