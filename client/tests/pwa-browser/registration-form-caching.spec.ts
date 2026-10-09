import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from '../browser/auth-helpers';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==', 'base64');

test('blank registration templates stay out of PWA storage and their previews are revoked at sign-out', async ({ page }) => {
  test.setTimeout(60000);
  let http = await authenticatedApi(page, { freshSession: true });
  const title = 'Synthetic private registration ' + crypto.randomUUID().slice(0, 8);
  const created = await http.post(api + '/registration-forms', { data: { title, instructions: 'Synthetic blank registration instructions.',
    category: 'medical', required: true, requestId: crypto.randomUUID(),
    file: { name: 'synthetic-blank.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
  expect(created.status()).toBe(201);
  const { form } = await created.json();
  try {
    const response = await http.post(api + '/children', { data: { firstName: 'Synthetic', lastName: title, dateOfBirth: '2023-01-01', roomId: null } });
    expect(response.status()).toBe(201);
    await page.goto('/children');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByRole('searchbox', { name: 'Search children', exact: true }).fill('Synthetic ' + title);
    await page.getByRole('button', { name: 'View Synthetic ' + title, exact: true }).click();
    const card = page.getByRole('region', { name: 'Registration checklist', exact: true }).getByRole('article', { name: title, exact: true });
    const contentPath = `/registration-forms/${form.id}/revisions/${form.currentRevisionId}/content`;
    const opened = page.waitForResponse(value => new URL(value.url()).pathname.endsWith(contentPath));
    await card.getByRole('button', { name: 'Preview blank ' + title, exact: true }).click();
    const content = await opened;
    expect(content.status()).toBe(200);
    expect(content.headers()['cache-control']).toContain('no-store');
    expect(await content.body()).toEqual(png);
    const image = page.getByRole('img', { name: 'Blank ' + title + ' preview', exact: true });
    await expect(image).toBeVisible();
    const url = (await image.getAttribute('src'))!;
    expect(url).toMatch(/^blob:/);
    const cacheUrls = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name =>
      (await (await caches.open(name)).keys()).map(request => request.url)))).flat());
    expect(cacheUrls.length).toBeGreaterThan(0);
    for (const value of cacheUrls) {
      const cached = new URL(value);
      expect(cached.pathname).toMatch(/^(?:\/index\.html|\/assets\/)/);
      expect(cached.search).toBe('');
    }
    expect(await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].every(key => key === 'skao-account-changed'))).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(image).toHaveCount(0);
    await expect(page.getByText('Synthetic blank registration instructions.', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(async value => { try { await fetch(value); return true; } catch { return false; } }, url)).toBe(false);
    expect((await page.request.get(api + contentPath)).status()).toBe(401);
  } finally {
    http = await authenticatedApi(page, { freshSession: true });
    const detail = await http.get(api + '/registration-forms/' + form.id);
    if (detail.ok()) {
      const { form: current } = await detail.json();
      expect((await http.put(api + '/registration-forms/' + current.id, { data: { version: current.version, title: current.title,
        instructions: current.instructions, category: current.category, required: current.required, active: false } })).status()).toBe(200);
    }
  }
});
