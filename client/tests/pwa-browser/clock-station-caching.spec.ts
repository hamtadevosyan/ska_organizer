import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from '../browser/auth-helpers';

test('clock station PINs and identities never persist offline and reconnecting cannot submit a queued clock', async ({ page, browser }) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 390, height: 1000 }); const managementContext = await browser.newContext();
  try {
    const management = await managementContext.newPage(), http = await authenticatedApi(management, { freshSession: true });
    const suffix = randomUUID().slice(0, 8), marker = 'PRIVATE-STATION-EMPLOYEE-' + suffix, pin = '037482';
    const created = await http.post(api + '/staff', { data: { name: marker, role: 'Other' } }); expect(created.status()).toBe(201); const employee = (await created.json()).data;
    expect((await http.post(api + '/clock-stations/staff/' + employee.id + '/pin', { data: { pin } })).status()).toBe(200);
    const pairing = await http.post(api + '/clock-stations/pairing', { data: { name: 'PWA station ' + suffix } }); expect(pairing.status()).toBe(200); const code = (await pairing.json()).data.code;
    const writes: string[] = []; page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/station-clock/clock')) writes.push(request.url()); });
    await page.goto('/time-clock'); await page.getByLabel('Pairing code', { exact: true }).fill(code); await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
    await page.getByLabel('6-digit staff PIN', { exact: true }).fill(pin);
    const identified = page.waitForResponse(response => response.url().endsWith('/api/station-clock/identify'));
    await page.getByRole('button', { name: 'Continue', exact: true }).click(); const identityResponse = await identified;
    expect(identityResponse.headers()['cache-control']).toContain('no-store'); await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const storage = await page.evaluate(async () => ({ caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))), local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage.caches.length).toBeGreaterThan(0);
    for (const cache of storage.caches) { expect(cache.name).toMatch(/^skao-static-v1-/); for (const url of cache.urls) expect(new URL(url).pathname).toMatch(/^(?:\/index\.html|\/assets\/)/); }
    expect(JSON.stringify(storage)).not.toContain(marker); expect(JSON.stringify(storage)).not.toContain(pin); expect(JSON.stringify(storage)).not.toContain(code);
    expect(Object.keys(storage.local)).toEqual([]); expect(Object.keys(storage.session)).toEqual([]);
    await page.context().setOffline(true); await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: marker, exact: true })).toHaveCount(0);
    const attempted = writes.length; expect(attempted).toBe(1);
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible();
    expect(await page.locator('body').textContent()).not.toContain(marker); await expect(page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);
    await page.context().setOffline(false); await page.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Enter your PIN', exact: true })).toBeVisible();
    expect(writes).toHaveLength(attempted);
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(391);
    await page.screenshot({ path: test.info().outputPath('clock-station-online.png'), fullPage: true });
    const ledger = (await (await http.get(api + '/payroll/staff/' + employee.id)).json()).data.ledger; expect(ledger.sessions).toEqual([]);
  } finally { await managementContext.close(); }
});
