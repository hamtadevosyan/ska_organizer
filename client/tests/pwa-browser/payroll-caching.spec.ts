import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from '../browser/auth-helpers';
test('private payroll is never stored offline and disappears when its session cannot be verified', async ({ page }) => {
  test.setTimeout(60_000); const http = await authenticatedApi(page); const suffix = randomUUID().slice(0, 8); const marker = 'SYNTHETIC-PRIVATE-PAYROLL-' + suffix;
  const response = await http.post(api + '/staff', { data: { name: 'Payroll privacy ' + suffix, role: 'Other' } }); expect(response.status()).toBe(201); const person = (await response.json()).data;
  expect((await http.post(api + '/payroll/staff/' + person.id + '/profile', { data: { version: 0, reason: 'Synthetic privacy fixture', legalName: marker, taxId: 'SYNTHETIC-TAX-1234' } })).status()).toBe(200);
  await page.goto('/staff/payroll'); await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(person.id);
  await page.getByText('Employee setup & records', { exact: true }).click(); await page.getByRole('button', { name: 'Private profile', exact: true }).click();
  await expect(page.getByLabel('Legal employee name', { exact: true })).toHaveValue(marker);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const headers = (await http.get(api + '/payroll/staff/' + person.id)).headers(); expect(headers['cache-control']).toContain('no-store');
  const storage = await page.evaluate(async () => ({ caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))), local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage.caches.length).toBeGreaterThan(0);
  for (const cache of storage.caches) { expect(cache.name).toMatch(/^skao-static-v1-/); for (const url of cache.urls) expect(new URL(url).pathname).toMatch(/^(?:\/index\.html|\/assets\/)/); }
  expect(JSON.stringify(storage)).not.toContain(marker); expect(JSON.stringify(storage)).not.toContain('SYNTHETIC-TAX-1234'); expect(Object.keys(storage.local).every(key => key === 'skao-account-changed')).toBe(true); expect(Object.keys(storage.session)).toEqual([]);
  await page.context().setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible(); expect(await page.locator('body').textContent()).not.toContain(marker); await expect(page.getByLabel('Legal employee name', { exact: true })).toHaveCount(0);
});
