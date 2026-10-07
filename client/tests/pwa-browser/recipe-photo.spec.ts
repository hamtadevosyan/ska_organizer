import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { authenticatedApi } from '../browser/auth-helpers';

test('installed shell reads a recipe locally and retains neither image nor OCR response in browser storage', async ({ page }) => {
  test.setTimeout(60000);
  await authenticatedApi(page);
  await page.goto('/meals');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
  await page.getByRole('button', { name: 'Import recipe photo' }).click();
  const result = page.waitForResponse(response => new URL(response.url()).pathname === '/api/meals/recipe-photo');
  await page.getByLabel('Recipe image file').setInputFiles(fileURLToPath(new URL('../../../server/tests/fixtures/recipe-photo.png', import.meta.url)));
  const response = await result;
  expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toBe('no-store');
  await expect(page.getByLabel('Recipe meal name')).toHaveValue('Banana oat bowls');
  await page.getByRole('button', { name: 'Cancel photo import' }).click();
  await page.getByRole('button', { name: 'Discard photo' }).click();
  const storage = await page.evaluate(async () => ({
    urls: (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat(),
    local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage),
  }));
  expect(storage.urls.length).toBeGreaterThan(1);
  expect(storage.urls.every(url => !url.includes('/api/'))).toBe(true);
  expect(storage.local + storage.session).not.toMatch(/Banana oat bowls|120 g Oats|data:image\/png/);
});
