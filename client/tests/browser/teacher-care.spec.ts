import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';
type Http = Awaited<ReturnType<typeof authenticatedApi>>;
// This workflow creates two real sessions and completes a reviewed clinical form.
// Keep per-assertion timeouts unchanged; allow the complete workflow its own budget.
test.setTimeout(60_000);
const temporary = 'Synthetic teacher temporary 20!';
const password = 'Synthetic teacher changed 20!';
async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status()).toBe(status); return (await response.json()).data as T;
}
async function seed(http: Http) {
  const suffix = randomUUID().slice(0, 8);
  const own = await data<{ id: string; name: string }>(await http.post(api + '/rooms', { data: { name: 'Teacher class ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 25 } }), 201);
  const other = await data<{ id: string; name: string }>(await http.post(api + '/rooms', { data: { name: 'Other class ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 25 } }), 201);
  async function child(roomId: string, firstName: string) {
    const response = await http.post(api + '/children', { data: { firstName: firstName + suffix, lastName: 'Example', dateOfBirth: '2023-03-01', roomId, preferredName: '', notes: 'PRIVATE ADMIN NOTES' } });
    expect(response.status()).toBe(201); return await response.json() as { id: string; firstName: string; lastName: string };
  }
  const pupil = await child(own.id, 'OwnChild'); const foreign = await child(other.id, 'OtherChild');
  async function account(role = 'teacher', roomId: string | null = own.id) {
    const username = role + '-' + randomUUID().slice(0, 8);
    return data<{ id: string; username: string; displayName: string }>(await http.post(api + '/admin/accounts', { data: { username, displayName: 'Synthetic ' + username, role, roomId, password: temporary } }), 201);
  }
  return { own, other, pupil, foreign, account };
}
async function login(page: Page, username: string, first = true) {
  const response = await page.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: first ? temporary : password } });
  expect(response.status()).toBe(200);
  if (first) {
    const changed = await page.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await response.json()).csrfToken }, data: { currentPassword: temporary, password } });
    expect(changed.status()).toBe(200);
  }
  const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
  await page.context().addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
}
async function fits(page: Page) {
  expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual((page.viewportSize()?.width || 0) + 1);
  for (const control of await page.locator('.ska-classroom button:visible, .child-safety a:visible').all()) {
    const box = await control.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
  }
}
for (const width of [320, 1280]) test(`Teacher records class attendance and reads an admin-reviewed emergency card at ${width}px`, async ({ page, browser }) => {
  const managementContext = await browser.newContext(); const adminPage = await managementContext.newPage();
  try {
    const http = await authenticatedApi(adminPage); const saved = await seed(http);
    // Set up the actual admin form, not a synthetic health endpoint response.
    await adminPage.goto('/children');
    await adminPage.getByLabel('Search children', { exact: true }).fill(saved.pupil.firstName);
    await adminPage.getByRole('button', { name: 'View ' + saved.pupil.firstName + ' Example', exact: true }).click();
    const profile = adminPage.getByRole('region', { name: 'Child profile', exact: true });
    await profile.getByRole('button', { name: 'Health & emergency', exact: true }).click();
    await profile.getByRole('button', { name: 'Edit safety card', exact: true }).click();
    await profile.getByRole('combobox', { name: 'Allergy status', exact: true }).selectOption('recorded');
    await profile.getByLabel('Allergy details', { exact: true }).fill('Synthetic peanut allergy');
    await profile.getByLabel('Dietary restrictions', { exact: true }).fill('No peanuts');
    await profile.getByLabel('Emergency care instructions', { exact: true }).fill('Follow the current signed care plan.');
    await profile.getByRole('button', { name: 'Add emergency contact', exact: true }).click();
    await profile.getByLabel('Emergency contact 1 name', { exact: true }).fill('Synthetic Parent');
    await profile.getByLabel('Emergency contact 1 relationship', { exact: true }).fill('Parent');
    await profile.getByLabel('Emergency contact 1 phone', { exact: true }).fill('555-0101');
    await profile.getByLabel('I verified this card against current parent and medical instructions.', { exact: true }).check();
    await profile.getByRole('button', { name: 'Save reviewed safety card', exact: true }).click();
    await expect(profile.getByText('Synthetic peanut allergy', { exact: true })).toBeVisible();
    const teacher = await saved.account();
    await page.setViewportSize({ width, height: 900 }); await login(page, teacher.username);
    const requests: string[] = []; const errors: string[] = [];
    page.on('request', request => { if (request.url().startsWith(api + '/')) requests.push(new URL(request.url()).pathname); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/staff'); await expect(page).toHaveURL(/\/classroom$/);
    const actions = page.getByRole('navigation', { name: 'Class quick actions' });
    await expect(actions.getByRole('link', { name: /Take attendance/ })).toHaveAttribute('href', '/classroom/attendance');
    await expect(actions.getByRole('link', { name: /Activities/ })).toHaveAttribute('href', '/classroom/activities');
    await expect(actions.getByRole('link', { name: /Meals/ })).toHaveAttribute('href', '/classroom/meals');
    await fits(page);
    await page.screenshot({ path: test.info().outputPath('teacher-home.png'), fullPage: true });
    await actions.getByRole('link', { name: /Class children/ }).click();
    await expect(page.locator('main')).toContainText(saved.pupil.firstName);
    await expect(page.locator('main')).not.toContainText(saved.foreign.firstName);
    await page.getByRole('button', { name: 'Health & emergency', exact: true }).click();
    await expect(page.getByText('Synthetic peanut allergy', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Call Synthetic Parent', exact: true })).toHaveAttribute('href', 'tel:555-0101');
    await expect(page.getByRole('button', { name: 'Edit safety card', exact: true })).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('PRIVATE ADMIN NOTES'); await fits(page);
    await page.getByRole('button', { name: 'Close safety card', exact: true }).click();
    const nav = page.getByRole('navigation', { name: width === 320 ? 'Mobile navigation' : 'Desktop navigation' });
    await nav.getByRole('link', { name: width === 320 ? 'Attendance' : 'Class attendance', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Class attendance', exact: true })).toBeVisible();
    await expect(page.getByText(/signature is handled separately/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check out ' + saved.pupil.firstName, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Check in ' + saved.pupil.firstName, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check out ' + saved.pupil.firstName, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Check in ' + saved.pupil.firstName, exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Currently checked in', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check out ' + saved.pupil.firstName, exact: true }).click();
    await expect(page.getByText('Not currently checked in', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check out ' + saved.pupil.firstName, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check in ' + saved.pupil.firstName, exact: true })).toBeEnabled(); await fits(page);
    expect((await page.request.get(api + '/classroom/children/' + saved.foreign.id + '/safety')).status()).toBe(404);
    for (const path of ['/children', '/staff', '/attendance/daily', '/inventory', '/menu/generate']) expect((await page.request.get(api + path)).status()).toBe(403);
    expect(requests.filter(path => !path.startsWith('/api/classroom') && !path.startsWith('/api/auth/'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await managementContext.close(); }
});
test('Class viewer stays restricted, and changing a Teacher assignment clears the old clinical view', async ({ page, browser }) => {
  const managementContext = await browser.newContext(); const viewerContext = await browser.newContext();
  try {
    const adminPage = await managementContext.newPage(); const http = await authenticatedApi(adminPage); const saved = await seed(http);
    const teacher = await saved.account(); const viewer = await saved.account('viewer');
    const viewerPage = await viewerContext.newPage(); await login(viewerPage, viewer.username);
    await viewerPage.goto('/classroom/children'); await expect(viewerPage.locator('main')).toContainText(saved.pupil.firstName);
    await expect(viewerPage.getByRole('button', { name: 'Health & emergency', exact: true })).toHaveCount(0);
    expect((await viewerPage.request.get(api + '/classroom/attendance')).status()).toBe(403);
    expect((await viewerPage.request.get(api + '/classroom/children/' + saved.pupil.id + '/safety')).status()).toBe(403);
    await login(page, teacher.username); await page.goto('/classroom/children');
    await page.getByRole('button', { name: 'Health & emergency', exact: true }).click();
    await expect(page.getByText('Allergy information unknown', { exact: true })).toBeVisible();
    await data(await http.put(api + '/admin/accounts/' + teacher.id, { data: { displayName: teacher.displayName, role: 'teacher', disabled: false, roomId: saved.other.id } }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(saved.pupil.firstName);
    await login(page, teacher.username, false); await page.goto('/classroom/children');
    await expect(page.locator('main')).toContainText(saved.foreign.firstName); await expect(page.locator('main')).not.toContainText(saved.pupil.firstName);
  } finally { await viewerContext.close(); await managementContext.close(); }
});
