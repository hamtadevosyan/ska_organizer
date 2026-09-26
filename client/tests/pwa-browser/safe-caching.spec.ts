import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, authenticatedApi } from '../browser/auth-helpers';

async function workerReady(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function cacheKeys(page: Page) {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('skao-static-v1-'));
    return (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat();
  });
}
function publicFilesOnly(urls: string[]) {
  expect(urls.length).toBeGreaterThan(1);
  for (const value of urls) {
    const url = new URL(value);
    expect(url.origin).toBe('http://127.0.0.1:5179');
    expect(url.search).toBe('');
    expect(url.pathname).toMatch(/^(?:\/index\.html|\/assets\/)/);
    expect(url.pathname).not.toContain('/api');
  }
}

test('a cached shell reloads offline without records, reconnects, and keeps API responses out of storage', async ({ page, context }) => {
  test.setTimeout(60000);
  const http = await authenticatedApi(page, { freshSession: true });
  const lastName = 'PrivateFixture' + Date.now();
  const created = await http.post(api + '/children', { data: { firstName: 'Synthetic', lastName, dateOfBirth: '2023-01-01', roomId: null } });
  expect(created.status()).toBe(201);
  const name = 'Synthetic ' + lastName;
  await page.goto('/children');
  await page.getByRole('searchbox', { name: 'Search children' }).fill(name);
  await expect(page.getByRole('row', { name, exact: true })).toBeVisible();
  await workerReady(page);
  publicFilesOnly(await cacheKeys(page));
  const live = await page.evaluate(async () => {
    const response = await fetch('/api/children', { credentials: 'same-origin' });
    return { status: response.status, cache: response.headers.get('Cache-Control') };
  });
  expect(live).toEqual({ status: 200, cache: 'no-store' });

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer' })).toBeVisible();
  await expect(page.getByRole('row', { name, exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  publicFilesOnly(await cacheKeys(page));

  await context.setOffline(false);
  // Exercise automatic recovery through a real session check, without racing a
  // retry button that can disappear when the browser emits its online event.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('searchbox', { name: 'Search children' }).fill(name);
  await expect(page.getByRole('row', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  publicFilesOnly(await cacheKeys(page));
});

test('an API outage warns without losing a draft, and a LAN response overrides the offline hint', async ({ page }) => {
  test.setTimeout(60000);
  await authenticatedApi(page, { freshSession: true });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => false }); });
  await page.goto('/children');
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  const input = page.getByRole('form', { name: 'Add child', exact: true }).getByLabel('First name', { exact: true });
  await input.fill('Unsaved synthetic draft');
  await workerReady(page);
  await page.route('**/api/auth/session', route => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic outage' } }) }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible();
  await expect(input).toHaveValue('Unsaved synthetic draft');
  await page.unroute('**/api/auth/session');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toHaveCount(0);
  await expect(page.getByText(/Connection restored\./)).toBeVisible();
  await expect(input).toHaveValue('Unsaved synthetic draft');
  publicFilesOnly(await cacheKeys(page));
});
