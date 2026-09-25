import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

test('dashboard refreshes real counts, opens low stock, and reads the saved date and room plans', async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const client = await authenticatedApi(page); const suffix = Date.now();
  const baselineResponse = await client.get(api + '/dashboard');
  expect(baselineResponse.status()).toBe(200); const baseline = await baselineResponse.json();
  const roomResponse = await client.post(api + '/rooms', { data: { name: 'Dashboard room ' + suffix, capacity: 12, ageMinMonths: 12, ageMaxMonths: 72 } });
  expect(roomResponse.status()).toBe(201); const room = (await roomResponse.json()).data;
  const childResponse = await client.post(api + '/children', { data: { firstName: 'Dashboard', lastName: String(suffix),
    dateOfBirth: '2023-01-01', roomId: room.id, active: true } });
  expect(childResponse.status()).toBe(201); 
  const child = await childResponse.json();
  expect(child).toMatchObject({ id: expect.any(String), roomId: room.id });
  const stockResponse = await client.post(api + '/inventory', { data: { name: 'Dashboard paper ' + suffix, category: 'Art supplies', location: 'Cupboard',
    unit: 'count', openingQuantity: '1', reorderThreshold: '2', reason: 'Initial count', requestId: 'dashboard-stock-' + suffix } });
  expect(stockResponse.status()).toBe(201); const stock = (await stockResponse.json()).data;
  await page.goto('/dashboard');
  const enrolled = page.getByRole('region', { name: 'Enrolled children', exact: true });
  await expect(enrolled.getByText(String(baseline.totalStudents + 1), { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Running low/ }).click();
  await expect(page).toHaveURL(/\/inventory\?status=low$/);
  await expect(page.getByRole('row').filter({ hasText: stock.name })).toContainText('Low stock');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  const visit = await client.post(api + '/attendance/checkin', { data: { childId: child.id, roomId: room.id } });
  expect(visit.status()).toBe(201);
  await page.getByRole('button', { name: 'Refresh dashboard' }).click();
  const liveResponse = await client.get(api + '/dashboard'); const live = await liveResponse.json();
  if (live.sections.attendance.data.reviewRequired) await expect(page.getByText('Check attendance', { exact: true })).toBeVisible();
  else await expect(page.getByRole('region', { name: 'Present now' }).getByText(String(live.sections.attendance.data.count), { exact: true })).toBeVisible();

  const week = '2030-01-07';
  const mealResponse = await client.post(api + '/meals', { data: { name: 'Dashboard breakfast ' + suffix, type: 'breakfast' } });
  expect(mealResponse.status()).toBe(201); const meal = (await mealResponse.json()).data;
  const ingredientResponse = await client.post(api + '/ingredients', { data: { name: 'Dashboard oats ' + suffix, unit: 'g' } });
  expect(ingredientResponse.status()).toBe(201); const ingredient = (await ingredientResponse.json()).data;
  expect((await client.post(api + '/meals/' + meal.id + '/ingredients', { data: { ingredientId: ingredient.id, quantity: 30 } })).status()).toBe(201);
  const preview = await client.post(api + '/menu/plans/' + week + '/preview', { data: { version: 0, childrenCount: 1, staffCount: 0,
    week: [{ day: 'Monday', menu: { breakfast: { id: meal.id } } }] } });
  expect(preview.status()).toBe(200);
  expect((await client.put(api + '/menu/plans/' + week, { data: { previewToken: (await preview.json()).data.previewToken } })).status()).toBe(200);
  const activityResponse = await client.post(api + '/activity', { data: { name: 'Dashboard reading ' + suffix, durationMinutes: 20 } });
  expect(activityResponse.status()).toBe(201); const activity = (await activityResponse.json()).data;
  expect((await client.post(api + '/schedule/plan', { data: { roomId: room.id, weekStart: week, version: 0, requestId: 'dashboard-plan-' + suffix,
    entries: [{ id: 'dashboard-entry-' + suffix, date: week, startTime: '09:00', endTime: '09:20', activityId: activity.id }] } })).status()).toBe(200);
  await page.getByLabel('Plan date', { exact: true }).fill(week);
  await expect(page.getByRole('region', { name: 'Meals', exact: true })).toContainText(meal.name);
  const activityRoom = page.getByRole('region', { name: room.name, exact: true });
  await expect(activityRoom).toContainText(activity.name);
  await expect(activityRoom).toContainText('09:00–09:20');
  await expect(page.getByRole('region', { name: 'Recent changes' })).toContainText('Weekly menu saved');
  const nextDay = '2030-01-08';
  await page.getByLabel('Plan date', { exact: true }).fill(nextDay);
  await expect(page.getByRole('region', { name: 'Meals', exact: true })).toContainText('No meals saved for this date.');
  await expect(activityRoom).toContainText('No activities saved for this date.');
  await page.reload();
  await expect(enrolled.getByText(String(baseline.totalStudents + 1), { exact: true })).toBeVisible();
  const stockAfter = await client.get(api + '/inventory/' + stock.id);
  expect((await stockAfter.json()).data.quantity).toBe(stock.quantity);
  // Leave the shared browser fixture without a new open attendance visit.
  expect((await client.post(api + '/attendance/' + (await visit.json()).id + '/checkout', { data: {} })).status()).toBe(200);
  expect(errors).toEqual([]);
});
