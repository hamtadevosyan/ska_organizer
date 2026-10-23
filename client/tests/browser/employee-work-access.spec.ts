import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { api, authenticatedApi, origin, recordStaffClock } from './auth-helpers';
const message = 'Please check in to continue. Use the check-in station or ask an administrator to check you in.';
const temporary = 'Synthetic work gate temporary 20!', password = 'Synthetic work gate changed 20!';
async function data<T>(response: APIResponse, status = 200): Promise<T> { expect(response.status(), await response.text()).toBe(status); return (await response.json()).data as T; }
async function login(page: Page, username: string) {
  const response = await page.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporary } }); expect(response.status()).toBe(200);
  const changed = await page.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await response.json()).csrfToken }, data: { currentPassword: temporary, password } }); expect(changed.status()).toBe(200);
  const session = await changed.json(); const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session'); expect(cookies).toHaveLength(1);
  await page.context().addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
  return { session, headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken } };
}
for (const width of [320, 1280]) for (const role of ['teacher', 'viewer', 'editor'] as const) test(`linked ${role} must check in before opening records and is locked again after checkout at ${width}px`, async ({ page, browser }) => {
  test.setTimeout(75_000); await page.setViewportSize({ width, height: 1000 }); const management = await browser.newContext(), stationContext = await browser.newContext();
  try {
    const admin = await management.newPage(), http = await authenticatedApi(admin); const suffix = randomUUID().slice(0, 8);
    const room = await data<{ id: string; name: string }>(await http.post(api + '/rooms', { data: { name: 'Work access class ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 15 } }), 201);
    const firstName = 'PrivateWorkChild' + suffix;
    const childResponse = await http.post(api + '/children', { data: { firstName, lastName: 'Synthetic', dateOfBirth: '2023-01-01', roomId: room.id } }); expect(childResponse.status()).toBe(201);
    const employee = await data<{ id: string; name: string }>(await http.post(api + '/staff', { data: { name: 'Work access ' + role + ' ' + suffix, role: 'Teacher', roomId: room.id } }), 201);
    const username = 'work-' + role + '-' + suffix;
    await data(await http.post(api + '/admin/accounts', { data: { username, displayName: employee.name, role, staffMemberId: employee.id, password: temporary } }), 201);
    const signedIn = await login(page, username);
    expect(signedIn.session.account.workAccess).toEqual({ required: true, checkedIn: false, available: true });
    expect(signedIn.session.account.staffMemberId).toBeNull(); expect(signedIn.session.account.roomId).toBeNull(); expect(signedIn.session.account.linkedStaff).toBeNull();
    const path = role === 'editor' ? '/children' : '/classroom/children'; const protectedApi = api + path;
    const operationalRequests: string[] = [];
    page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/') && !path.startsWith('/api/auth/')) operationalRequests.push(path); });
    await page.goto(path);
    await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(page.getByRole('navigation')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain(firstName); expect(operationalRequests).toEqual([]);
    for (const response of [await page.request.get(protectedApi), await page.request.post(api + '/menu/generate', { headers: signedIn.headers, data: {} })]) {
      expect(response.status()).toBe(403); expect((await response.json()).error.code).toBe('WORK_CHECK_IN_REQUIRED');
    }
    await expect(page.getByRole('button', { name: "I've checked in—refresh", exact: true })).toBeVisible();
    if (width === 320) await page.screenshot({ path: test.info().outputPath('off-clock-' + role + '.png'), fullPage: true });
    if (role === 'teacher' && width === 320) {
      const pin = '083271'; await data(await http.post(api + '/clock-stations/staff/' + employee.id + '/pin', { data: { pin } }));
      const pairing = await data<{ code: string }>(await http.post(api + '/clock-stations/pairing', { data: { name: 'Work access station ' + suffix } }));
      const station = await stationContext.newPage(); await station.goto('/time-clock'); await station.getByLabel('Pairing code', { exact: true }).fill(pairing.code); await station.getByRole('button', { name: 'Pair this device', exact: true }).click();
      await station.getByLabel('6-digit staff PIN', { exact: true }).fill(pin); await station.getByRole('button', { name: 'Continue', exact: true }).click(); await station.getByRole('button', { name: 'Check in', exact: true }).click();
      await expect(station.getByRole('heading', { name: 'You’re checked in', exact: true })).toBeVisible(); await expect(station.getByRole('navigation')).toHaveCount(0);
      expect((await station.request.get(api + '/children')).status()).toBe(403);
    } else await recordStaffClock(http, employee.id, 'checkin');
    // The employee never receives a personal clock button; only a manager or
    // separately paired station can supply the event that unlocks the app.
    if (role === 'teacher' && width === 320) await page.bringToFront();
    else {
      const refresh = page.getByRole('button', { name: "I've checked in—refresh", exact: true });
      if (await refresh.isVisible()) await refresh.click();
    }
    await expect(page.locator('main')).toContainText(firstName); await expect(page.getByText(message, { exact: true })).toHaveCount(0);
    expect(await page.getByRole('navigation').count()).toBeGreaterThan(0);
    expect((await page.request.get(protectedApi)).status()).toBe(200);
    expect((await page.request.post(api + '/time-clock', { headers: signedIn.headers, data: { action: 'checkout', version: 1, requestId: randomUUID() } })).status()).toBe(403);
    await recordStaffClock(http, employee.id, 'checkout');
    if (width === 320) {
      const denied = page.waitForResponse(response => new URL(response.url()).pathname.startsWith('/api/') && !new URL(response.url()).pathname.startsWith('/api/auth/') && response.request().method() === 'GET' && response.status() === 403);
      await page.getByRole('button', { name: role === 'editor' ? 'Refresh roster' : 'Refresh class', exact: true }).click(); await denied;
    } else await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(page.getByRole('navigation')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain(firstName);
    const session = await page.request.get(api + '/auth/session'); expect(session.status()).toBe(200); expect((await session.json()).account.workAccess).toEqual({ required: true, checkedIn: false, available: true });
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { await stationContext.close(); await management.close(); }
});

test('an off-clock linked administrator and an unlinked editor retain their normal access', async ({ page, browser }) => {
  test.setTimeout(60_000); const management = await browser.newContext();
  try {
    const admin = await management.newPage(), http = await authenticatedApi(admin), suffix = randomUUID().slice(0, 8);
    const person = await data<{ id: string }>(await http.post(api + '/staff', { data: { name: 'Exempt administrator ' + suffix, role: 'Other' } }), 201);
    for (const role of ['admin', 'editor'] as const) {
      const username = 'exempt-' + role + '-' + suffix;
      await data(await http.post(api + '/admin/accounts', { data: { username, displayName: username, role, ...(role === 'admin' ? { staffMemberId: person.id } : {}), password: temporary } }), 201);
      await page.context().clearCookies(); const signedIn = await login(page, username);
      expect(signedIn.session.account.workAccess).toEqual({ required: false, checkedIn: false, available: true });
      await page.goto('/staff'); await expect(page.getByRole('navigation', { name: 'Staff sections', exact: true })).toBeVisible();
      await expect(page.getByText(message, { exact: true })).toHaveCount(0); expect((await page.request.get(api + '/staff')).status()).toBe(200);
    }
  } finally { await management.close(); }
});

test('healthy check-in verification preserves an editor draft behind an opaque cover, while actual checkout clears it', async ({ page, browser }) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 390, height: 1000 }); const management = await browser.newContext();
  let release: (() => void) | undefined;
  try {
    const admin = await management.newPage(), http = await authenticatedApi(admin), suffix = randomUUID().slice(0, 8);
    const employee = await data<{ id: string }>(await http.post(api + '/staff', { data: { name: 'Draft editor ' + suffix, role: 'Other' } }), 201);
    const username = 'draft-editor-' + suffix;
    await data(await http.post(api + '/admin/accounts', { data: { username, displayName: username, role: 'editor', staffMemberId: employee.id, password: temporary } }), 201);
    await recordStaffClock(http, employee.id, 'checkin'); await login(page, username); await page.goto('/children');
    await page.getByRole('button', { name: 'Add child', exact: true }).click(); const input = page.getByLabel('First name', { exact: true });
    const draft = 'Private unsaved draft ' + suffix; await input.fill(draft);
    const writes: string[] = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/children') writes.push(request.url()); });
    let received!: () => void; const started = new Promise<void>(resolve => { received = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/auth/session', async route => {
      // Delay an ordinary, actual session response. Never manufacture a
      // checked-in decision or bypass the server's encrypted clock check.
      const response = await route.fetch(); received(); await resume; await route.fulfill({ response }).catch(() => {});
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await started;
    await expect(page.getByText('Checking your check-in…', { exact: true })).toBeVisible(); await expect(input).toBeHidden();
    expect(await input.evaluate(element => !!element.closest('[inert][aria-hidden="true"]'))).toBe(true);
    release!(); await page.unroute('**/api/auth/session');
    await expect(input).toBeVisible(); await expect(input).toHaveValue(draft); expect(writes).toEqual([]);
    await recordStaffClock(http, employee.id, 'checkout'); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(input).toHaveCount(0); expect(await page.locator('body').textContent()).not.toContain(draft); expect(writes).toEqual([]);
  } finally { release?.(); await management.close(); }
});
