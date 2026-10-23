import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { api, authenticatedApi, origin, recordStaffClock } from './auth-helpers';
const temporary = 'Synthetic linked temporary 20!';
const password = 'Synthetic linked changed 20!';
test.setTimeout(60_000);
async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status()).toBe(status); return (await response.json()).data as T;
}
async function login(page: Page, username: string, first = true) {
  const response = await page.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: first ? temporary : password } });
  expect(response.status()).toBe(200);
  if (first) expect((await page.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await response.json()).csrfToken }, data: { currentPassword: temporary, password } })).status()).toBe(200);
  const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
  await page.context().addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
}
for (const width of [320, 390]) test(`staff-linked Teacher and Class viewer have distinct real permissions at ${width}px`, async ({ page, browser }) => {
  const management = await browser.newContext(); const viewerContext = await browser.newContext();
  try {
    const admin = await management.newPage(); const http = await authenticatedApi(admin); const suffix = randomUUID().slice(0, 8);
    const own = await data<{ id: string; name: string }>(await http.post(api + '/rooms', { data: { name: 'Linked class ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 25 } }), 201);
    const next = await data<{ id: string; name: string }>(await http.post(api + '/rooms', { data: { name: 'Next class ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 25 } }), 201);
    const pupilResponse = await http.post(api + '/children', { data: { firstName: 'LinkedChild' + suffix, lastName: 'Example', dateOfBirth: '2023-01-01', roomId: own.id } });
    expect(pupilResponse.status()).toBe(201); const pupil = await pupilResponse.json() as { id: string; firstName: string };
    async function employee(name: string) {
      return data<{ id: string; name: string; version: number }>(await http.post(api + '/staff', { data: { name: name + suffix, role: 'Teacher', roomId: own.id } }), 201);
    }
    const teacherStaff = await employee('Linked Teacher '); const viewerStaff = await employee('Linked Viewer ');
    await admin.goto('/accounts');
    await admin.getByLabel('Username', { exact: true }).fill('linked-teacher-' + suffix);
    await admin.getByLabel('Display name', { exact: true }).fill(teacherStaff.name);
    await expect(admin.getByRole('option', { name: teacherStaff.name + ' · Teacher', exact: true })).toBeEnabled();
    await admin.getByRole('combobox', { name: 'Staff member', exact: true }).selectOption(teacherStaff.id, { timeout: 5000 });
    await expect(admin.getByRole('combobox', { name: 'Access', exact: true })).toHaveValue('editor');
    await admin.getByRole('combobox', { name: 'Access', exact: true }).selectOption('teacher');
    await expect(admin.getByText('Linked class: ' + own.name + '. Change it in Staff. Deactivating the employee disables sign-in.', { exact: true })).toBeVisible();
    await expect(admin.getByRole('combobox', { name: 'Assigned class', exact: true })).toHaveCount(0);
    await admin.getByLabel('Temporary password', { exact: true }).fill(temporary);
    await admin.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(admin.getByRole('status')).toContainText('Account created.');
    const viewer = await data<{ username: string }>(await http.post(api + '/admin/accounts', { data: { username: 'linked-viewer-' + suffix, displayName: viewerStaff.name, role: 'viewer', staffMemberId: viewerStaff.id, password: temporary } }), 201);
    await admin.goto('/staff');
    await admin.getByRole('button', { name: 'View details for ' + teacherStaff.name, exact: true }).click();
    await expect(admin.getByText('linked-teacher-' + suffix + ' · Teacher · Enabled', { exact: true })).toBeVisible();
    await recordStaffClock(http, teacherStaff.id, 'checkin'); await recordStaffClock(http, viewerStaff.id, 'checkin');
    await page.setViewportSize({ width, height: 900 }); await login(page, 'linked-teacher-' + suffix);
    await page.goto('/classroom/children');
    await expect(page.getByRole('heading', { name: 'Children in my class', exact: true })).toBeVisible();
    await expect(page.getByText(own.name, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check in ' + pupil.firstName, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check out ' + pupil.firstName, exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Health & emergency', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close safety card', exact: true })).toBeVisible();
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
    expect((await page.getByRole('heading', { name: 'Children in my class', exact: true }).boundingBox())!.width).toBeGreaterThan(120);
    const readOnly = await viewerContext.newPage(); await readOnly.setViewportSize({ width, height: 900 }); await login(readOnly, viewer.username);
    await readOnly.goto('/classroom/children');
    await expect(readOnly.getByRole('heading', { name: 'Children in my class', exact: true })).toBeVisible();
    await expect(readOnly.getByText(own.name, { exact: true })).toBeVisible();
    await expect(readOnly.locator('main')).toContainText(pupil.firstName);
    await expect(readOnly.getByRole('button', { name: /Health & emergency|Check in|Check out/ })).toHaveCount(0);
    expect((await readOnly.request.get(api + '/classroom/attendance')).status()).toBe(403);
    await data(await http.put(api + '/staff/' + teacherStaff.id, { data: { version: teacherStaff.version, roomId: next.id } }));
    expect((await page.request.get(api + '/auth/session')).status()).toBe(401);
    await login(page, 'linked-teacher-' + suffix, false); await page.goto('/classroom/children');
    await expect(page.getByText(next.name, { exact: true })).toBeVisible();
    await expect(page.locator('main')).not.toContainText(pupil.firstName);
  } finally { await management.close().catch(() => {}); await viewerContext.close().catch(() => {}); }
});
