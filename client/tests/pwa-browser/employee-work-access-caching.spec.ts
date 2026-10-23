import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, authenticatedApi, origin, recordStaffClock } from '../browser/auth-helpers';
const message = 'Please check in to continue. Use the check-in station or ask an administrator to check you in.';

test('employee check-in access is reverified after offline reload and neither records nor work status enter PWA storage', async ({ page, browser }) => {
  test.setTimeout(75_000); await page.setViewportSize({ width: 390, height: 1000 }); const management = await browser.newContext();
  try {
    const admin = await management.newPage(), http = await authenticatedApi(admin, { freshSession: true }), suffix = randomUUID().slice(0, 8);
    const roomResponse = await http.post(api + '/rooms', { data: { name: 'Private work access room ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 15 } }); expect(roomResponse.status()).toBe(201); const room = (await roomResponse.json()).data;
    const marker = 'PRIVATE-WORK-CHILD-' + suffix;
    const created = await http.post(api + '/children', { data: { firstName: marker, lastName: 'Synthetic', dateOfBirth: '2023-01-01', roomId: room.id } }); expect(created.status()).toBe(201);
    const staffResponse = await http.post(api + '/staff', { data: { name: 'PWA employee ' + suffix, role: 'Teacher', roomId: room.id } }); expect(staffResponse.status()).toBe(201); const staff = (await staffResponse.json()).data;
    const username = 'work-pwa-' + suffix, temporary = 'Synthetic work privacy temporary 20!', password = 'Synthetic work privacy changed 20!';
    expect((await http.post(api + '/admin/accounts', { data: { username, displayName: staff.name, role: 'teacher', staffMemberId: staff.id, password: temporary } })).status()).toBe(201);
    const login = await page.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporary } }); expect(login.status()).toBe(200);
    expect((await page.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await login.json()).csrfToken }, data: { currentPassword: temporary, password } })).status()).toBe(200);
    const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session'); await page.context().addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
    await page.goto('/classroom/children'); await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(page.getByRole('navigation')).toHaveCount(0);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await recordStaffClock(http, staff.id, 'checkin');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('main')).toContainText(marker);
    const sessionResponse = await page.request.get(api + '/auth/session'); expect(sessionResponse.status()).toBe(200); expect(sessionResponse.headers()['cache-control']).toContain('no-store');
    expect((await sessionResponse.json()).account.workAccess).toEqual({ required: true, checkedIn: true, available: true });
    const storage = await page.evaluate(async () => ({ caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))), local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage.caches.length).toBeGreaterThan(0);
    for (const cache of storage.caches) { expect(cache.name).toMatch(/^skao-static-v1-/); for (const url of cache.urls) expect(new URL(url).pathname).toMatch(/^(?:\/index\.html|\/assets\/)/); }
    expect(JSON.stringify(storage)).not.toContain(marker); expect(JSON.stringify(storage)).not.toContain(staff.id); expect(JSON.stringify(storage)).not.toContain('workAccess');
    expect(Object.keys(storage.local).every(key => key === 'skao-account-changed')).toBe(true); expect(Object.keys(storage.session)).toEqual([]);
    await recordStaffClock(http, staff.id, 'checkout'); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(message, { exact: true })).toBeVisible(); expect(await page.locator('body').textContent()).not.toContain(marker);
    await page.context().setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible(); await expect(page.getByRole('navigation')).toHaveCount(0); expect(await page.locator('body').textContent()).not.toContain(marker);
    const rechecked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session' && response.status() === 200);
    await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await rechecked;
    await expect(page.getByText(message, { exact: true })).toBeVisible(); expect(await page.locator('body').textContent()).not.toContain(marker);
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(391);
  } finally { await management.close(); }
});
