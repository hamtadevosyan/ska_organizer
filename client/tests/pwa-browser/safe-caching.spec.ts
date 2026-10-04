import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
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

test('an API outage warns without losing a draft, and a LAN response overrides the offline hint', async ({ page, context }) => {
  test.setTimeout(60000);
  await authenticatedApi(page, { freshSession: true });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => false }); });
  let outage = false;
  const sessionRoute = async (route: Route) => {
    if (!outage) { await route.continue(); return; }
    await route.fulfill({ status: 503, headers: { 'Cache-Control': 'no-store' },
      contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic outage' } }) });
  };
  // Register at context level before navigation/worker activation, so the fixture
  // also covers requests associated with a service-worker-controlled page.
  await context.route('**/api/auth/session', sessionRoute);
  try {
    await page.goto('/children');
    await page.getByRole('button', { name: 'Add child', exact: true }).click();
    const input = page.getByRole('form', { name: 'Add child', exact: true }).getByLabel('First name', { exact: true });
    await input.fill('Unsaved synthetic draft');
    await workerReady(page);
    outage = true;
    // Prove the focused session check received the outage. A missing mock must
    // fail here rather than masquerade as a missing connection banner.
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session' && response.status() === 503),
      page.evaluate(() => window.dispatchEvent(new Event('focus'))),
    ]);
    await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible();
    await expect(input).toHaveValue('Unsaved synthetic draft');
    outage = false;
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session' && response.status() === 200),
      page.getByRole('button', { name: 'Try again', exact: true }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toHaveCount(0);
    await expect(page.getByText(/Connection restored\./)).toBeVisible();
    await expect(input).toHaveValue('Unsaved synthetic draft');
    publicFilesOnly(await cacheKeys(page));
  } finally { await context.unroute('**/api/auth/session', sessionRoute); }
});
