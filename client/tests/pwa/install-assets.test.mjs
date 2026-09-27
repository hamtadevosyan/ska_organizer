import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dist = new URL('../../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', dist), 'utf8'));
const html = await readFile(new URL('index.html', dist), 'utf8');
const worker = await readFile(new URL('sw.js', dist), 'utf8');
const files = JSON.parse(worker.match(/const STATIC_FILES = (.*);/)[1]);

test('built install metadata has a stable identity, clean start URL and standalone display', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.name, 'Smart Kids Academy');
  assert.equal(manifest.short_name, 'Smart Kids');
  assert.equal(manifest.start_url, '/dashboard');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.ok(html.includes(`name="theme-color" content="${manifest.theme_color}"`));
  assert.ok(!files.some(file => file.url === '/manifest.webmanifest'), 'Manifest stays on the network path for metadata updates.');
});

test('all install icons are real PNG files at declared sizes and included in the public-only build cache', async () => {
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  const icons = [...manifest.icons, { src: '/assets/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }];
  for (const icon of icons) {
    assert.match(icon.src, /^\/assets\/icons\/[^/?#]+\.png$/);
    const png = await readFile(new URL(icon.src.slice(1), dist));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
    assert.equal(icon.type, 'image/png');
    assert.equal(png[25], 2, 'Icons have an opaque RGB background.');
    assert.ok(files.some(file => file.url === icon.src));
  }
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/assets\/icons\/apple-touch-icon.png"/);
});
