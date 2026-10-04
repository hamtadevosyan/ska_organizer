import { expect, test } from '@playwright/test';
import { authenticatedApi } from './auth-helpers';

for (const width of [390, 1280]) {
  test(`room create and edit validate ages at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await authenticatedApi(page, { freshSession: true });
    await page.goto('/rooms');
    await page.getByRole('button', { name: 'Add room', exact: true }).click();
    const name = 'Synthetic age check ' + width + '-' + Date.now();
    await page.getByLabel('Room name', { exact: true }).fill(name);
    await page.getByLabel('Configured capacity', { exact: true }).fill('1');
    for (const [minimum, maximum] of [['0', '0'], ['24', '24'], ['60', '24']]) {
      await page.getByLabel('Minimum age (months)', { exact: true }).fill(minimum);
      await page.getByLabel('Maximum age (months)', { exact: true }).fill(maximum);
      await page.getByRole('button', { name: 'Save room', exact: true }).click();
      await expect(page.getByLabel('Maximum age (months)', { exact: true })).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('article', { name, exact: true })).toHaveCount(0);
    }
    await page.getByLabel('Minimum age (months)', { exact: true }).fill('0');
    await page.getByLabel('Maximum age (months)', { exact: true }).fill('12');
    await page.getByRole('button', { name: 'Save room', exact: true }).click();
    const card = page.getByRole('article', { name, exact: true });
    await expect(card).toContainText('0–12 months');
    await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
    await page.getByLabel('Minimum age (months)', { exact: true }).fill('24');
    await page.getByLabel('Maximum age (months)', { exact: true }).fill('24');
    await page.getByRole('button', { name: 'Save room', exact: true }).click();
    await expect(page.getByLabel('Maximum age (months)', { exact: true })).toHaveAccessibleDescription('Maximum age must be greater than minimum age.');
    await expect(card).toContainText('0–12 months');
    await page.getByLabel('Maximum age (months)', { exact: true }).fill('60');
    await page.getByRole('button', { name: 'Save room', exact: true }).click();
    await expect(card).toContainText('24–60 months');
    await page.reload();
    await expect(card).toContainText('24–60 months');
  });
}
