import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Browser, BrowserContext, Page } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type RecordId = { id: string; name: string; version: number };
const temporaryPassword = 'Synthetic temporary classroom 20!';
const password = 'Synthetic changed classroom 20!';

async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}
async function admin(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, http: await authenticatedApi(page) };
}
async function room(http: Http, name: string) {
  return data<RecordId>(await http.post(api + '/rooms', { data: { name, ageMinMonths: 0, ageMaxMonths: 120, capacity: 25 } }), 201);
}
async function child(http: Http, assigned: RecordId, firstName: string) {
  const response = await http.post(api + '/children', { data: { firstName, lastName: 'Classroom', dateOfBirth: '2023-03-01',
    roomId: assigned.id, preferredName: '', notes: 'Private medical and family note' } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as { id: string; firstName: string; lastName: string };
}
async function viewer(http: Http, roomId: string | null) {
  const username = 'class-' + randomUUID().slice(0, 8);
  return data<{ id: string; username: string; displayName: string }>(await http.post(api + '/admin/accounts', { data: {
    username, displayName: 'Class viewer ' + username, password: temporaryPassword, role: 'viewer', roomId,
  } }), 201);
}
async function login(page: Page, username: string, first = true) {
  const response = await page.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: first ? temporaryPassword : password } });
  expect(response.status()).toBe(200);
  if (first) {
    const changed = await page.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await response.json()).csrfToken },
      data: { currentPassword: temporaryPassword, password } });
    expect(changed.status()).toBe(200);
  }
  // Layout workflows use session cookies; dedicated remembered-login tests verify real Expires.
  const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
  expect(cookies).toHaveLength(1);
  await page.context().addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
}
async function fits(page: Page) {
  const size = await page.locator('main').evaluate(element => ({ width: element.scrollWidth, available: window.innerWidth }));
  expect(size.width).toBeLessThanOrEqual(size.available + 1);
  for (const control of await page.locator('.ska-classroom button:visible').all()) {
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  }
}
async function seed(http: Http, week: string) {
  const suffix = randomUUID().slice(0, 8);
  const own = await room(http, 'Own class ' + suffix), other = await room(http, 'Other class ' + suffix);
  const ownChild = await child(http, own, 'OwnChild' + suffix), otherChild = await child(http, other, 'OtherChild' + suffix);
  const inactive = await child(http, own, 'InactiveChild' + suffix);
  expect((await http.put(api + '/children/' + inactive.id + '/enrollment', { data: { active: false } })).status()).toBe(200);
  const activities = [];
  for (const assigned of [own, other]) {
    const activity = await data<RecordId>(await http.post(api + '/activity', { data: {
      name: (assigned === own ? 'Own activity ' : 'Other activity ') + suffix, description: 'Saved class instructions', durationMinutes: 20,
    } }), 201);
    await data(await http.post(api + '/schedule/plan', { data: { roomId: assigned.id, weekStart: week, version: 0, requestId: randomUUID(),
      entries: [{ id: randomUUID(), date: week, startTime: '09:00', endTime: '09:20', activityId: activity.id }] } }));
    activities.push(activity);
  }
  const ingredient = await data<RecordId>(await http.post(api + '/ingredients', { data: { name: 'Private ingredient ' + suffix, unit: 'count' } }), 201);
  const meal = await data<RecordId>(await http.post(api + '/meals', { data: { name: 'Shared breakfast ' + suffix, type: 'breakfast' } }), 201);
  expect((await http.post(api + '/meals/' + meal.id + '/ingredients', { data: { ingredientId: ingredient.id, quantity: 1 } })).status()).toBe(201);
  const preview = await data<{ previewToken: string }>(await http.post(api + '/menu/plans/' + week + '/preview', { data: {
    version: 0, childrenCount: 1, staffCount: 0, week: [{ day: 'Monday', menu: { breakfast: { id: meal.id } } }],
  } }));
  await data(await http.put(api + '/menu/plans/' + week, { data: { previewToken: preview.previewToken } }));
  return { own, other, ownChild, otherChild, inactive, activities, meal, ingredient };
}

for (const width of [320, 1280]) test(`Class viewer sees only assigned children and saved plans at ${width}px`, async ({ page, browser }) => {
  await page.setViewportSize({ width, height: 900 });
  const management = await admin(browser);
  try {
    const week = width === 320 ? '2030-01-07' : '2030-01-14';
    const saved = await seed(management.http, week);
    const account = await viewer(management.http, saved.own.id);
    await login(page, account.username);
    const requests: string[] = [], errors: string[] = [];
    page.on('request', request => { if (request.url().startsWith(api + '/')) requests.push(new URL(request.url()).pathname); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/staff');
    await expect(page).toHaveURL(/\/classroom$/);
    await expect(page.getByRole('heading', { name: saved.own.name, exact: true })).toBeVisible();
    await fits(page);
    const nav = page.getByRole('navigation', { name: width === 320 ? 'Mobile navigation' : 'Desktop navigation' });
    expect(await nav.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual([
      '/classroom', '/classroom/children', '/classroom/activities', '/classroom/meals',
    ]);
    await nav.getByRole('link', { name: 'Children', exact: true }).click();
    const main = page.locator('main');
    await expect(main).toContainText(saved.ownChild.firstName);
    await expect(main).not.toContainText('OtherChild'); await expect(main).not.toContainText('InactiveChild');
    await expect(main).not.toContainText('Private medical'); await expect(main).not.toContainText('2023-03-01');
    await fits(page);
    const childrenResponse = await page.request.get(api + '/classroom/children');
    const children = await data<{ items: Record<string, unknown>[] }>(childrenResponse);
    expect(children.items).toHaveLength(1);
    expect(Object.keys(children.items[0]).sort()).toEqual(['firstName', 'id', 'lastName', 'preferredName']);
    await nav.getByRole('link', { name: 'Activities', exact: true }).click();
    await page.getByLabel('Week starting', { exact: true }).fill(week);
    await expect(main.getByRole('heading', { name: saved.activities[0].name, exact: true })).toBeVisible();
    await expect(main).not.toContainText(saved.activities[1].name); await fits(page);
    await nav.getByRole('link', { name: 'Meals', exact: true }).click();
    await page.getByLabel('Week starting', { exact: true }).fill(week);
    await expect(main.getByText(saved.meal.name, { exact: true })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Shared academy menu for your class', exact: true })).toBeVisible();
    await expect(main).not.toContainText(saved.ingredient.name); await fits(page);
    for (const name of ['Generate Menu', 'Save Menu', 'Meal Setup', 'Add child', 'Add activity']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    for (const path of ['/children', '/activities', '/meals', '/inventory', '/purchasing', '/accounts']) {
      await page.goto(path); await expect(page).toHaveURL(/\/classroom$/);
      await expect(page.getByRole('heading', { name: saved.own.name, exact: true })).toBeVisible();
    }
    expect(requests.filter(path => !path.startsWith('/api/auth/') && !path.startsWith('/api/classroom') && !['/api/health', '/api/ready'].includes(path))).toEqual([]);
    for (const path of ['/children', '/rooms', '/staff', '/menu/generate', '/schedule/plan?roomId=' + saved.other.id + '&weekStart=' + week]) {
      expect((await page.request.get(api + path)).status(), path).toBe(403);
    }
    expect((await page.request.head(api + '/classroom/children')).status()).toBe(200);
    expect((await page.request.get(api + '/classroom/children?roomId=' + saved.other.id)).status()).toBe(400);
    const forged = await data<{ room: { id: string } }>(await page.request.get(api + '/classroom/children', { headers: { 'X-Room-Id': saved.other.id } }));
    expect(forged.room.id).toBe(saved.own.id);
    expect(errors).toEqual([]);
  } finally { await management.context.close(); }
});

test('reassignment revokes the old class session and a late response cannot restore it', async ({ page, browser }) => {
  const management = await admin(browser);
  try {
    const suffix = randomUUID().slice(0, 8);
    const own = await room(management.http, 'Original class ' + suffix), other = await room(management.http, 'New class ' + suffix);
    await child(management.http, own, 'OriginalChild' + suffix); await child(management.http, other, 'NewChild' + suffix);
    const account = await viewer(management.http, own.id);
    await login(page, account.username); await page.goto('/classroom/children');
    await expect(page.locator('main')).toContainText('OriginalChild' + suffix);
    let release!: () => void, received!: () => void;
    const held = new Promise<void>(resolve => { received = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/classroom/children', async route => {
      const response = await route.fetch(); received(); await resume;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole('button', { name: 'Refresh class', exact: true }).click(); await held;
    await data(await management.http.put(api + '/admin/accounts/' + account.id, { data: {
      displayName: account.displayName, role: 'viewer', disabled: false, roomId: other.id,
    } }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    release(); await page.unroute('**/api/classroom/children');
    await expect(page.locator('body')).not.toContainText('OriginalChild' + suffix);
    await login(page, account.username, false); await page.goto('/classroom/children');
    await expect(page.locator('main')).toContainText('NewChild' + suffix);
    await expect(page.locator('main')).not.toContainText('OriginalChild' + suffix);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('dialog', { name: 'More', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await page.goBack(); await expect(page.locator('body')).not.toContainText('NewChild' + suffix);
  } finally { await management.context.close(); }
});

test('unassigned and archived classes show no records or global fallback', async ({ page, browser }) => {
  const management = await admin(browser);
  let archivedContext: BrowserContext | undefined;
  try {
    const unassigned = await viewer(management.http, null);
    await login(page, unassigned.username); await page.goto('/classroom/children');
    await expect(page.getByRole('heading', { name: 'No class assigned yet', exact: true })).toBeVisible();
    expect(await data(await page.request.get(api + '/classroom/children'))).toMatchObject({ state: 'unassigned', room: null, items: [], total: 0 });
    const assigned = await room(management.http, 'Archived class ' + randomUUID().slice(0, 8));
    await child(management.http, assigned, 'ArchivedPrivateChild');
    const account = await viewer(management.http, assigned.id);
    archivedContext = await browser.newContext(); const archivedPage = await archivedContext.newPage();
    await login(archivedPage, account.username);
    await data(await management.http.put(api + '/rooms/' + assigned.id, { data: {
      name: assigned.name, ageMinMonths: 0, ageMaxMonths: 120, capacity: 25, active: false,
    } }));
    await archivedPage.goto('/classroom/children');
    await expect(archivedPage.getByRole('heading', { name: 'Class currently unavailable', exact: true })).toBeVisible();
    await expect(archivedPage.locator('body')).not.toContainText('ArchivedPrivateChild');
    expect(await data(await archivedPage.request.get(api + '/classroom/children'))).toMatchObject({ state: 'unavailable', room: null, items: [], total: 0 });
    expect((await archivedPage.request.get(api + '/children')).status()).toBe(403);
  } finally { await archivedContext?.close(); await management.context.close(); }
});
