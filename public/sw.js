const CACHE = 'streamfeeder-static-v1';

self.addEventListener('install', (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;
	if (
		url.pathname.startsWith('/api/') ||
		url.pathname.startsWith('/download/') ||
		url.pathname.startsWith('/.well-known/') ||
		url.pathname.startsWith('/login') ||
		url.searchParams.has('code') ||
		url.searchParams.has('state')
	) {
		return;
	}
	if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/icons/')) return;
	event.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const hit = await cache.match(req);
			if (hit) return hit;
			const res = await fetch(req);
			if (res.ok) await cache.put(req, res.clone());
			return res;
		}),
	);
});
