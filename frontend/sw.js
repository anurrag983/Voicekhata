const CACHE='voicekhata-static-frontend-v48';
const FILES=['./','./index.html','./styles.css','./dark.css','./app.js','./manifest.webmanifest','./icon.svg','./voicekhata-mark.svg','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  // API responses contain live, merchant-specific ledger data. Never cache them.
  if(url.origin===location.origin&&(url.pathname.startsWith('/api/')||url.pathname==='/health'||url.pathname.endsWith('/config.js'))){
    event.respondWith(fetch(event.request,{cache:'no-store'}));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
    if(response.ok&&url.origin===location.origin){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy))}
    return response;
  }).catch(()=>caches.match('./index.html'))));
});
