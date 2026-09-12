import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

test('maintain the child roster, review duplicates and retain history after ending enrollment', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const http = await authenticatedApi(page);
  const roomResponse = await http.post(api + '/rooms', { data: {
    name: 'Browser roster room', ageMinMonths: 24, ageMaxMonths: 72, capacity: 2,
  } });
  expect(roomResponse.status()).toBe(201);
  const room = (await roomResponse.json()).data;
  await page.goto('/children');
  await expect(page.getByRole('heading', { name: 'Children', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  await page.getByLabel('First name', { exact: true }).fill('Browser');
  await page.getByLabel('Last name', { exact: true }).fill('Roster Child');
  await page.getByLabel('Date of birth', { exact: true }).fill('2022-03-01');
  await page.getByLabel('Preferred name (optional)', { exact: true }).fill('Sunny');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  await page.getByLabel('Operational notes (optional)', { exact: true }).fill('Uses a blue cup.');
  await page.getByRole('button', { name: 'Save child', exact: true }).click();
  await expect(page.getByRole('row', { name: 'Browser Roster Child', exact: true })).toBeVisible();
  const children = (await (await http.get(api + '/children?q=Browser%20Roster%20Child')).json()).items;
  expect(children).toHaveLength(1);
  const child = children[0];
  const checkin = await http.post(api + '/attendance/checkin', { data: { childId: child.id, roomId: room.id } });
  expect(checkin.status()).toBe(201);
  const record = await checkin.json();

  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  await page.getByLabel('First name', { exact: true }).fill('Browser');
  await page.getByLabel('Last name', { exact: true }).fill('Roster Child');
  await page.getByLabel('Date of birth', { exact: true }).fill('2023-03-01');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  await page.getByRole('button', { name: 'Save child', exact: true }).click();
  await expect(page.getByText('Review possible duplicate records')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save child', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I reviewed the matching records and want to save this child.', exact: true }).check();
  await page.getByRole('button', { name: 'Save child', exact: true }).click();
  await expect(page.getByRole('row', { name: 'Browser Roster Child', exact: true })).toHaveCount(2);

  const originalRow = page.getByRole('row', { name: 'Browser Roster Child', exact: true }).filter({ hasText: '2022-03-01' });
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await originalRow.getByRole('button', { name: 'End enrollment for Browser Roster Child', exact: true }).click();
  await expect(originalRow).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Enrollment', exact: true }).selectOption('false');
  await expect(originalRow).toBeVisible();
  await originalRow.getByRole('button', { name: 'View Browser Roster Child', exact: true }).click();
  await expect(page.getByText('Uses a blue cup.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent attendance', exact: true })).toBeVisible();
  const profile = await (await http.get(api + '/children/' + child.id + '/profile')).json();
  expect(profile.child).toMatchObject({ id: child.id, active: false, roomId: room.id });
  expect(profile.recentAttendance[0].id).toBe(record.id);
  expect((await (await http.get(api + '/rooms/' + room.id)).json()).data.assignedChildCount).toBe(1);

  await originalRow.getByRole('button', { name: 'Edit Browser Roster Child', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Active enrollment', exact: true }).check();
  await page.getByRole('button', { name: 'Save child', exact: true }).click();
  await expect(page.getByText('Browser Roster Child saved.')).toBeVisible();
  await page.reload();
  await expect(originalRow).toBeVisible();
  const reactivated = await (await http.get(api + '/children/' + child.id)).json();
  expect(reactivated).toMatchObject({ id: child.id, active: true, dateOfBirth: '2022-03-01', preferredName: 'Sunny' });
  expect(errors).toEqual([]);
});
