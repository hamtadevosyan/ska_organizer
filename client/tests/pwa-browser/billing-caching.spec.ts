import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from '../browser/auth-helpers';
import { ccrcBillingChild, billingData } from '../browser/billing-fixtures';
import type { BillingDetail } from '../browser/billing-fixtures';

test('tuition balances, payment references and drafts never enter offline storage', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 1000 });
  const http = await authenticatedApi(page);
  const fixture = await ccrcBillingChild(http);
  const marker = 'PRIVATE-TUITION-REFERENCE-' + randomUUID().slice(0, 8);
  const monthly = fixture.detail.charges.find(charge => charge.kind === 'monthly')!;
  expect(monthly).toBeTruthy();
  const paid = await billingData<BillingDetail>(await http.post(fixture.path + '/payments', { data: {
    version: fixture.detail.version, requestId: randomUUID(), payer: 'ccrc', amountCents: 1234,
    date: fixture.detail.today, method: 'ccrc', reference: marker, chargeId: monthly.id,
  } }));
  expect(paid.payments).toHaveLength(1);
  const privateResponse = await http.get(fixture.path);
  expect(privateResponse.headers()['cache-control']).toContain('no-store');

  await page.goto('/billing?child=' + fixture.child.id);
  await expect(page.getByRole('heading', { name: 'Tuition & payments', exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText(marker);
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  const payment = page.getByRole('form', { name: 'Record payment', exact: true });
  await payment.getByLabel('Reference (optional)', { exact: true }).fill('UNSAVED-' + marker);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  const storage = await page.evaluate(async () => ({
    caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))),
    local: { ...localStorage }, session: { ...sessionStorage },
  }));
  expect(storage.caches.length).toBeGreaterThan(0);
  for (const cache of storage.caches) {
    expect(cache.name).toMatch(/^skao-static-v1-/);
    for (const url of cache.urls) expect(new URL(url).pathname).toMatch(/^(?:\/index\.html|\/assets\/)/);
  }
  expect(JSON.stringify(storage)).not.toContain(marker);
  expect(JSON.stringify(storage)).not.toContain(fixture.child.id);
  expect(Object.keys(storage.local).every(key => key === 'skao-account-changed')).toBe(true);
  expect(Object.keys(storage.session)).toEqual([]);
  await page.context().setOffline(true);
  // Accept only this test's own unsaved-draft prompt while reloading.
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(marker);
  await expect(page.getByRole('heading', { name: 'Tuition & payments', exact: true })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Record payment', exact: true })).toHaveCount(0);
  await page.context().setOffline(false);
  expect((await billingData<BillingDetail>(await http.get(fixture.path))).payments).toHaveLength(1);
  expect((await page.request.get(api + '/billing/alerts')).headers()['cache-control']).toContain('no-store');
});
