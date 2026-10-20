import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const origin = 'https://academy.test';
const dist = new URL('../../dist/', import.meta.url);
const source = await readFile(new URL('sw.js', dist), 'utf8');
const manifest = JSON.parse(source.match(/const STATIC_FILES = (.*);/)[1]);
const cacheName = source.match(/const CACHE_NAME = '([^']+)'/)[1];
const bodies = new Map(await Promise.all(manifest.map(async file => [file.url,
  await readFile(new URL(file.url.slice(1), dist))])));

function harness() {
  const events = new Map(), stores = new Map(), calls = [];
  let cacheReads = 0, claimed = 0;
  const key = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
  const caches = {
    async open(name) {
      cacheReads++;
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        match: async request => {
          const saved = store.get(key(request));
          if (!saved) return undefined;
          return new Response(saved.bytes.slice(), {
            status: saved.status, statusText: saved.statusText, headers: saved.headers,
          });
        },
        put: async (request, response) => {
          // Cache.put consumes the supplied body and stores a snapshot. Keep
          // bytes here, not long-lived Node Response streams and clone branches.
          const saved = { status: response.status, statusText: response.statusText,
            headers: [...response.headers], bytes: new Uint8Array(await response.arrayBuffer()) };
          store.set(key(request), saved);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
  };
  let serve = async request => new Response(bodies.get(new URL(request.url).pathname) || 'not found', {
    status: bodies.has(new URL(request.url).pathname) ? 200 : 404,
  });
  const scope = {
    self: { location: { origin }, clients: { claim: async () => { claimed++; } },
      addEventListener: (type, callback) => events.set(type, callback),
      skipWaiting: () => { throw new Error('An update must not replace an active worker.'); } },
    caches, crypto: webcrypto, Request, Response, Headers, URL, Uint8Array, AbortController, setTimeout, clearTimeout,
    fetch: async request => { calls.push(request); return serve(request); },
  };
  vm.runInNewContext(source, scope);
  async function lifecycle(type) {
    let task;
    events.get(type)({ waitUntil: promise => { task = promise; } });
    await task;
  }
  function dispatch(path, options = {}, navigation = false) {
    const request = new Request(new URL(path, origin), options);
    if (navigation) Object.defineProperty(request, 'mode', { value: 'navigate' });
    let response;
    events.get('fetch')({ request, respondWith: promise => { response = promise; } });
    return { request, response };
  }
  return { lifecycle, dispatch, stores, calls, caches,
    network: fn => { serve = fn; },
    reads: () => cacheReads, claimed: () => claimed,
    keys: () => [...(stores.get(cacheName)?.keys() || [])],
  };
}

test('the cache fixture consumes a body without cloning and snapshots response metadata', async () => {
  const sw = harness();
  const cache = await sw.caches.open('fixture-cache');
  const response = new Response('Synthetic public bytes', {
    status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/plain', 'X-Build': 'original' },
  });
  Object.defineProperty(response, 'clone', { value() {
    throw new TypeError('Response.clone: Body has already been consumed.');
  } });
  await cache.put('/fixture.txt', response);
  assert.equal(response.bodyUsed, true);
  response.headers.set('X-Build', 'changed after put');
  const saved = await cache.match('/fixture.txt');
  assert.equal(saved.status, 200);
  assert.equal(saved.statusText, 'OK');
  assert.equal(saved.headers.get('content-type'), 'text/plain');
  assert.equal(saved.headers.get('x-build'), 'original');
  assert.equal(await saved.text(), 'Synthetic public bytes');
});

test('the cache fixture returns independent fresh bodies without retaining response streams', async () => {
  const sw = harness();
  const cache = await sw.caches.open('fixture-cache');
  await cache.put('/fixture.txt', new Response('Synthetic public bytes'));
  const first = await cache.match('/fixture.txt');
  const second = await cache.match('/fixture.txt');
  assert.notEqual(first, second);
  assert.equal(await first.text(), 'Synthetic public bytes');
  assert.equal(second.bodyUsed, false);
  const bytes = new Uint8Array(await second.arrayBuffer());
  bytes.fill(0);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  assert.equal(await (await cache.match('/fixture.txt')).text(), 'Synthetic public bytes');
  assert.equal(await cache.match('/missing.txt'), undefined);
});

test('the generated worker lists only exact public build files with matching hashes', () => {
  assert.ok(manifest.length > 1);
  assert.ok(manifest.some(file => file.url === '/index.html'));
  for (const file of manifest) {
    assert.match(file.url, /^(?:\/index\.html|\/assets\/[^?#]+\.(?:m?js|css|woff2?|ttf|otf|pfb|png|jpe?g|webp|avif|gif|svg|ico))$/);
    assert.equal(file.sha256, createHash('sha256').update(bodies.get(file.url)).digest('hex'));
  }
  assert.match(cacheName, /^skao-static-v1-[a-f0-9]{20}$/);
});

test('install stores only verified public bytes and fetches without credentials or HTTP cache', async () => {
  const sw = harness();
  await sw.lifecycle('install');
  assert.deepEqual(sw.keys().sort(), manifest.map(file => origin + file.url).sort());
  assert.equal(sw.calls.length, manifest.length);
  for (const request of sw.calls) {
    assert.equal(request.credentials, 'omit');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.redirect, 'error');
  }
});

test('installation consumes each fetched body once and caches fresh verified responses without cloning', async () => {
  const sw = harness(); const fetched = [];
  sw.network(async request => {
    const path = new URL(request.url).pathname;
    const response = new Response(bodies.get(path), { headers: {
      'Content-Type': path.endsWith('.html') ? 'text/html' : 'application/octet-stream',
      'Content-Encoding': 'gzip', 'Content-Length': '1', 'X-Public-Build': 'verified',
    } });
    // Deterministically reproduce the unsafe branch: a runtime returning the
    // consumed source from clone must never affect the verified cache body.
    Object.defineProperty(response, 'clone', { value() { return response; } });
    const read = response.arrayBuffer.bind(response); let reads = 0;
    Object.defineProperty(response, 'arrayBuffer', { value() {
      assert.equal(++reads, 1, 'a network body must be consumed exactly once');
      return read();
    } });
    fetched.push(response); return response;
  });
  await sw.lifecycle('install');
  assert.equal(fetched.length, manifest.length);
  assert.ok(fetched.every(response => response.bodyUsed));
  const cache = await sw.caches.open(cacheName);
  for (const file of manifest) {
    const saved = await cache.match(file.url);
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bodies.get(file.url));
    assert.equal(saved.headers.get('x-public-build'), 'verified');
    assert.equal(saved.headers.get('content-encoding'), null);
    assert.equal(saved.headers.get('content-length'), null);
  }
});

test('uncached static fetch returns a readable verified response without cloning', async () => {
  const sw = harness(); const file = manifest.find(file => file.url.startsWith('/assets/'));
  assert.ok(file);
  sw.network(async request => {
    const response = new Response(bodies.get(new URL(request.url).pathname));
    Object.defineProperty(response, 'clone', { value() { throw new TypeError('Synthetic consumed clone'); } });
    return response;
  });
  const response = await sw.dispatch(file.url).response;
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bodies.get(file.url));
  assert.deepEqual(sw.keys(), [], 'a cache miss must not enable runtime caching');
});

test('API, credentials, writes, other origins and unknown/query asset URLs never touch caches or respondWith', async () => {
  const sw = harness();
  await sw.lifecycle('install');
  const before = sw.reads(), fetches = sw.calls.length;
  const paths = ['/api', '/api/auth/session', '/api/children', '/api/attendance/daily?room=private-id',
    '/api/staff', '/api/staff/synthetic-employee/documents', '/api/staff/synthetic-employee/documents/checklist',
    '/api/staff/synthetic-employee/documents/synthetic-document',
    '/api/staff/synthetic-employee/documents/synthetic-document/revisions/synthetic-revision/content',
    '/api/staff/synthetic-employee/documents/synthetic-document/revisions/synthetic-revision/content?download=1',
    '/api/staff-compliance', '/api/staff-compliance?staffId=synthetic-employee', '/api/staff-compliance/settings',
    '/api/reports/export.csv', '/api/inventory', '/api/health',
    '/api/ready', '/assets/private.json', 'https://elsewhere.test/assets/private.js', manifest[0].url + '?private=value'];
  for (const path of paths) {
    assert.equal(sw.dispatch(path).response, undefined, path);
    assert.equal(sw.dispatch(path, {}, true).response, undefined, path);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    const { request, response } = sw.dispatch('/api/attendance/checkin', {
      method, headers: { 'X-CSRF-Token': 'synthetic-security-token', Cookie: 'synthetic-session' },
    });
    assert.equal(response, undefined);
    assert.equal(request.headers.get('X-CSRF-Token'), 'synthetic-security-token');
  }
  assert.equal(sw.dispatch('/index.html', { method: 'POST' }, true).response, undefined);
  assert.equal(sw.reads(), before);
  assert.equal(sw.calls.length, fetches);
});

test('offline route reload returns only the public shell and never stores route/query URLs', async () => {
  const sw = harness();
  await sw.lifecycle('install');
  const before = sw.keys();
  sw.network(async () => { throw new TypeError('Synthetic offline'); });
  const response = await sw.dispatch('/attendance?room=sensitive-room-id', {}, true).response;
  assert.equal(await response.text(), bodies.get('/index.html').toString());
  assert.deepEqual(sw.keys(), before);
  assert.equal(sw.dispatch('/api/children?private=value', {}, true).response, undefined);
});

test('online navigation prefers fresh HTML, preserves access denials and never caches its response', async () => {
  const sw = harness();
  await sw.lifecycle('install');
  const before = sw.keys();
  sw.network(async request => {
    assert.equal(request.cache, 'no-store');
    return new Response('Fresh public HTML');
  });
  assert.equal(await (await sw.dispatch('/dashboard', {}, true).response).text(), 'Fresh public HTML');
  for (const status of [401, 403, 404]) {
    sw.network(async () => new Response('Access denied', { status }));
    assert.equal((await sw.dispatch('/dashboard', {}, true).response).status, status);
  }
  sw.network(async () => new Response('Gateway unavailable', { status: 503 }));
  assert.equal(await (await sw.dispatch('/dashboard', {}, true).response).text(), bodies.get('/index.html').toString());
  assert.deepEqual(sw.keys(), before);
});

test('a bad build response prevents installation instead of persisting unexpected content', async () => {
  const sw = harness();
  sw.network(async () => new Response(JSON.stringify({ child: 'Synthetic private record' })));
  await assert.rejects(sw.lifecycle('install'), /does not match/);
  assert.deepEqual(sw.keys(), []);
});

test('class pages can reload the public shell offline without caching class URLs or intercepting clinical APIs', async () => {
  const sw = harness(); await sw.lifecycle('install'); const before = sw.keys();
  sw.network(async () => { throw new Error('Synthetic offline connection'); });
  for (const path of ['/classroom', '/classroom/children', '/classroom/activities', '/classroom/meals', '/classroom/attendance']) {
    assert.equal(await (await sw.dispatch(path, {}, true).response).text(), bodies.get('/index.html').toString());
  }
  for (const path of ['/api/classroom/attendance', '/api/classroom/children/child/safety', '/api/children/child/safety']) {
    assert.equal(sw.dispatch(path, {}, true).response, undefined);
  }
  assert.deepEqual(sw.keys(), before);
});

test('activation removes only obsolete SKA static caches and claims clients after install', async () => {
  const sw = harness();
  await sw.lifecycle('install');
  sw.stores.set('skao-static-v1-old', new Map());
  sw.stores.set('other-application-cache', new Map());
  await sw.lifecycle('activate');
  assert.ok(!sw.stores.has('skao-static-v1-old'));
  assert.ok(sw.stores.has('other-application-cache'));
  assert.ok(sw.stores.has(cacheName));
  assert.equal(sw.claimed(), 1);
});

test('evicted shell produces a public connection page; missing static files are verified but not cached at runtime', async () => {
  const sw = harness();
  sw.network(async () => { throw new TypeError('Synthetic offline'); });
  const offline = await sw.dispatch('/children?name=private-value', {}, true).response;
  assert.equal(offline.status, 503);
  const html = await offline.text();
  assert.match(html, /academy computer/);
  assert.ok(!html.includes('private-value'));
  const file = manifest.find(value => value.url.endsWith('.css'));
  sw.network(async () => new Response(bodies.get(file.url)));
  assert.equal((await sw.dispatch(file.url).response).status, 200);
  assert.deepEqual(sw.keys(), []);
});
