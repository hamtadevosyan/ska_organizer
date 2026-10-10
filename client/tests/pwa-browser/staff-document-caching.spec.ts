import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { api, authenticatedApi, origin } from '../browser/auth-helpers';

async function publicCachesOnly(page: Page) {
  const stored = await page.evaluate(async () => Promise.all((await caches.keys()).map(async name => ({ name,
    urls: (await (await caches.open(name)).keys()).map(request => request.url),
  }))));
  expect(stored.length).toBeGreaterThan(0);
  for (const cache of stored) {
    expect(cache.name).toMatch(/^skao-static-v1-/);
    for (const value of cache.urls) {
      const url = new URL(value);
      expect(url.origin).toBe(origin);
      expect(url.search).toBe('');
      expect(url.pathname).toMatch(/^(?:\/index\.html|\/assets\/)/);
      expect(url.pathname).not.toContain('/api');
    }
  }
  expect(await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].every(key => key === 'skao-account-changed'))).toBe(true);
}

test('staff certificate files and reminders never enter PWA storage, offline reload and sign-out remove previews', async ({ page, context }) => {
  test.setTimeout(90000);
  const http = await authenticatedApi(page, { freshSession: true });
  const name = 'Synthetic private training ' + crypto.randomUUID().slice(0, 8);
  const staffResponse = await http.post(api + '/staff', { data: { name, role: 'Teacher', active: true, roomId: null } });
  expect(staffResponse.status()).toBe(201);
  const { data: employee } = await staffResponse.json();
  const base = `${api}/staff/${employee.id}/documents`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==', 'base64');
  const metadata = { category: 'other', documentDate: null, notes: 'Synthetic private training notes.', issuer: '', reference: '',
    issuedOn: null, expiresOn: null, nonExpiring: true, warningDays: null, registrationFormId: null, registrationFormRevisionId: null };
  const imageResponse = await http.post(base, { data: { ...metadata, title: 'Synthetic private certificate image', requestId: crypto.randomUUID(),
    file: { name: 'synthetic-private-certificate.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
  expect(imageResponse.status()).toBe(201);
  const saved = await imageResponse.json();
  const pdf = await readFile(new URL('../../../server/tests/fixtures/child-documents/synthetic.pdf', import.meta.url));
  const pdfResponse = await http.post(base, { data: { ...metadata, title: 'Synthetic private certificate PDF', requestId: crypto.randomUUID(),
    file: { name: 'synthetic-private-certificate.pdf', contentType: 'application/pdf', dataBase64: pdf.toString('base64') } } });
  expect(pdfResponse.status()).toBe(201);
  const externalRequests: string[] = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) externalRequests.push(url.origin);
  });
  async function openStaff() {
    await page.getByRole('searchbox', { name: 'Search staff', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'Documents & training for ' + name, exact: true }).click();
  }
  await page.goto('/staff');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await openStaff();
  const panel = page.getByRole('region', { name: 'Staff documents and training', exact: true });
  await panel.getByRole('button', { name: /^Synthetic private certificate PDF Does not expire/ }).click();
  await panel.getByRole('button', { name: 'Preview staff document version 1', exact: true }).click();
  const canvas = panel.getByRole('img', { name: 'PDF page 1', exact: true });
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(element => {
    const value = element as HTMLCanvasElement;
    if (!value.width || !value.height) return 0;
    const pixels = value.getContext('2d')!.getImageData(0, 0, value.width, value.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 180 && pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) ink++;
    }
    return ink;
  }), { message: 'The production PWA must render staff PDF text through its bundled local worker' }).toBeGreaterThan(20);
  await publicCachesOnly(page);
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await panel.getByRole('button', { name: /^Synthetic private certificate image Does not expire/ }).click();
  const opened = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/revisions/${saved.revision.id}/content`));
  await panel.getByRole('button', { name: 'Preview staff document version 1', exact: true }).click();
  const response = await opened;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(await response.body()).toEqual(png);
  const image = panel.getByRole('img', { name: 'Staff document version 1 preview', exact: true });
  await expect(image).toBeVisible();
  await publicCachesOnly(page);
  const live = await page.evaluate(async () => {
    const result = await fetch('/api/staff-compliance', { credentials: 'same-origin' });
    return { status: result.status, cache: result.headers.get('Cache-Control') };
  });
  expect(live).toEqual({ status: 200, cache: 'no-store' });
  const certificate = await readFile(new URL('../../../server/tests/fixtures/staff-expiration.png', import.meta.url));
  const reading = await page.evaluate(async ({ path, image }) => {
    const session = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const { csrfToken } = await session.json();
    const result = await fetch(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ image }) });
    const body = await result.json();
    return { status: result.status, cache: result.headers.get('Cache-Control'), readDate: /Expiration/i.test(body.text || '') };
  }, { path: `/api/staff/${employee.id}/documents/expiration-check`, image: certificate.toString('base64') });
  expect(reading).toEqual({ status: 200, cache: 'no-store', readDate: true });
  await publicCachesOnly(page);
  expect(externalRequests, 'The production staff renderer and reminders must not contact external services').toEqual([]);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Staff documents and training', exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic private training notes.', { exact: true })).toHaveCount(0);
  await publicCachesOnly(page);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await openStaff();
  await panel.getByRole('button', { name: /^Synthetic private certificate image Does not expire/ }).click();
  await panel.getByRole('button', { name: 'Preview staff document version 1', exact: true }).click();
  await expect(image).toBeVisible();
  const previewUrl = (await image.getAttribute('src'))!;
  expect(previewUrl).toMatch(/^blob:/);
  // Remove the disposable fixture from subsequent directory totals while the
  // session is still live; the local test process retains its history and files.
  expect((await http.put(`${api}/staff/${employee.id}`, { data: { active: false, version: employee.version } })).status()).toBe(200);
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', previewUrl);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Staff documents and training', exact: true })).toHaveCount(0);
  expect(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, previewUrl)).toBe(false);
  expect((await page.request.get(`${base}/${saved.document.id}/revisions/${saved.revision.id}/content`)).status()).toBe(401);
  await publicCachesOnly(page);
});
