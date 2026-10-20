import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, authenticatedApi, origin } from '../browser/auth-helpers';

test('reviewed clinical cards stay out of PWA storage and disappear on offline reload and sign-out', async ({ page, browser }) => {
  test.setTimeout(60000);
  const management = await browser.newContext();
  try {
    const adminPage = await management.newPage(); const http = await authenticatedApi(adminPage, { freshSession: true });
    const suffix = randomUUID().slice(0, 8);
    const roomResponse = await http.post(api + '/rooms', { data: { name: 'Safety class ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 20 } });
    expect(roomResponse.status()).toBe(201); const room = (await roomResponse.json()).data;
    const childResponse = await http.post(api + '/children', { data: { firstName: 'SafetyChild' + suffix, lastName: 'Synthetic', dateOfBirth: '2023-01-01', roomId: room.id } });
    expect(childResponse.status()).toBe(201); const child = await childResponse.json();
    const clinical = 'SYNTHETIC-CLINICAL-' + suffix;
    const saved = await http.put(api + '/children/' + child.id + '/safety', { data: { version: 0, reviewed: true,
      allergyStatus: 'recorded', allergies: clinical, dietaryRestrictions: '', medicalAlerts: '', careInstructions: '', medicationInstructions: '',
      medicationLocation: '', physicianName: '', physicianPhone: '', pickupRestrictions: '', emergencyContacts: [], authorizedPickup: [], treatmentConsent: 'unknown' } });
    expect(saved.status()).toBe(200);
    const username = 'safe-teacher-' + suffix; const temporary = 'Synthetic safety temporary 20!'; const password = 'Synthetic safety changed 20!';
    expect((await http.post(api + '/admin/accounts', { data: { username, displayName: 'Safety teacher', role: 'teacher', roomId: room.id, password: temporary } })).status()).toBe(201);
    const login = await page.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporary } });
    expect(login.status()).toBe(200);
    const changed = await page.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await login.json()).csrfToken }, data: { currentPassword: temporary, password } });
    expect(changed.status()).toBe(200);
    const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
    await page.context().addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
    const external: string[] = [];
    page.on('request', request => { const url = new URL(request.url()); if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) external.push(url.origin); });
    await page.goto('/classroom/children');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/children/' + child.id + '/safety'));
    await page.getByRole('button', { name: 'Health & emergency', exact: true }).click();
    expect((await response).headers()['cache-control']).toContain('no-store');
    await expect(page.getByText(clinical, { exact: true })).toBeVisible();
    const storage = await page.evaluate(async () => ({
      caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))),
      local: { ...localStorage }, session: { ...sessionStorage },
    }));
    expect(storage.caches.length).toBeGreaterThan(0);
    for (const cache of storage.caches) {
      expect(cache.name).toMatch(/^skao-static-v1-/);
      for (const value of cache.urls) expect(new URL(value).pathname).toMatch(/^(?:\/index\.html|\/assets\/)/);
    }
    expect(JSON.stringify(storage)).not.toContain(clinical);
    expect(Object.keys(storage.local).every(key => key === 'skao-account-changed')).toBe(true);
    expect(Object.keys(storage.session)).toEqual([]); expect(external).toEqual([]);
    await page.context().setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'We can’t reach the academy computer', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(clinical);
    await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('button', { name: 'Health & emergency', exact: true }).click();
    await expect(page.getByText(clinical, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(clinical);
    expect((await page.request.get(api + '/classroom/children/' + child.id + '/safety')).status()).toBe(401);
  } finally { await management.close(); }
});
