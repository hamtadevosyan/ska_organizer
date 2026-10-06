import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
let roomId: string;
let childName: string;
let staffName: string;
let itemName: string;
let itemId: string;
let activityName: string;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const http = await authenticatedApi(await context.newPage());
    const suffix = Date.now().toString();
    const longName = 'LongNameWithoutSpacesForLayoutReview';
    const roomResponse = await http.post(api + '/rooms', { data: {
      name: 'Mobile ' + longName + suffix, ageMinMonths: 0, ageMaxMonths: 216, capacity: 12,
    } });
    expect(roomResponse.status()).toBe(201);
    roomId = (await roomResponse.json()).data.id;
    childName = 'Mobile ' + longName + suffix;
    const childResponse = await http.post(api + '/children', { data: {
      firstName: 'Mobile', lastName: longName + suffix, dateOfBirth: '2023-01-01', roomId, active: true,
    } });
    expect(childResponse.status()).toBe(201);
    const child = await childResponse.json();
    expect((await http.post(api + '/attendance/checkin', { data: { childId: child.id, roomId } })).status()).toBe(201);
    staffName = 'Mobile staff ' + longName + suffix;
    expect((await http.post(api + '/staff', { data: { name: staffName, role: 'Assistant teacher', roomId, active: true } })).status()).toBe(201);
    itemName = 'Mobile paper ' + longName + suffix;
    const itemResponse = await http.post(api + '/inventory', { data: {
      name: itemName, category: 'Mobile review supplies', location: 'LongStorageLocationWithoutSpaces',
      unit: 'count', openingQuantity: '20', reorderThreshold: '0', reason: 'Synthetic opening count', requestId: 'mobile-stock-' + suffix,
    } });
    expect(itemResponse.status()).toBe(201);
    const item = (await itemResponse.json()).data;
    itemId = item.id;
    activityName = 'Mobile art ' + longName + suffix;
    const activityResponse = await http.post(api + '/activity', { data: {
      name: activityName, description: 'Synthetic layout review.', durationMinutes: 20,
      ageMinMonths: 0, ageMaxMonths: 216, roomId: null,
      materials: [{ itemId: item.id, quantity: '2', unit: 'count', reusable: false }],
    } });
    expect(activityResponse.status()).toBe(201);
    expect((await activityResponse.json()).data.id).toBeTruthy();
    cookies = await context.cookies();
  } finally { await context.close(); }
});
test.beforeEach(async ({ context }) => { await context.addCookies(cookies); });

async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const size = await page.locator('main').evaluate((main) => ({
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth,
    content: main.scrollWidth, available: main.clientWidth,
  }));
  expect(size.document, page.url() + ': document width').toBeLessThanOrEqual(size.viewport + 1);
  // The shell can contain overflow; check the actual content too, so that a
  // horizontally scrolling main region cannot mask an unusable page.
  expect(size.content, page.url() + ': main content width').toBeLessThanOrEqual(size.available + 1);
  const controls = await page.locator('.ska-core-page button:visible, .ska-core-page select:visible, .ska-activity-composer input:not([type="checkbox"]):visible').evaluateAll(elements =>
    elements.map(element => {
      const box = element.getBoundingClientRect();
      return { name: element.getAttribute('aria-label') || element.textContent || element.tagName,
        x: box.x, width: box.width, height: box.height };
    }));
  for (const box of controls) {
    expect(box.height, box.name + ': control height').toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}

for (const width of [320, 390, 768, 1280]) {
  test(`core screens keep records and actions usable at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/dashboard');
    await expect(page.getByRole('region', { name: 'Recent changes' })).toBeVisible();
    await fits(page);
    await page.goto('/attendance');
    await expect(page.getByRole('heading', { name: "Who's here today?", exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Attendance room', exact: true }).selectOption(roomId);
    await expect(page.getByRole('article', { name: childName, exact: true })).toBeVisible();
    await fits(page);

    await page.goto('/children');
    await page.getByRole('searchbox', { name: 'Search children' }).fill(childName);
    await expect(page.getByRole('row', { name: childName, exact: true })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'View ' + childName, exact: true }).click();
    await expect(page.getByRole('table', { name: 'Recent attendance' })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Close profile', exact: true }).click();
    await page.getByRole('button', { name: 'Edit ' + childName, exact: true }).click();
    await fits(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.goto('/staff');
    await page.getByRole('searchbox', { name: 'Search staff' }).fill(staffName);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('rowheader', { name: staffName, exact: true })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Edit ' + staffName, exact: true }).click();
    await fits(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.goto('/inventory');
    await page.getByRole('button', { name: 'View all items', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search items' }).fill(itemName);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Used some ' + itemName, exact: true })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Used some ' + itemName, exact: true }).click();
    await fits(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.goto('/activities');
    await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(roomId);
    await expect(page.getByRole('button', { name: 'Add activity', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Add activity', exact: true }).click();
    const composer = page.getByRole('form', { name: 'Schedule activity', exact: true });
    await composer.getByRole('searchbox', { name: 'Search saved activities', exact: true }).fill(activityName);
    await expect(composer.getByRole('button', { name: 'Choose ' + activityName, exact: true })).toBeVisible();
    await fits(page);
    await composer.getByRole('button', { name: 'Choose ' + activityName, exact: true }).click();
    await expect(composer.getByLabel('Start time', { exact: true })).toHaveValue('08:00');
    await expect(composer.getByLabel('End time', { exact: true })).toHaveValue('08:20');
    await fits(page);
    await composer.getByRole('button', { name: 'Add to day', exact: true }).click();
    const scheduled = page.getByRole('group', { name: 'Monday activity 1', exact: true });
    await expect(scheduled).toContainText(activityName);
    await expect(scheduled).toContainText('08:00–08:20');
    await expect(scheduled.getByRole('combobox')).toHaveCount(0);
    await expect(scheduled.locator('input')).toHaveCount(0);
    await fits(page);
    await scheduled.getByRole('button', { name: 'Edit activity 1 on Monday', exact: true }).click();
    const editSchedule = page.getByRole('form', { name: 'Edit scheduled activity', exact: true });
    await expect(editSchedule.getByLabel('Start time', { exact: true })).toBeFocused();
    await fits(page);
    await editSchedule.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editSchedule).toHaveCount(0);
    await expect(scheduled).toContainText('08:00–08:20');
    // Open the successful materials check as well as the scheduling controls.
    const materials = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Materials/ }) });
    if (await materials.getAttribute('open') === null) await materials.locator('summary').click();
    await expect(page.getByRole('table', { name: 'Activity material availability' })).toBeVisible();
    await fits(page);
    page.once('dialog', dialog => { void dialog.accept(); });
    await page.getByRole('button', { name: 'Reload week', exact: true }).click();
    await expect(page.getByText('Nothing scheduled for this day.', { exact: true })).toBeVisible();
    await expect(scheduled).toHaveCount(0);
    const stock = await page.request.get(api + '/inventory/' + itemId);
    expect(stock.status()).toBe(200);
    expect((await stock.json()).data.quantity).toBe('20');
    const movements = await page.request.get(api + '/inventory/' + itemId + '/movements');
    expect(movements.status()).toBe(200);
    expect((await movements.json()).total).toBe(1);

    await page.goto('/meals');
    await expect(page.getByRole('button', { name: 'Generate Menu', exact: true })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Meal Setup', exact: true })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Planner', exact: true }).click();
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('group', { name: 'Meal views' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Meals', exact: true })).toBeHidden();
    await page.emulateMedia({ media: 'screen' });

    await page.goto('/reports');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.getByLabel('Room', { exact: true }).selectOption(roomId);
    await expect(page.getByTestId('screen-report').getByRole('row').filter({ hasText: childName })).toBeVisible();
    await fits(page);
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeHidden();
    await expect(page.getByTestId('printed-report').locator('thead')).toBeVisible();
    expect(await page.getByTestId('printed-report').locator('table').evaluate(table => getComputedStyle(table).display)).toBe('table');
    await page.emulateMedia({ media: 'screen' });
    expect(errors).toEqual([]);
  });
}
