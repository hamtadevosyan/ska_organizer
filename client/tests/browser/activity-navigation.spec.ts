import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

for (const width of [390, 1280]) {
  test(`unfinished activity is protected by phone/desktop navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await authenticatedApi(page, { freshSession: true });
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Activities', exact: true }).filter({ visible: true }).click();
    await page.locator('summary').filter({ hasText: /^Saved activities/ }).click();
    await page.getByRole('button', { name: 'Create library activity', exact: true }).click();
    await page.getByLabel('Activity name', { exact: true }).fill('Synthetic unfinished activity');
    const activitySaves: string[] = [];
    page.on('request', (request) => { if (request.url() === api + '/activity' && request.method() === 'POST') activitySaves.push(request.url()); });
    await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Leave your unsaved work?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(page.getByLabel('Activity name', { exact: true })).toHaveValue('Synthetic unfinished activity');
    // The app, rather than page.goto(), created this history entry.
    await page.goBack();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(page).toHaveURL(/\/activities$/);
    await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).click();
    await dialog.getByRole('button', { name: 'Discard and leave', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole('link', { name: 'Activities', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('form', { name: 'New activity' })).toHaveCount(0);
    expect(activitySaves).toHaveLength(0);
  });
  test(`unsaved week survives navigation cancellation and failed save at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const http = await authenticatedApi(page, { freshSession: true });
    const suffix = Date.now().toString();
    const roomResponse = await http.post(api + '/rooms', { data: { name: 'Navigation room ' + suffix,
      ageMinMonths: 0, ageMaxMonths: 216, capacity: 10 } });
    expect(roomResponse.status()).toBe(201);
    const roomId = (await roomResponse.json()).data.id;
    const activityName = 'Navigation art ' + suffix;
    const activityResponse = await http.post(api + '/activity', { data: { name: activityName,
      description: 'Synthetic navigation check.', durationMinutes: 20, ageMinMonths: null,
      ageMaxMonths: null, roomId: null, materials: [] } });
    expect(activityResponse.status()).toBe(201);
    expect((await activityResponse.json()).data.id).toBeTruthy();
    await page.goto('/activities');
    await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(roomId);
    await page.getByRole('button', { name: 'Add activity', exact: true }).click();
    const composer = page.getByRole('form', { name: 'Schedule activity', exact: true });
    await composer.getByRole('button', { name: 'Choose ' + activityName, exact: true }).click();
    await composer.getByRole('button', { name: 'Add to day', exact: true }).click();
    const scheduled = page.getByRole('group', { name: 'Monday activity 1', exact: true });
    await expect(scheduled).toContainText(activityName);
    await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Leave your unsaved work?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(scheduled).toContainText(activityName);
    await page.route('**/api/schedule/plan', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 503,
        contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic save unavailable' }) });
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Save week', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: /Synthetic save unavailable|Could not save/ })).toBeVisible();
    await expect(scheduled).toContainText(activityName);
    await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).click();
    await dialog.getByRole('button', { name: 'Discard and leave', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

}
