import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticatedApi } from '../browser/auth-helpers';
import { childLedger, reviewedStatement, statementApi, statementData, statementFixture, statementPage } from '../browser/ccrc-statement-fixtures';

test('private CCRC originals, recognized text and unsaved review never enter offline storage or a payment queue', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 1000 });
  const http = await authenticatedApi(page), fixture = await statementFixture(http);
  const uploaded = await statementData(await http.post(statementApi, { data: {
    requestId: randomUUID(), file: { name: fixture.file.name, contentType: fixture.file.mimeType, dataBase64: fixture.file.buffer.toString('base64') },
  } }), 201);
  const review = reviewedStatement(uploaded, fixture);
  await statementData(await http.put(statementApi + '/' + uploaded.id + '/review', { data: { version: uploaded.version, requestId: randomUUID(), review } }));
  const detail = await page.request.get(statementApi + '/' + uploaded.id);
  expect(detail.headers()['cache-control']).toContain('no-store');
  const original = await page.request.get(statementApi + '/' + uploaded.id + '/content');
  expect(original.status()).toBe(200);
  expect(original.headers()['cache-control']).toContain('no-store');
  expect(await original.body()).toEqual(fixture.file.buffer);
  const marker = 'PRIVATE-CCRC-REVIEW-' + randomUUID().slice(0, 8);
  await page.goto(statementPage + '?statement=' + uploaded.id);
  await expect(page.getByRole('heading', { name: 'CCRC statements', exact: true })).toBeVisible();
  await page.getByText('Recognized text · page 1', { exact: true }).click();
  await expect(page.locator('.ccrc-source-page pre').first()).toContainText(fixture.file.reference);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original', exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe(fixture.file.name);
  await page.getByRole('textbox', { name: 'Reconciliation note', exact: true }).fill(marker);
  const stored = await page.evaluate(async () => ({
    caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))),
    local: { ...localStorage }, session: { ...sessionStorage },
    databases: typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [],
  }));
  expect(stored.caches.length).toBeGreaterThan(0);
  for (const cache of stored.caches) {
    expect(cache.name).toMatch(/^skao-static-v1-/);
    for (const url of cache.urls) expect(new URL(url).pathname).toMatch(/^(?:\/index\.html|\/assets\/)/);
  }
  expect(JSON.stringify(stored)).not.toContain(marker);
  expect(JSON.stringify(stored)).not.toContain(fixture.file.reference);
  expect(JSON.stringify(stored)).not.toContain(uploaded.id);
  expect(Object.keys(stored.local).every(key => key === 'skao-account-changed')).toBe(true);
  expect(Object.keys(stored.session)).toEqual([]);
  expect(stored.databases).toEqual([]);
  await page.context().setOffline(true);
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Review CCRC statement', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(marker);
  await expect(page.locator('body')).not.toContainText(fixture.file.reference);
  await page.context().setOffline(false);
  for (const child of fixture.children) expect((await childLedger(http, child.child.id)).payments).toEqual([]);
  const current = await statementData(await http.get(statementApi + '/' + uploaded.id));
  expect(current.status).toBe('draft'); expect(current.review.reconciliationReason).toBe(review.reconciliationReason);
});
