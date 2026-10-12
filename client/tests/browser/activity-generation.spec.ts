import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Locator, Page } from '@playwright/test';
import type { Activity, ActivityPlan } from '../../src/api/activities';
import type { Room } from '../../src/api/rooms';
import { api, authenticatedApi } from './auth-helpers';
type Http = Awaited<ReturnType<typeof authenticatedApi>>;
const week = '2026-10-12';
async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}
async function seed(http: Http, count = 5) {
  const suffix = randomUUID().slice(0, 8);
  const room = await data<Room>(await http.post(api + '/rooms', { data: { name: 'Generation room ' + suffix, ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 } }), 201);
  // All browser files share one fixture server. Other tests can leave global
  // activities suitable for this room. Keep those as explicit Sunday routines
  // so repeat avoidance has a deterministic weekday pool without deleting,
  // reassigning or mocking the shared catalog.
  const existingCatalog = await data<Activity[]>(await http.get(api + '/activity'));
  const preserved = existingCatalog.filter(activity => !activity.roomId && (activity.ageMinMonths == null ||
    (activity.ageMinMonths <= room.ageMinMonths! && activity.ageMaxMonths! >= room.ageMaxMonths!))).map(activity => ({
    id: randomUUID(), date: '2026-10-18', startTime: '08:00', endTime: '08:20',
    activityId: activity.id, activityVersion: activity.version,
  }));
  const stock = await data<{ id: string; quantity: string }>(await http.post(api + '/inventory', { data: { name: 'Generation paper ' + suffix, category: 'Art', location: 'Class cupboard', unit: 'count', openingQuantity: '4', reorderThreshold: '0', reason: 'Synthetic stock', requestId: randomUUID() } }), 201);
  const routine = await data<Activity>(await http.post(api + '/activity', { data: { name: 'Arrival routine ' + suffix, description: 'Keep this fixed routine.', durationMinutes: 15, ageMinMonths: 24, ageMaxMonths: 60, roomId: room.id, materials: [] } }), 201);
  const activities: Activity[] = [];
  for (let index = 0; index < count; index++) activities.push(await data<Activity>(await http.post(api + '/activity', { data: { name: `Generation choice ${index + 1} ${suffix}`, description: 'Synthetic local activity.', durationMinutes: 20, ageMinMonths: 18, ageMaxMonths: 72, roomId: room.id, materials: [{ itemId: stock.id, quantity: '2', unit: 'count', reusable: false }] } }), 201));
  await data<Activity>(await http.post(api + '/activity', { data: { name: 'Unsuitable narrow age ' + suffix, description: '', durationMinutes: 20, ageMinMonths: 24, ageMaxMonths: 36, roomId: room.id, materials: [] } }), 201);
  const saved = await data<ActivityPlan>(await http.post(api + '/schedule/plan', { data: { roomId: room.id, weekStart: week, version: 0, requestId: randomUUID(), entries: [{ id: randomUUID(), date: week, startTime: '08:00', endTime: '08:15', activityId: routine.id }, ...preserved] } }));
  return { room, stock, routine, activities, saved };
}
const getPlan = (http: Http, room: Room) => http.get(`${api}/schedule/plan?roomId=${room.id}&weekStart=${week}`).then(response => data<ActivityPlan>(response));
async function open(page: Page, room: Room) {
  await page.goto('/activities');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  await page.getByLabel('Week starting Monday', { exact: true }).fill(week);
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate week', exact: true })).toBeEnabled();
}
async function preview(page: Page) {
  await page.getByRole('button', { name: 'Generate week', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate week', exact: true });
  await expect(dialog.getByRole('checkbox', { name: 'Plan Monday', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Plan Saturday', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Preview generated week', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Suggested activity 1', exact: true })).toBeVisible();
  return dialog;
}
async function fits(page: Page, dialog: Locator) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const size = await dialog.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width + 1); expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  for (const control of await dialog.locator('button:visible, select:visible, input:not([type="checkbox"]):not([type="radio"]):visible').all()) {
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.x + box!.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}
for (const width of [320, 390, 1280]) {
  test(`generate, edit, cancel, undo and explicitly save a local week at ${width}px`, async ({ page }) => {
    test.setTimeout(60000); await page.setViewportSize({ width, height: 850 });
    const http = await authenticatedApi(page); const setup = await seed(http); await open(page, setup.room);
    let dialog = await preview(page);
    await expect(dialog.getByRole('combobox', { name: /^Suggested activity \d+$/ })).toHaveCount(5);
    await expect(dialog.getByRole('region', { name: 'Change preview', exact: true }).getByRole('listitem').filter({ hasText: 'Generation paper ' })).toContainText('To get: 6'); await fits(page, dialog);
    if (width === 390) await page.screenshot({ path: test.info().outputPath('generation-mobile-preview.png') });
    expect(await getPlan(http, setup.room)).toEqual(setup.saved);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
    dialog = await preview(page); await dialog.getByRole('button', { name: 'Use generated plan', exact: true }).click(); await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Week view', exact: true }).click();
    await expect(page.getByRole('group', { name: /^(Monday|Tuesday|Wednesday|Thursday|Friday) activity \d+$/ })).toHaveCount(6);
    await page.getByRole('button', { name: 'Undo generation', exact: true }).click();
    await expect(page.getByRole('group', { name: /^(Monday|Tuesday|Wednesday|Thursday|Friday) activity \d+$/ })).toHaveCount(1);
    await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toContainText(setup.routine.name);
    dialog = await preview(page); await dialog.getByLabel('Suggested start 1', { exact: true }).fill('09:10'); await dialog.getByLabel('Suggested end 1', { exact: true }).fill('09:30');
    await expect(dialog.getByRole('button', { name: 'Use generated plan', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Use generated plan', exact: true }).click(); await expect(dialog).toBeHidden();
    expect(await getPlan(http, setup.room)).toEqual(setup.saved);
    const result = page.waitForResponse(res => res.url() === api + '/schedule/plan' && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save week', exact: true }).click(); expect((await result).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
    const saved = await getPlan(http, setup.room); expect(saved.version).toBe(2); expect(saved.entries).toHaveLength(setup.saved.entries.length + 5);
    for (const original of setup.saved.entries) expect(saved.entries.find(e => e.id === original.id)).toEqual(original);
    expect(new Set(saved.entries.map(e => e.activityId)).size).toBe(saved.entries.length); expect(new Set(saved.entries.map(e => e.id)).size).toBe(saved.entries.length);
    const generated = saved.entries.filter(e => !setup.saved.entries.some(original => original.id === e.id));
    expect(new Set(generated.map(e => e.activityId))).toEqual(new Set(setup.activities.map(activity => activity.id)));
    expect(saved.entries.find(e => e.date === week && e.activityId !== setup.routine.id)).toMatchObject({ startTime: '09:10', endTime: '09:30' });
    await page.getByRole('button', { name: 'Reload week', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Monday activity 2', exact: true })).toContainText('09:10–09:30');
    expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + setup.stock.id))).quantity).toBe('4');
    expect((await (await http.get(api + '/inventory/' + setup.stock.id + '/movements')).json()).total).toBe(1);
  });
}

test('retry only missing slots, preserve an edited suggestion and keep the draft on generation failure', async ({ page }) => {
  test.setTimeout(60000); await page.setViewportSize({ width: 390, height: 850 });
  const http = await authenticatedApi(page); const setup = await seed(http, 1); await open(page, setup.room);
  const dialog = await preview(page);
  await expect(dialog.getByRole('combobox', { name: /^Suggested activity \d+$/ })).toHaveCount(1);
  await expect(dialog.getByRole('checkbox', { name: /^Retry / })).toHaveCount(4);
  await dialog.getByLabel('Suggested start 1', { exact: true }).fill('09:10');
  await dialog.getByLabel('Suggested end 1', { exact: true }).fill('09:30');
  await dialog.getByRole('checkbox', { name: 'Allow repeated activities when needed', exact: true }).check();
  await page.route('**/api/schedule/plan/generate', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic generation outage' } }) }));
  await dialog.getByRole('button', { name: 'Regenerate selected slots', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: 'Synthetic generation outage' })).toBeVisible();
  await expect(dialog.getByLabel('Suggested start 1', { exact: true })).toHaveValue('09:10');
  expect(await getPlan(http, setup.room)).toEqual(setup.saved);
  await page.unroute('**/api/schedule/plan/generate');
  await dialog.getByRole('button', { name: 'Regenerate selected slots', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: /^Suggested activity \d+$/ })).toHaveCount(5);
  await expect(dialog.getByRole('checkbox', { name: /^Retry / })).toHaveCount(0);
  await expect(dialog.getByLabel('Suggested start 1', { exact: true })).toHaveValue('09:10');
  await expect(dialog.getByLabel('Suggested end 1', { exact: true })).toHaveValue('09:30');
  await fits(page, dialog);
  await expect(dialog.getByRole('button', { name: 'Use generated plan', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Use generated plan', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).click();
  const leaving = page.getByRole('dialog', { name: 'Leave your unsaved work?' });
  await expect(leaving).toBeVisible();
  await leaving.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Monday activity 2', exact: true })).toContainText('09:10–09:30');
  expect(await getPlan(http, setup.room)).toEqual(setup.saved);
});

test('a stale week blocks generation without replacing the open draft', async ({ page }) => {
  const http = await authenticatedApi(page); const setup = await seed(http); await open(page, setup.room);
  await page.getByRole('button', { name: 'Generate week', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate week', exact: true });
  const changed = await data<ActivityPlan>(await http.post(api + '/schedule/plan', { data: { roomId: setup.room.id, weekStart: week, version: 1, requestId: randomUUID(), entries: setup.saved.entries.map(({ id, date, startTime, endTime, activityId }) => ({ id, date, startTime, endTime, activityId })) } }));
  await dialog.getByRole('button', { name: 'Preview generated week', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: /week changed elsewhere/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Use generated plan', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toContainText(setup.routine.name);
  expect(await getPlan(http, setup.room)).toEqual(changed);
});
