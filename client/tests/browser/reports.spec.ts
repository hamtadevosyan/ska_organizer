import { test, expect } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

test('reports reconcile visits and receipts, keep filters in print and CSV, and never change stock', async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const client = await authenticatedApi(page); const suffix = String(Date.now());
  const configResponse = await client.get(api + '/reports/config');
  expect(configResponse.status()).toBe(200); const config = await configResponse.json();
  const roomResponse = await client.post(api + '/rooms', { data: { name: 'Reports room ' + suffix,
    capacity: 12, ageMinMonths: 0, ageMaxMonths: 72 } });
  expect(roomResponse.status()).toBe(201); const room = (await roomResponse.json()).data;
  const childResponse = await client.post(api + '/children', { data: { firstName: 'Reports', lastName: suffix,
    dateOfBirth: '2023-01-01', roomId: room.id, active: true } });
  expect(childResponse.status()).toBe(201);
  const child = await childResponse.json(); // This API returns the child directly, without a data wrapper.
  expect(child).toMatchObject({ id: expect.any(String), roomId: room.id });
  const arrival = await client.post(api + '/attendance/checkin', { data: { childId: child.id, roomId: room.id } });
  expect(arrival.status()).toBe(201); const visit = await arrival.json();
  expect((await client.post(api + '/attendance/' + visit.id + '/checkout', { data: { version: visit.version } })).status()).toBe(200);
  const stockResponse = await client.post(api + '/inventory', { data: { name: 'Reports paper ' + suffix, category: 'Art supplies',
    location: 'Reports shelf', unit: 'pack', openingQuantity: '0', reorderThreshold: '0', reason: 'Initial count', requestId: 'reports-stock-' + suffix } });
  expect(stockResponse.status()).toBe(201); let stock = (await stockResponse.json()).data;
  // A historical date isolates these rows from the shared browser fixture's current receipts.
  const receivedOn = '2020-02-29';
  for (const [index, cost] of ['12.30', null].entries()) {
    const saved = await client.post(api + '/inventory/' + stock.id + '/purchases', { data: { quantity: '2', unit: stock.unit,
      version: stock.version, totalCost: cost, supplier: '=1+1', receivedOn, requestId: 'reports-receipt-' + suffix + '-' + index } });
    expect(saved.status()).toBe(201); stock = (await saved.json()).data.item;
  }
  await page.goto('/reports');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByLabel('Room', { exact: true }).selectOption(room.id);
  const visible = page.getByTestId('screen-report');
  await expect(visible.getByRole('row').filter({ hasText: 'Reports ' + suffix })).toContainText('Checked out');
  await expect(page.getByRole('region', { name: 'Report results' })).toContainText(config.today + ' to ' + config.today + ' · ' + room.name);
  const attendanceCsv = page.waitForResponse((response) => response.url().includes('/reports/attendance.csv') && response.status() === 200);
  const attendanceDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const csvResponse = await attendanceCsv;
  expect(new URL(csvResponse.url()).searchParams.get('roomId')).toBe(room.id);
  expect(await csvResponse.text()).toContain('"Room","' + room.name + '"');
  expect(await csvResponse.text()).toContain('"Facility time zone","' + config.timeZone + '"');
  expect((await attendanceDownload).suggestedFilename()).toBe('attendance-' + config.today + '-to-' + config.today + '.csv');
  await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printCalled = 'true'; }; });
  await page.getByRole('button', { name: 'Print report', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-print-called', 'true');
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('printed-report')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Report filters' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Purchases', exact: true }).click();
  await page.getByLabel('From', { exact: true }).fill(receivedOn);
  await page.getByLabel('To', { exact: true }).fill(receivedOn);
  const purchaseRows = visible.getByRole('row').filter({ hasText: stock.name });
  await expect(purchaseRows).toHaveCount(2);
  await expect(purchaseRows.filter({ hasText: '12.30' })).toHaveCount(1);
  await expect(purchaseRows.filter({ hasText: 'Not recorded' })).toHaveCount(1);
  const purchaseCsv = page.waitForResponse((response) => response.url().includes('/reports/purchases.csv') && response.status() === 200);
  const purchaseDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const exported = await purchaseCsv;
  expect(new URL(exported.url()).searchParams.has('roomId')).toBe(false);
  expect(await exported.text()).toContain('"From","' + receivedOn + '"');
  expect(await exported.text()).toContain('"\'=1+1"');
  expect(await exported.text()).toContain('"12.30"');
  expect(await exported.text()).toContain('"Not recorded"');
  expect((await purchaseDownload).suggestedFilename()).toBe('purchases-' + receivedOn + '-to-' + receivedOn + '.csv');
  const after = await client.get(api + '/inventory/' + stock.id);
  expect((await after.json()).data.quantity).toBe(stock.quantity);
  await page.reload();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByLabel('Room', { exact: true }).selectOption(room.id);
  await expect(visible.getByRole('row').filter({ hasText: 'Reports ' + suffix })).toContainText('Checked out');
  expect(errors).toEqual([]);
});
