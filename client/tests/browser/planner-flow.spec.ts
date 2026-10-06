import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const size = await page.locator('main').evaluate(main => ({
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth,
    content: main.scrollWidth, available: main.clientWidth,
  }));
  expect(size.document, 'The planner must fit the viewport').toBeLessThanOrEqual(size.viewport + 1);
  expect(size.content, 'The planner content must fit the main region').toBeLessThanOrEqual(size.available + 1);
  const controls = await page.locator('.activity-screen button:visible, .activity-screen select:visible, .activity-screen input:not([type="checkbox"]):visible').evaluateAll(elements =>
    elements.map(element => {
      const box = element.getBoundingClientRect();
      return { name: element.getAttribute('aria-label') || element.textContent || element.tagName,
        x: box.x, width: box.width, height: box.height };
    }));
  expect(controls.length).toBeGreaterThan(0);
  for (const box of controls) {
    expect(box.height, box.name + ': usable touch height').toBeGreaterThanOrEqual(44);
    expect(box.width, box.name + ': usable touch width').toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}

for (const width of [375, 768, 1280]) {
  test(`teachers schedule, recover edits and undo across views at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const http = await authenticatedApi(page);
    const suffix = `${width}-${Date.now().toString(36)}-${test.info().repeatEachIndex}`;
    const roomName = 'Planner flow ' + suffix;
    const activityName = 'Movement ' + suffix;
    const mismatchName = 'Older lesson ' + suffix;
    const roomResponse = await http.post(api + '/rooms', { data: { name: roomName,
      ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 } });
    expect(roomResponse.status()).toBe(201);
    const room = (await roomResponse.json()).data;
    const activityResponse = await http.post(api + '/activity', { data: { name: activityName,
      description: 'Synthetic movement activity.', durationMinutes: 5,
      ageMinMonths: 24, ageMaxMonths: 60, roomId: null, materials: [] } });
    expect(activityResponse.status()).toBe(201);
    const activity = (await activityResponse.json()).data;
    expect((await http.post(api + '/activity', { data: { name: mismatchName,
      description: 'Synthetic older age range.', durationMinutes: 10,
      ageMinMonths: 72, ageMaxMonths: 96, roomId: null, materials: [] } })).status()).toBe(201);
    const time = (minutes: number) => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
    const seeded = Array.from({ length: 11 }, (_, index) => ({ id: 'planner-flow-' + suffix + '-' + index,
      date: '2026-09-14', startTime: time(480 + index * 5), endTime: time(485 + index * 5),
      activityId: activity.id, useLatest: true, activityVersion: activity.version }));
    const initial = await http.post(api + '/schedule/plan', { data: { roomId: room.id,
      weekStart: '2026-09-14', entries: seeded, version: 0, requestId: 'planner-flow-seed-' + suffix } });
    expect(initial.status()).toBe(200);

    await page.goto('/activities');
    await expect(page.getByRole('button', { name: 'Add activity', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
    await page.getByLabel('Week starting Monday', { exact: true }).fill('2026-09-14');
    const timeline = page.getByRole('group', { name: /^Monday activity \d+$/ });
    await expect(timeline).toHaveCount(11);
    await fits(page);
    await page.getByRole('button', { name: 'Add activity', exact: true }).click();
    const composer = page.getByRole('form', { name: 'Schedule activity', exact: true });
    const search = composer.getByRole('searchbox', { name: 'Search saved activities', exact: true });
    await expect(search).toBeFocused();
    await search.fill(mismatchName);
    await expect(composer.getByRole('button', { name: 'Choose ' + mismatchName, exact: true })).toHaveCount(0);
    await expect(composer.getByText('No saved activities match your search. Try another name or create an activity.', { exact: true })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Add to day', exact: true })).toHaveCount(0);
    await search.fill(activityName);
    await expect(composer.getByRole('button', { name: /^Choose / })).toHaveCount(1);
    await composer.getByRole('button', { name: 'Choose ' + activityName, exact: true }).click();
    await expect(composer.getByLabel('Start time', { exact: true })).toHaveValue('08:55');
    await expect(composer.getByLabel('End time', { exact: true })).toHaveValue('09:00');
    await fits(page);
    await composer.getByRole('button', { name: 'Add to day', exact: true }).click();
    await expect(composer).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add activity', exact: true })).toBeFocused();
    await expect(timeline).toHaveCount(12);
    const last = page.getByRole('group', { name: 'Monday activity 12', exact: true });
    await expect(last).toContainText(activityName);
    await expect(last).toContainText('08:55–09:00');
    await expect(last.getByRole('combobox')).toHaveCount(0);
    await expect(last.locator('input')).toHaveCount(0);

    await last.getByRole('button', { name: 'Edit activity 12 on Monday', exact: true }).click();
    const edit = page.getByRole('form', { name: 'Edit scheduled activity', exact: true });
    const start = edit.getByLabel('Start time', { exact: true });
    const end = edit.getByLabel('End time', { exact: true });
    await expect(start).toBeFocused();
    await start.fill('09:30');
    await expect(end).toHaveValue('09:35');
    await end.fill('07:00');
    await edit.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await expect(end).toHaveAttribute('aria-invalid', 'true');
    await expect(end).toHaveAccessibleDescription('End time must be after start time.');
    await expect(last).toContainText('08:55–09:00');
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    await edit.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(start).toHaveValue('09:30');
    await expect(end).toHaveValue('07:00');
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    await edit.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(last).toContainText('08:55–09:00');
    await expect(last.getByRole('button', { name: 'Edit activity 12 on Monday', exact: true })).toBeFocused();
    await last.getByRole('button', { name: 'Edit activity 12 on Monday', exact: true }).click();
    await start.fill('09:30');
    await edit.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await expect(last).toContainText('09:30–09:35');

    await last.getByRole('button', { name: 'Remove activity 12 on Monday', exact: true }).click();
    await expect(timeline).toHaveCount(11);
    await page.getByRole('button', { name: 'Week view', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo removal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo removal', exact: true }).click();
    await expect(timeline).toHaveCount(12);
    await expect(last).toContainText('09:30–09:35');
    await fits(page);
    await page.getByRole('button', { name: 'Day view', exact: true }).click();
    await expect(timeline).toHaveCount(12);
    await expect(last).toContainText('09:30–09:35');

    // Printing always covers the whole week, with an explicit label for drafts.
    await page.emulateMedia({ media: 'print' });
    const printed = page.getByRole('table', { name: 'Weekly activity schedule for ' + roomName, exact: true });
    await expect(printed).toBeVisible();
    await expect(page.getByText('Week of 2026-09-14 · Draft — not saved', { exact: true })).toBeVisible();
    await expect(printed.locator('tbody')).toHaveCount(7);
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      await expect(printed.getByRole('rowheader').filter({ hasText: day }).first()).toBeVisible();
    }
    await expect(printed).toContainText('09:30–09:35');
    await page.emulateMedia({ media: 'screen' });
    await page.getByRole('button', { name: 'Save week', exact: true }).click();
    await expect(page.getByText('Week saved.', { exact: true })).toBeVisible();
    const saved = (await (await http.get(api + '/schedule/plan?roomId=' + room.id + '&weekStart=2026-09-14')).json()).data;
    expect(saved).toMatchObject({ version: 2, roomId: room.id, weekStart: '2026-09-14' });
    expect(saved.entries).toHaveLength(12);
    expect(new Set(saved.entries.map((entry: { id: string }) => entry.id)).size).toBe(12);
    expect(saved.entries.at(-1)).toMatchObject({ date: '2026-09-14', startTime: '09:30', endTime: '09:35', activityId: activity.id });
    expect(saved.entries.every((entry: { activity: { name: string } }) => entry.activity.name === activityName)).toBe(true);
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByText(/Draft — not saved/)).toHaveCount(0);
    await expect(printed.locator('tbody')).toHaveCount(7);
    await page.emulateMedia({ media: 'screen' });
    await last.getByRole('button', { name: 'Remove activity 12 on Monday', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo removal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save week', exact: true }).click();
    await expect(page.getByText('Week saved.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo removal', exact: true })).toHaveCount(0);
    const afterRemoval = (await (await http.get(api + '/schedule/plan?roomId=' + room.id + '&weekStart=2026-09-14')).json()).data;
    expect(afterRemoval.version).toBe(3);
    expect(afterRemoval.entries).toHaveLength(11);
    if (width === 375) {
      const materialResponse = await http.post(api + '/inventory', { data: { name: 'Layout paper ' + suffix,
        category: 'Art', location: 'Synthetic cupboard', unit: 'count', openingQuantity: '10', reorderThreshold: '0',
        reason: 'Synthetic layout count', requestId: 'planner-material-layout-' + suffix } });
      expect(materialResponse.status()).toBe(201);
      const item = (await materialResponse.json()).data;
      await page.locator('summary').filter({ hasText: /^Saved activities/ }).click();
      await page.getByRole('button', { name: 'Create library activity', exact: true }).click();
      const libraryForm = page.getByRole('form', { name: 'New activity', exact: true });
      await libraryForm.getByText('More details', { exact: true }).click();
      await libraryForm.getByRole('combobox', { name: 'Material', exact: true }).selectOption(item.id);
      await libraryForm.getByRole('button', { name: 'Add material', exact: true }).click();
      await fits(page);
      const reusable = libraryForm.locator('label').filter({ hasText: 'Can be reused after the activity' });
      const reusableBox = await reusable.boundingBox();
      expect(reusableBox).not.toBeNull();
      expect(reusableBox!.height, 'The reusable-material checkbox label is its touch target').toBeGreaterThanOrEqual(44);
      expect(reusableBox!.width).toBeGreaterThanOrEqual(44);
      await libraryForm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await libraryForm.getByRole('button', { name: 'Discard activity', exact: true }).click();
      await expect(libraryForm).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}
