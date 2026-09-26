/* Public build files only. The build script supplies exact URLs and SHA-256 hashes. */
const STATIC_FILES = __SKAO_STATIC_FILES__;
const CACHE_NAME = '__SKAO_CACHE_NAME__';
const CACHE_PREFIX = 'skao-static-v1-';
const files = new Map(STATIC_FILES.map(file => [file.url, file]));
const pages = new Set(['/', '/index.html', '/dashboard', '/attendance', '/children',
  '/rooms', '/inventory', '/activities', '/schedule', '/meals', '/staff', '/reports', '/accounts']);

async function staticResponse(file) {
  const response = await fetch(new Request(new URL(file.url, self.location.origin), {
    credentials: 'omit', cache: 'no-store', redirect: 'error',
  }));
  if (!response.ok || response.type === 'opaque' || response.redirected) throw new Error('Static file unavailable.');
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== file.sha256) throw new Error('Static file does not match this build.');
  return response;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      // Validate the complete build before storing it. Never cache live requests.
      const responses = await Promise.all(STATIC_FILES.map(staticResponse));
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(STATIC_FILES.map((file, index) => cache.put(file.url, responses[index])));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
  // No skipWaiting: updates wait until the previous app's tabs are closed.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

const offlinePage = () => new Response(`<!doctype html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Smart Kids Academy — connection needed</title></head>
  <body><main><h1>We can’t reach the academy computer</h1>
  <p>Connect to the academy Wi-Fi and make sure the academy computer is on.</p>
  <p>Records need a live connection.</p><a href="/">Try again</a></main></body></html>`, {
  status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function navigation(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    // Prefer the current HTML online. Do not persist route URLs, queries or responses.
    const response = await fetch(new Request(request, { cache: 'no-store', signal: controller.signal }));
    if (![502, 503, 504].includes(response.status)) return response;
  } catch { /* A prior public shell can show the connection screen. */ }
  finally { clearTimeout(timeout); }
  try { return await (await caches.open(CACHE_NAME)).match('/index.html') || offlinePage(); }
  catch { return offlinePage(); }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // No respondWith, cache lookup, retry or queue for API, writes or other origins.
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && pages.has(url.pathname)) {
    event.respondWith(navigation(request));
  } else if (!url.search && files.has(url.pathname)) {
    event.respondWith((async () => {
      try {
        const cached = await (await caches.open(CACHE_NAME)).match(url.pathname);
        if (cached) return cached;
      } catch { /* Storage may be unavailable or evicted; use the network. */ }
      return staticResponse(files.get(url.pathname));
    })());
  }
});
