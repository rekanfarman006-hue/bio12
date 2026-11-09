// Klil service worker: lets the app open without internet.
// index.html is always fetched fresh first (so updates show at once) and the saved copy is used only when offline.
const V='klil-v60';
const SHELL=['./','index.html','manifest.webmanifest'];
const RQ=u=>new Request(u,{cache:'reload'});
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL.map(RQ))).catch(()=>{}).then(()=>self.skipWaiting()))});
// when an older version was installed, reload open windows once so the new app shows at once
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(K=>{const old=K.filter(k=>k!==V);return Promise.all(old.map(k=>caches.delete(k))).then(()=>self.clients.claim()).then(()=>{if(old.length)return self.clients.matchAll({type:'window'}).then(cs=>cs.forEach(c=>{try{c.navigate(c.url)}catch(x){}}))})}))});
function put(req,res){if(res&&(res.ok||res.type==='opaque')){const c=res.clone();caches.open(V).then(x=>x.put(req,c)).catch(()=>{})}return res}
function netFirst(req,ms){return new Promise(ok=>{let done=false;
  const fb=()=>caches.match(req,{ignoreSearch:req.mode==='navigate'}).then(r=>r||(req.mode==='navigate'?caches.match('index.html'):null));
  const t=setTimeout(()=>{fb().then(r=>{if(r&&!done){done=true;ok(r)}})},ms);
  fetch(req,req.mode==='navigate'?{cache:'no-cache'}:{}).then(r=>{clearTimeout(t);put(req,r);if(!done){done=true;ok(r)}}).catch(()=>{clearTimeout(t);fb().then(r=>{if(!done){done=true;ok(r||new Response('',{status:504}))}})})})}
function swr(req){return caches.match(req).then(hit=>{const n=fetch(req).then(r=>put(req,r)).catch(()=>hit);return hit||n})}
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  if(u.pathname.endsWith('admin.html'))return;
  if(u.pathname.includes('/auth/')||u.pathname.includes('/functions/')||u.pathname.includes('/realtime/'))return;
  if(r.mode==='navigate'||u.pathname.endsWith('/index.html')){e.respondWith(netFirst(r,5000));return}
  if(u.hostname.endsWith('supabase.co')){if(u.pathname.startsWith('/rest/v1/'))e.respondWith(netFirst(r,8000));return}
  if(u.origin===location.origin){if(/yt\.json$/.test(u.pathname)){e.respondWith(netFirst(r,4000));return}e.respondWith(swr(r));return}
  if(/cdn\.jsdelivr\.net|unpkg\.com|fonts\.(googleapis|gstatic)\.com/.test(u.hostname))e.respondWith(swr(r));
});
// notifications sent by the server (pomodoro / break finished, admin replies) even when the app is closed
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:'Klil',body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'Klil',{body:d.body||'',tag:d.tag||'klil',renotify:true,icon:'icon-192-v3.png',badge:'icon-192-v3.png',vibrate:[300,150,300,150,300],requireInteraction:false}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus' in c)return c.focus()}return self.clients.openWindow('./')}))});
