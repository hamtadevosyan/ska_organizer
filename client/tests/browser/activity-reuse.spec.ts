import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Locator, Page } from '@playwright/test';
import type { Activity, ActivityPlan, Entry } from '../../src/api/activities';
import type { Room } from '../../src/api/rooms';
import { api, authenticatedApi } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
const sourceWeek = '2026-09-28';
const destinationWeek = '2026-10-05';
const dateAt = (week: string, offset: number) => {
  const date = new Date(week + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}
const getPlan = (http: Http, room: Room, week: string) => http.get(`${api}/schedule/plan?roomId=${room.id}&weekStart=${week}`).then(response => data<ActivityPlan>(response));
const entry = (activity: Activity, date: string, values: Partial<Entry> = {}) => ({
  id: randomUUID(), date, startTime: '09:00', endTime: '09:20', activityId: activity.id, ...values,
});
const savePlan = (http: Http, room: Room, weekStart: string, entries: ReturnType<typeof entry>[]) => http.post(api + '/schedule/plan', {
  data: { roomId: room.id, weekStart, entries, version: 0, requestId: randomUUID() },
}).then(response => data<ActivityPlan>(response));

async function seed(http: Http, { sevenDays = false, ageMismatch = false } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const source = await data<Room>(await http.post(api + '/rooms', { data: {
    name: 'Reuse source ' + suffix, ageMinMonths: 0, ageMaxMonths: 60, capacity: 12,
  } }), 201);
  const target = await data<Room>(await http.post(api + '/rooms', { data: {
    name: 'Reuse destination ' + suffix, ageMinMonths: ageMismatch ? 72 : 0, ageMaxMonths: ageMismatch ? 120 : 60, capacity: 12,
  } }), 201);
  const item = await data<{ id: string; quantity: string }>(await http.post(api + '/inventory', { data: {
    name: 'Reuse paper ' + suffix, category: 'Art', location: 'Classroom cupboard', unit: 'count',
    openingQuantity: '40', reorderThreshold: '0', reason: 'Synthetic opening stock', requestId: randomUUID(),
  } }), 201);
  const activity = await data<Activity>(await http.post(api + '/activity', { data: {
    name: 'Original saved art ' + suffix, description: 'Keep the original instructions and two sheets.', durationMinutes: 20,
    ageMinMonths: ageMismatch ? 0 : null, ageMaxMonths: ageMismatch ? 60 : null, roomId: null,
    materials: [{ itemId: item.id, quantity: '2', unit: 'count', reusable: false }],
  } }), 201);
  const existingActivity = await data<Activity>(await http.post(api + '/activity', { data: {
    name: 'Existing destination game ' + suffix, description: 'Keep this destination activity.', durationMinutes: 20,
    ageMinMonths: null, ageMaxMonths: null, roomId: null, materials: [],
  } }), 201);
  const sourceEntries = sevenDays ? Array.from({ length: 7 }, (_, index) => entry(activity, dateAt(sourceWeek, index),
    index === 5 ? { startTime: null, endTime: null, timeBlock: 'morning' }
      : index === 6 ? { startTime: '23:40', endTime: '24:00' } : {})) : [entry(activity, sourceWeek)];
  const savedSource = await savePlan(http, source, sourceWeek, sourceEntries);
  const savedTarget = await savePlan(http, target, destinationWeek, [entry(existingActivity, destinationWeek, { startTime: '08:00', endTime: '08:20' }), entry(existingActivity, dateAt(destinationWeek, 2), { startTime: '08:00', endTime: '08:20' })]);
  return { source, target, item, activity, existingActivity, savedSource, savedTarget };
}

async function openDestination(page: Page, target: Room) {
  await page.goto('/activities');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(target.id);
  await page.getByLabel('Week starting Monday', { exact: true }).fill(destinationWeek);
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
}
async function selectCopySource(dialog: Locator, source: Room, scope: 'day' | 'week') {
  await dialog.getByRole('combobox', { name: 'Source room', exact: true }).selectOption(source.id);
  await dialog.getByLabel('Source week starting Monday', { exact: true }).fill(sourceWeek);
  if (scope === 'day') await dialog.getByRole('combobox', { name: 'Source day', exact: true }).selectOption('0');
  await expect(dialog.getByRole('checkbox', { name: /^Include / }).first()).toBeVisible();
}
async function fitsDialog(page: Page, dialog: Locator) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const sizes = await dialog.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.content).toBeLessThanOrEqual(sizes.width + 1);
  for (const control of await dialog.locator('button:visible, select:visible, input:not([type="checkbox"]):not([type="radio"]):visible').all()) {
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(sizes.viewport + 1);
  }
}

for (const width of [390, 1280]) {
  test(`copy a saved seven-day week into a draft, keep snapshots and retry safely at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 850 });
    const http = await authenticatedApi(page);
    const setup = await seed(http, { sevenDays: true });
    const latest = await data<Activity>(await http.put(api + '/activity/' + setup.activity.id, { data: {
      version: 1, name: 'Changed library name ' + setup.activity.id, description: 'New instructions should not replace saved ones.',
      materials: [{ itemId: setup.item.id, quantity: '1', unit: 'count', reusable: false }],
    } }));
    expect(latest.version).toBe(2);
    await data<Room>(await http.put(api + '/rooms/' + setup.source.id, { data: { active: false } }));
    await openDestination(page, setup.target);
    await page.getByRole('button', { name: 'Copy week', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Copy week', exact: true });
    await selectCopySource(dialog, setup.source, 'week');
    await expect(dialog.getByRole('combobox', { name: 'Source room', exact: true }).getByRole('option', { name: setup.source.name + ' (archived)', exact: true })).toHaveAttribute('value', setup.source.id);
    await expect(dialog.getByRole('checkbox', { name: /^Include / })).toHaveCount(7);
    await expect(dialog.getByRole('radio', { name: 'Add to existing activities', exact: true })).toBeChecked();
    await fitsDialog(page, dialog);
    if (width === 390) await page.screenshot({ path: test.info().outputPath('copy-week-mobile-controls.png') });
    await dialog.getByRole('button', { name: 'Preview copy', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Add copy to draft', exact: true })).toBeEnabled();
    await expect(dialog).toContainText(sourceWeek);
    await expect(dialog).toContainText(destinationWeek);
    await expect(dialog.getByRole('region', { name: 'Change preview', exact: true })).toContainText('Needed: 14 items');
    await expect(dialog.getByRole('region', { name: 'Change preview', exact: true })).toContainText('Available: 40 items');
    await fitsDialog(page, dialog);
    if (width === 390) {
      await dialog.getByRole('button', { name: 'Add copy to draft', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath('copy-week-mobile-review.png') });
    }
    expect(await getPlan(http, setup.target, destinationWeek)).toEqual(setup.savedTarget);
    await dialog.getByRole('button', { name: 'Add copy to draft', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Week view', exact: true }).click();
    await expect(page.getByRole('group', { name: /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) activity \d+$/ })).toHaveCount(9);
    const mondayCopy = page.getByRole('group', { name: 'Monday activity 2', exact: true });
    await expect(mondayCopy).toContainText(setup.activity.name);
    await expect(page.getByRole('group', { name: 'Saturday activity 1', exact: true })).toContainText('Time not set');
    await expect(page.getByRole('group', { name: 'Sunday activity 1', exact: true })).toContainText('23:40–midnight');
    expect(await getPlan(http, setup.target, destinationWeek)).toEqual(setup.savedTarget);
    const saveRequests: { requestId: string; entries: unknown[] }[] = [];
    page.on('request', request => {
      if (request.url() === api + '/schedule/plan' && request.method() === 'POST') saveRequests.push(request.postDataJSON());
    });
    await page.route('**/api/schedule/plan', async route => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Synthetic copy save failure' } }) });
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Save week', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic copy save failure' })).toBeVisible();
    await expect(mondayCopy).toContainText(setup.activity.name);
    await expect(page.getByRole('button', { name: 'Undo copy', exact: true })).toBeEnabled();
    expect(await getPlan(http, setup.target, destinationWeek)).toEqual(setup.savedTarget);
    await page.unroute('**/api/schedule/plan');
    const retryResponse = page.waitForResponse(response => response.url() === api + '/schedule/plan' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save week', exact: true }).click();
    expect((await retryResponse).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
    const saved = await getPlan(http, setup.target, destinationWeek);
    expect(saved.entries).toHaveLength(9);
    const copies = saved.entries.filter(value => value.activityId === setup.activity.id);
    expect(copies).toHaveLength(7);
    expect(new Set(saved.entries.map(value => value.id)).size).toBe(9);
    for (let index = 0; index < 7; index++) {
      const original = setup.savedSource.entries[index];
      const copied = copies.find(value => value.date === dateAt(destinationWeek, index))!;
      expect(copied.id).not.toBe(original.id);
      expect(copied.activity).toEqual(original.activity);
      expect([copied.startTime, copied.endTime, copied.timeBlock]).toEqual([original.startTime, original.endTime, original.timeBlock]);
    }
    expect(saved.entries.filter(value => value.activityId === setup.existingActivity.id)).toEqual(setup.savedTarget.entries);
    expect(await getPlan(http, setup.source, sourceWeek)).toEqual(setup.savedSource);
    expect(saveRequests).toHaveLength(2);
    expect(saveRequests[1]).toEqual(saveRequests[0]);
    expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + setup.item.id))).quantity).toBe('40');
    const movements = await http.get(api + '/inventory/' + setup.item.id + '/movements');
    expect((await movements.json()).total).toBe(1);
    await page.getByRole('button', { name: 'Reload week', exact: true }).click();
    await expect(mondayCopy).toContainText(setup.activity.name);
    await expect(page.getByRole('button', { name: 'Undo copy', exact: true })).toHaveCount(0);
  });
}

test('a 320px day replacement requires confirmation, cancellation keeps the draft and undo restores only the affected day', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const http = await authenticatedApi(page); const setup = await seed(http);
  await openDestination(page, setup.target);
  async function previewReplacement() {
    await page.getByRole('button', { name: 'Copy day', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Copy day', exact: true });
    await selectCopySource(dialog, setup.source, 'day');
    await dialog.getByRole('combobox', { name: 'Destination day', exact: true }).selectOption(destinationWeek);
    await dialog.getByRole('radio', { name: 'Replace activities on copied days', exact: true }).check();
    await dialog.getByRole('button', { name: 'Preview copy', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /I confirm replacing 1 existing activit/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add copy to draft', exact: true })).toBeDisabled();
    await fitsDialog(page, dialog); return dialog;
  }
  const cancelled = await previewReplacement();
  await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toContainText(setup.existingActivity.name);
  await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
  const dialog = await previewReplacement();
  await dialog.getByRole('checkbox', { name: /I confirm replacing 1 existing activit/ }).check();
  await dialog.getByRole('button', { name: 'Add copy to draft', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toContainText(setup.activity.name);
  await page.getByRole('button', { name: 'Week view', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Wednesday activity 1', exact: true })).toContainText(setup.existingActivity.name);
  expect(await getPlan(http, setup.target, destinationWeek)).toEqual(setup.savedTarget);
  await page.getByRole('button', { name: 'Undo copy', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toContainText(setup.existingActivity.name);
  await expect(page.getByRole('group', { name: 'Wednesday activity 1', exact: true })).toContainText(setup.existingActivity.name);
  await expect(page.getByRole('group', { name: /^(Monday|Wednesday) activity \d+$/ })).toHaveCount(2);
});

test('moving a saved activity previews another day, supports undo and keeps its identity and snapshot on save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  const http = await authenticatedApi(page); const setup = await seed(http);
  await openDestination(page, setup.target);
  async function moveToTuesday() {
    await page.getByRole('button', { name: 'Move activity 1 on Monday', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Move activity', exact: true });
    await dialog.getByRole('combobox', { name: 'Destination day', exact: true }).selectOption(dateAt(destinationWeek, 1));
    await expect(dialog).toContainText(setup.existingActivity.name);
    await expect(dialog.getByRole('button', { name: 'Move in draft', exact: true })).toBeEnabled();
    await fitsDialog(page, dialog);
    expect(await getPlan(http, setup.target, destinationWeek)).toEqual(setup.savedTarget);
    await dialog.getByRole('button', { name: 'Move in draft', exact: true }).click();
  }
  await moveToTuesday();
  await page.getByRole('button', { name: 'Week view', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Tuesday activity 1', exact: true })).toContainText('08:00–08:20');
  await page.getByRole('button', { name: 'Undo move', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toContainText(setup.existingActivity.name);
  await expect(page.getByRole('group', { name: 'Tuesday activity 1', exact: true })).toHaveCount(0);
  await moveToTuesday();
  const saveResponse = page.waitForResponse(response => response.url() === api + '/schedule/plan' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save week', exact: true }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
  const saved = await getPlan(http, setup.target, destinationWeek);
  const moved = saved.entries.find(value => value.id === setup.savedTarget.entries[0].id)!;
  expect(moved).toEqual({ ...setup.savedTarget.entries[0], date: dateAt(destinationWeek, 1) });
  expect(saved.entries.find(value => value.date === dateAt(destinationWeek, 2))).toEqual(setup.savedTarget.entries[1]);
});

test('a saved activity outside destination ages needs an explicit suitable replacement before copy', async ({ page }) => {
  const http = await authenticatedApi(page); const setup = await seed(http, { ageMismatch: true });
  await openDestination(page, setup.target);
  await page.getByRole('button', { name: 'Copy day', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy day', exact: true });
  await selectCopySource(dialog, setup.source, 'day');
  await expect(dialog).toContainText(/does not match|unsuitable|ages/i);
  await expect(dialog.getByRole('button', { name: 'Preview copy', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Replacement for activity 1', exact: true }).selectOption(setup.existingActivity.id);
  await dialog.getByRole('button', { name: 'Preview copy', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Add copy to draft', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Add copy to draft', exact: true }).click();
  const saveResponse = page.waitForResponse(response => response.url() === api + '/schedule/plan' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save week', exact: true }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
  const saved = await getPlan(http, setup.target, destinationWeek);
  expect(saved.entries).toHaveLength(3);
  expect(saved.entries.every(value => value.activityId === setup.existingActivity.id)).toBe(true);
  expect(saved.entries.some(value => value.activityId === setup.activity.id)).toBe(false);
  expect(await getPlan(http, setup.source, sourceWeek)).toEqual(setup.savedSource);
});

test('an archived destination keeps the saved schedule viewable and prevents copy and move edits', async ({ page }) => {
  const http = await authenticatedApi(page); const setup = await seed(http);
  await data<Room>(await http.put(api + '/rooms/' + setup.target.id, { data: { active: false } }));
  await openDestination(page, setup.target);
  await expect(page.getByRole('group', { name: 'Monday activity 1', exact: true })).toContainText(setup.existingActivity.name);
  await expect(page.getByRole('button', { name: 'Copy day', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy week', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move activity 1 on Monday', exact: true })).toBeDisabled();
  expect(await getPlan(http, setup.target, destinationWeek)).toEqual(setup.savedTarget);
});
