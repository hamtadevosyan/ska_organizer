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

test('reviewed pay-rate hours and calculated gross pay are cleared on offline reload without caching private responses', async ({ page }) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 390, height: 1000 });
  const http = await authenticatedApi(page), suffix = randomUUID().slice(0, 8), marker = 'PRIVATE-RATE-REVIEW-' + suffix;
  const created = await http.post(api + '/staff', { data: { name: marker, role: 'Other' } }); expect(created.status()).toBe(201); const employee = (await created.json()).data;
  const base = api + '/payroll/staff/' + employee.id;
  expect((await http.post(api + '/work-time/staff/' + employee.id + '/clock', { data: { action: 'checkin', version: 0, requestId: randomUUID() } })).status()).toBe(200);
  expect((await http.post(api + '/work-time/staff/' + employee.id + '/clock', { data: { action: 'checkout', version: 1, requestId: randomUUID() } })).status()).toBe(200);
  let detail = (await (await http.get(base)).json()).data;
  expect((await http.post(base + '/corrections', { data: { version: detail.ledger.version, sessionId: detail.ledger.sessions[0].id, start: '2026-09-24T15:00:00Z', end: '2026-09-24T20:00:00Z', voided: false, reason: 'Verified five actual historical hours for private rate review' } })).status()).toBe(200);
  expect((await http.post(base + '/rates', { data: { version: detail.profile.version, effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic effective rate for privacy fixture' } })).status()).toBe(200);
  detail = (await (await http.get(base)).json()).data;
  expect((await http.post(base + '/profile', { data: { version: detail.profile.version, rules: { ...detail.profile.rules, confirmed: true, reference: 'Synthetic reviewer confirmed applicable payroll rules' }, reason: 'Synthetic payroll policy review' } })).status()).toBe(200);
  detail = (await (await http.get(base)).json()).data;
  expect((await http.post(base + '/approvals', { data: { version: detail.ledger.version, profileVersion: detail.profile.version, date: '2026-09-24', status: 'approved', mode: 'manual-reviewed', paidMillis: 18_000_000, rateMillis: 3_600_000, multiplierHundredths: 150, adjustmentCents: 0, rulesReviewed: true, overtimeReviewed: true, reason: marker + ' administrator explicitly chose one hour at time and a half' } })).status()).toBe(200);
  await page.goto('/staff/payroll'); await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(employee.id);
  await page.getByLabel('Pay period start', { exact: true }).fill('2026-09-24'); await page.getByLabel('Pay period end', { exact: true }).fill('2026-09-24');
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/payroll/staff/' + employee.id + '/preview'));
  await page.getByRole('button', { name: 'Calculate pay', exact: true }).click(); const response = await previewResponse; expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
  await expect(page.getByRole('heading', { name: 'Gross pay before taxes: $110.00', exact: true })).toBeVisible();
  const result = page.getByRole('region', { name: 'Pay calculation result', exact: true }); await expect(result).toContainText('1 hr at $30.00 per hour (1.5×)'); await expect(result).toContainText('4 hr at $20.00 per hour (1×)');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const storage = await page.evaluate(async () => ({ caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))), local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage.caches.length).toBeGreaterThan(0);
  for (const cache of storage.caches) { expect(cache.name).toMatch(/^skao-static-v1-/); for (const url of cache.urls) expect(new URL(url).pathname).toMatch(/^(?:\/index\.html|\/assets\/)/); }
  expect(JSON.stringify(storage)).not.toContain(marker); expect(JSON.stringify(storage)).not.toContain(employee.id);
  expect(Object.keys(storage.local).every(key => key === 'skao-account-changed')).toBe(true); expect(Object.keys(storage.session)).toEqual([]);
  await page.context().setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Pay calculation result', exact: true })).toHaveCount(0); expect(await page.locator('body').textContent()).not.toContain(marker); expect(await page.locator('body').textContent()).not.toContain('$110.00');
});
