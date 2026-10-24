import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, authenticatedApi, origin, adminPassword, recordStaffClock } from './auth-helpers';

for (const width of [320, 1280]) test(`a paired public PIN station records arrivals and departures without exposing the signed-in app at ${width}px`, async ({ page, browser }) => {
  test.setTimeout(90_000); await page.setViewportSize({ width, height: 1000 });
  // Install before navigation so the station's privacy timers are controllable.
  // Server timestamps, credential expiry and actual HTTP requests remain real.
  await page.clock.install({ time: Date.now() - 60_000 });
  await page.clock.pauseAt(Date.now());
  const managementContext = await browser.newContext();
  try {
    const management = await managementContext.newPage(); const http = await authenticatedApi(management, { freshSession: true });
    const suffix = randomUUID().slice(0, 8), name = 'Station employee ' + suffix, stationName = 'Reception ' + suffix, pin = width === 320 ? '042681' : '042682';
    const created = await http.post(api + '/staff', { data: { name, role: 'Other' } }); expect(created.status()).toBe(201); const employee = (await created.json()).data;
    expect((await http.post(api + '/clock-stations/staff/' + employee.id + '/pin', { data: { pin } })).status()).toBe(200);
    const pairing = await http.post(api + '/clock-stations/pairing', { data: { name: stationName } }); expect(pairing.status()).toBe(200); const code = (await pairing.json()).data.code;
    // A previously signed-in manager must not leak into the public station or remain signed in after pairing.
    await authenticatedApi(page, { freshSession: true });
    const peer = await page.context().newPage(); await peer.goto('/dashboard');
    await expect(peer.getByRole('heading', { name: 'Hello, team', exact: true })).toBeVisible();
    await page.bringToFront();
    const privateRequests: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !new URL(request.url()).pathname.startsWith('/api/station-clock/')) privateRequests.push(new URL(request.url()).pathname); });
    await page.goto('/time-clock');
    await expect(page.getByRole('heading', { name: 'Pair this clock station', exact: true })).toBeVisible();
    expect(privateRequests).toEqual([]); await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0); await expect(page.getByRole('navigation')).toHaveCount(0);
    await page.getByLabel('Pairing code', { exact: true }).fill(code); await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Enter your PIN', exact: true })).toBeVisible();
    // Pairing immediately clears already-open private tabs through a memory-only broadcast.
    await expect(peer).toHaveURL(/\/time-clock$/);
    await expect(peer.getByRole('heading', { name: 'Enter your PIN', exact: true })).toBeVisible();
    const cookies = await page.context().cookies(api);
    expect(cookies.some(cookie => cookie.name === 'skao_session')).toBe(false);
    expect(cookies.find(cookie => cookie.name === 'skao_clock_station')).toMatchObject({ httpOnly: true, path: '/api', sameSite: 'Strict' });
    expect((await page.request.get(api + '/staff')).status()).toBe(403);
    const login = await page.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username: 'browser-admin', password: adminPassword } });
    expect(login.status()).toBe(403); expect((await login.json()).error.code).toBe('STATION_MODE');
    // Returning through an installed app's normal start URL goes straight back to the public clock.
    await page.goto('/dashboard'); await expect(page).toHaveURL(/\/time-clock$/); await expect(page.getByRole('heading', { name: 'Enter your PIN', exact: true })).toBeVisible();
    const publicBefore = privateRequests.length;
    await page.getByLabel('6-digit staff PIN', { exact: true }).fill('999999'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('PIN not recognized. Try again.'); await expect(page.getByLabel('6-digit staff PIN', { exact: true })).toHaveValue('');
    // A slow runner must not consume the four-second confirmation while it is
    // waiting for the clock response or before it can inspect the saved result.
    async function clock(action: 'checkin' | 'checkout') {
      const saved = page.waitForResponse(response => response.url() === api + '/station-clock/clock' && response.request().method() === 'POST');
      await page.getByRole('button', { name: action === 'checkin' ? 'Check in' : 'Check out', exact: true }).click();
      const response = await saved;
      expect(response.status(), 'The station must persist ' + action + ' before showing confirmation').toBe(200);
      expect(await response.json()).toEqual({ data: { action, replayed: false } });
      await expect(page.getByRole('heading', { name: action === 'checkin' ? 'You’re checked in' : 'You’re checked out', exact: true })).toBeVisible();
    }
    await page.getByLabel('6-digit staff PIN', { exact: true }).fill(pin); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Check out', exact: true })).toHaveCount(0);
    await clock('checkin');
    await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
    await page.getByLabel('6-digit staff PIN', { exact: true }).fill(pin); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check out', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);
    await clock('checkout');
    await page.clock.runFor(3999);
    await expect(page.getByRole('heading', { name: 'You’re checked out', exact: true })).toBeVisible();
    await expect(page.getByText('Thank you, ' + name + '!', { exact: true })).toBeVisible();
    await page.clock.runFor(1);
    await expect(page.getByRole('heading', { name: 'Enter your PIN', exact: true })).toBeVisible();
    await expect(page.getByLabel('6-digit staff PIN', { exact: true })).toHaveValue('');
    await expect(page.getByText('Thank you, ' + name + '!', { exact: true })).toHaveCount(0);
    expect(privateRequests.slice(publicBefore)).toEqual([]);
    expect(await page.locator('body').textContent()).not.toMatch(/hours|payroll|hourly|tax|arrived|departed/i);
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
    const ledger = (await (await http.get(api + '/payroll/staff/' + employee.id)).json()).data.ledger;
    expect(ledger.sessions).toHaveLength(1); expect(ledger.sessions[0].end).toBeTruthy(); expect(ledger.sessions[0].actorType).toBe('clock-station');
    expect(Date.parse(ledger.sessions[0].end)).toBeGreaterThan(Date.parse(ledger.sessions[0].start));
    expect(ledger.history.map((event: { type: string }) => event.type)).toEqual(['checkin', 'checkout']);
    const stations = (await (await http.get(api + '/clock-stations')).json()).data.stations; const station = stations.find((value: { name: string }) => value.name === stationName); expect(station).toBeTruthy();
    await page.screenshot({ path: test.info().outputPath('clock-station-' + width + '.png'), fullPage: true });
    expect((await http.post(api + '/clock-stations/' + station.id + '/revoke', { data: {} })).status()).toBe(200);
    await page.reload(); await expect(page.getByRole('heading', { name: 'Pair this clock station', exact: true })).toBeVisible();
    await expect(page.getByText(stationName, { exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  } finally { await managementContext.close(); }
});

test('editors can record staff arrivals while teachers cannot use either manager or personal clock APIs', async ({ page, browser }) => {
  test.setTimeout(60_000); const http = await authenticatedApi(page), suffix = randomUUID().slice(0, 8);
  const created = await http.post(api + '/staff', { data: { name: 'Manager clock ' + suffix, role: 'Other' } }); expect(created.status()).toBe(201); const person = (await created.json()).data;
  const temporary = 'Synthetic station temporary 20!', password = 'Synthetic station changed 20!';
  for (const role of ['editor', 'teacher']) expect((await http.post(api + '/admin/accounts', { data: { username: role + '-station-' + suffix, displayName: role, role, ...(role === 'teacher' ? { staffMemberId: person.id } : {}), password: temporary } })).status()).toBe(201);
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
  try {
    const other = await context.newPage();
    async function login(role: string) {
      await context.clearCookies(); const response = await other.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username: role + '-station-' + suffix, password: temporary } }); expect(response.status()).toBe(200);
      const changed = await other.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await response.json()).csrfToken }, data: { currentPassword: temporary, password } }); expect(changed.status()).toBe(200);
      return { Origin: origin, 'X-CSRF-Token': (await changed.json()).csrfToken };
    }
    await login('editor'); await other.goto('/staff/clock'); const card = other.getByRole('article', { name: person.name + ' work clock', exact: true });
    await card.getByRole('button', { name: 'Check in ' + person.name, exact: true }).click(); await expect(card.getByRole('button', { name: 'Check out ' + person.name, exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Check out ' + person.name, exact: true }).click(); await expect(card.getByRole('button', { name: 'Check in ' + person.name, exact: true })).toBeVisible();
    expect((await other.request.get(api + '/clock-stations')).status()).toBe(403); expect((await other.request.get(api + '/payroll/staff/' + person.id)).status()).toBe(403);
    await recordStaffClock(http, person.id, 'checkin');
    const headers = await login('teacher'); expect((await other.request.get(api + '/work-time/clock')).status()).toBe(403); expect((await other.request.get(api + '/time-clock')).status()).toBe(403);
    expect((await other.request.post(api + '/time-clock', { headers, data: { action: 'checkin', version: 2, requestId: randomUUID() } })).status()).toBe(403);
    expect((await other.request.post(api + '/work-time/staff/' + person.id + '/clock', { headers, data: { action: 'checkin', version: 2, requestId: randomUUID() } })).status()).toBe(403);
    await other.goto('/my-time'); await expect(other.getByRole('heading', { name: 'Staff check-in has moved', exact: true })).toBeVisible(); await expect(other.getByRole('button', { name: /check in|check out/i })).toHaveCount(0);
  } finally { await context.close(); }
});
