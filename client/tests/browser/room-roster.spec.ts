import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const sizes = await page.locator('main').evaluate(main => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    main: main.scrollWidth,
    available: main.clientWidth,
  }));
  expect(sizes.document, 'The roster must fit the viewport').toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.main, 'The roster content must fit the main region').toBeLessThanOrEqual(sizes.available + 1);
  for (const control of await page.locator('.ska-core-page button:visible, .ska-core-page input[type="search"]:visible').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height, 'Roster controls need a usable touch target').toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(sizes.viewport + 1);
  }
}

for (const width of [390, 1280]) {
  test(`a room roster preserves identity and follows enrollment changes at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = [];
    const mutations: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/\/api\/(rooms|children)(?:[/?]|$)/.test(request.url()) && request.method() !== 'GET') {
        mutations.push(request.method() + ' ' + request.url());
      }
    });
    const http = await authenticatedApi(page);
    const suffix = `${width}-${Date.now().toString(36)}-${test.info().repeatEachIndex}`;
    const roomName = 'Roster room ' + suffix;
    const destinationName = 'Destination ' + suffix;
    const emptyName = 'Empty room ' + suffix;
    const createRoom = async (name: string) => {
      const response = await http.post(api + '/rooms', { data: { name, ageMinMonths: 0, ageMaxMonths: 216, capacity: 12 } });
      expect(response.status()).toBe(201);
      return (await response.json()).data;
    };
    const room = await createRoom(roomName);
    const destination = await createRoom(destinationName);
    const empty = await createRoom(emptyName);
    const fullName = 'Roster Twin ' + suffix;
    const preferredName = 'Sunny ' + suffix;
    const createChild = async (data: Record<string, unknown>) => {
      const response = await http.post(api + '/children', { data: { firstName: 'Roster', lastName: 'Twin ' + suffix,
        dateOfBirth: '2022-03-01', roomId: room.id, ...data } });
      expect(response.status()).toBe(201);
      return await response.json();
    };
    const first = await createChild({ preferredName, notes: 'Uses the blue cup.' });
    const second = await createChild({ dateOfBirth: '2023-04-02', notes: 'Uses the orange cup.', confirmDuplicate: true });
    const inactiveName = 'Inactive Child ' + suffix;
    await createChild({ firstName: 'Inactive', lastName: 'Child ' + suffix, active: false });
    const elsewhereName = 'Elsewhere Child ' + suffix;
    await createChild({ firstName: 'Elsewhere', lastName: 'Child ' + suffix, roomId: destination.id });

    await page.goto('/rooms');
    const card = page.getByRole('article', { name: roomName, exact: true });
    await card.getByRole('link', { name: 'View children in ' + roomName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp('/rooms/' + room.id + '$'));
    await expect(page.getByRole('heading', { name: roomName, exact: true })).toBeVisible();
    const summary = page.getByRole('region', { name: 'Room enrollment', exact: true });
    await expect(summary).toContainText('2 active children');
    await expect(summary).toContainText('Capacity 12');
    const roster = page.getByRole('table', { name: 'Room roster records', exact: true });
    const twins = roster.getByRole('row', { name: fullName, exact: true });
    await expect(twins).toHaveCount(2);
    const firstRow = twins.filter({ hasText: '2022-03-01' });
    const secondRow = twins.filter({ hasText: '2023-04-02' });
    await expect(firstRow).toContainText('Goes by ' + preferredName);
    await expect(firstRow).toContainText('Active');
    await expect(secondRow).toContainText('Active');
    await expect(roster.getByRole('row', { name: inactiveName, exact: true })).toHaveCount(0);
    await expect(roster.getByRole('row', { name: elsewhereName, exact: true })).toHaveCount(0);
    await fits(page);

    // Both same-name records open their own profile, identified by DOB and notes.
    const profile = page.getByRole('region', { name: 'Child profile', exact: true });
    await firstRow.getByRole('button', { name: 'View ' + fullName, exact: true }).click();
    await expect(profile).toContainText('2022-03-01');
    await expect(profile).toContainText('Uses the blue cup.');
    await expect(profile).not.toContainText('Uses the orange cup.');
    await fits(page);
    await profile.getByRole('button', { name: 'Back to room roster', exact: true }).click();
    await expect(profile).toHaveCount(0);
    await expect(firstRow).toBeVisible();
    await secondRow.getByRole('button', { name: 'View ' + fullName, exact: true }).click();
    await expect(profile).toContainText('2023-04-02');
    await expect(profile).toContainText('Uses the orange cup.');
    await expect(profile).not.toContainText('Uses the blue cup.');
    await profile.getByRole('button', { name: 'Back to room roster', exact: true }).click();

    const search = page.getByRole('searchbox', { name: 'Search children', exact: true });
    await search.fill(preferredName);
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toHaveCount(0);
    await expect(summary).toContainText('2 active children');
    await search.fill('');
    await expect(twins).toHaveCount(2);
    const includeInactive = page.getByRole('checkbox', { name: 'Include inactive children', exact: true });
    await includeInactive.check();
    await expect(roster.getByRole('row', { name: inactiveName, exact: true })).toContainText('Inactive');
    await expect(summary).toContainText('2 active children');
    await includeInactive.uncheck();
    await expect(roster.getByRole('row', { name: inactiveName, exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL(new RegExp('/rooms/' + room.id + '$'));
    await expect(page.getByRole('heading', { name: roomName, exact: true })).toBeVisible();
    await expect(twins).toHaveCount(2);

    // Changes made elsewhere are reflected by refresh without losing the room.
    expect((await http.put(api + '/children/' + first.id + '/room', { data: { roomId: destination.id } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Refresh roster', exact: true }).click();
    await expect(firstRow).toHaveCount(0);
    await expect(secondRow).toBeVisible();
    await expect(summary).toContainText('1 active child');
    await expect(page).toHaveURL(new RegExp('/rooms/' + room.id + '$'));
    expect((await http.put(api + '/children/' + second.id + '/enrollment', { data: { active: false } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Refresh roster', exact: true }).click();
    await expect(secondRow).toHaveCount(0);
    await expect(summary).toContainText('0 active children');
    await includeInactive.check();
    await expect(secondRow).toContainText('Inactive');
    await expect(roster.getByRole('row', { name: inactiveName, exact: true })).toBeVisible();
    await expect(summary).toContainText('0 active children');
    expect((await http.put(api + '/children/' + second.id + '/enrollment', { data: { active: true } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Refresh roster', exact: true }).click();
    await expect(secondRow).toContainText('Active');
    await expect(summary).toContainText('1 active child');
    await includeInactive.uncheck();
    await expect(secondRow).toBeVisible();
    await expect(roster.getByRole('row', { name: inactiveName, exact: true })).toHaveCount(0);

    // A failed refresh must not present the old roster as a current result.
    const rejectRoster = async (route: Route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'GET' && url.pathname === '/api/children' && url.searchParams.get('roomId') === room.id) {
        await route.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Synthetic room roster outage.' } }) });
      } else await route.continue();
    };
    await page.route('**/api/children?**', rejectRoster);
    try {
      await page.getByRole('button', { name: 'Refresh roster', exact: true }).click();
      await expect(page.getByRole('main').getByRole('alert')).toContainText('Synthetic room roster outage.');
      await expect(roster).toHaveCount(0);
      await expect(summary).toHaveCount(0);
    } finally { await page.unroute('**/api/children?**', rejectRoster); }
    await page.getByRole('main').getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(secondRow).toBeVisible();
    await expect(summary).toContainText('1 active child');
    await expect(page).toHaveURL(new RegExp('/rooms/' + room.id + '$'));

    await page.getByRole('link', { name: 'Back to rooms', exact: true }).click();
    await page.getByRole('article', { name: emptyName, exact: true })
      .getByRole('link', { name: 'View children in ' + emptyName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp('/rooms/' + empty.id + '$'));
    await expect(page.getByRole('heading', { name: emptyName, exact: true })).toBeVisible();
    await expect(summary).toContainText('0 active children');
    await expect(summary).toContainText('Capacity 12');
    await expect(page.getByText('No actively enrolled children are assigned to this room.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh roster', exact: true })).toBeEnabled();
    await fits(page);
    expect(mutations, 'Reviewing a room roster must not modify child or room records').toEqual([]);
    expect(errors).toEqual([]);
  });
}
