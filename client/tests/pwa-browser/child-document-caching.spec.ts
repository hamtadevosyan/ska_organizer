import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { api, authenticatedApi } from '../browser/auth-helpers';

async function publicCachesOnly(page: Page) {
  const stored = await page.evaluate(async () => {
    const names = await caches.keys();
    return (await Promise.all(names.map(async name => ({ name,
      urls: (await (await caches.open(name)).keys()).map(request => request.url),
    }))));
  });
  expect(stored.length).toBeGreaterThan(0);
  for (const cache of stored) {
    expect(cache.name).toMatch(/^skao-static-v1-/);
    for (const value of cache.urls) {
      const url = new URL(value);
      expect(url.origin).toBe('http://127.0.0.1:5179');
      expect(url.search).toBe('');
      expect(url.pathname).toMatch(/^(?:\/index\.html|\/assets\/)/);
      expect(url.pathname).not.toContain('/api');
    }
  }
}

test('document metadata and previews stay out of PWA caches; offline reload and logout remove private previews', async ({ page, context }) => {
  test.setTimeout(60000);
  const http = await authenticatedApi(page, { freshSession: true });
  const surname = 'Private document ' + crypto.randomUUID().slice(0, 8);
  const childResponse = await http.post(api + '/children', { data: { firstName: 'Synthetic', lastName: surname, dateOfBirth: '2023-01-01', roomId: null } });
  expect(childResponse.status()).toBe(201);
  const child = await childResponse.json();
  const base = `${api}/children/${child.id}/documents`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==', 'base64');
  const documentResponse = await http.post(base, { data: { title: 'Synthetic private scan', category: 'medical', documentDate: null,
    notes: 'Synthetic private document metadata.', requestId: crypto.randomUUID(),
    file: { name: 'synthetic-private.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
  expect(documentResponse.status()).toBe(201);
  const saved = await documentResponse.json();
  const pdf = await readFile(new URL('../../../server/tests/fixtures/child-documents/synthetic.pdf', import.meta.url));
  const pdfResponse = await http.post(base, { data: { title: 'Synthetic private paperwork', category: 'other', documentDate: null,
    notes: '', requestId: crypto.randomUUID(), file: { name: 'synthetic-private.pdf', contentType: 'application/pdf', dataBase64: pdf.toString('base64') } } });
  expect(pdfResponse.status()).toBe(201);
  const externalRequests: string[] = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && !['http://127.0.0.1:5179', new URL(api).origin].includes(url.origin)) externalRequests.push(url.origin);
  });
  await page.goto('/children');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('searchbox', { name: 'Search children', exact: true }).fill('Synthetic ' + surname);
  await page.getByRole('button', { name: 'View Synthetic ' + surname, exact: true }).click();
  await page.getByRole('button', { name: /^Synthetic private paperwork Other · Updated/ }).click();
  await page.getByRole('button', { name: 'Preview version 1', exact: true }).click();
  const canvas = page.getByRole('img', { name: 'PDF page 1', exact: true });
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(element => {
    const value = element as HTMLCanvasElement;
    if (!value.width || !value.height) return 0;
    const pixels = value.getContext('2d')!.getImageData(0, 0, value.width, value.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] > 180 && pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) ink++;
    return ink;
  }), { message: 'The production PWA must render PDF text through the bundled local worker' }).toBeGreaterThan(20);
  await publicCachesOnly(page);
  expect(externalRequests, 'The production PDF renderer must not request an outside service').toEqual([]);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: /^Synthetic private scan Medical record · Updated/ }).click();
  const opened = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/revisions/${saved.revision.id}/content`));
  await page.getByRole('button', { name: 'Preview version 1', exact: true }).click();
  const response = await opened;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(await response.body()).toEqual(png);
  const image = page.getByRole('img', { name: 'Document version 1 preview', exact: true });
  await expect(image).toBeVisible();
  await publicCachesOnly(page);
  const persistedKeys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  expect(persistedKeys.every(key => key === 'skao-account-changed')).toBe(true);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Document version 1 preview', exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic private document metadata.', { exact: true })).toHaveCount(0);
  await publicCachesOnly(page);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('searchbox', { name: 'Search children', exact: true }).fill('Synthetic ' + surname);
  await page.getByRole('button', { name: 'View Synthetic ' + surname, exact: true }).click();
  await page.getByRole('button', { name: /^Synthetic private scan Medical record · Updated/ }).click();
  await page.getByRole('button', { name: 'Preview version 1', exact: true }).click();
  await expect(image).toBeVisible();
  const previewUrl = (await image.getAttribute('src'))!;
  expect(previewUrl).toMatch(/^blob:/);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Document preview', exact: true })).toHaveCount(0);
  expect(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, previewUrl)).toBe(false);
  expect((await page.request.get(`${base}/${saved.document.id}/revisions/${saved.revision.id}/content`)).status()).toBe(401);
  await publicCachesOnly(page);
});
