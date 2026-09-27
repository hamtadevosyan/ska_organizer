import { expect, test } from '@playwright/test';
import { authenticatedApi } from '../browser/auth-helpers';

test('Chromium reads the install manifest and each launcher icon from the production build', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const session = await context.newCDPSession(page);
  try {
    const result = await session.send('Page.getAppManifest');
    expect(result.url).toBe('http://127.0.0.1:5179/manifest.webmanifest');
    expect(result.errors).toEqual([]);
    const manifest = JSON.parse(result.data!);
    expect(manifest.name).toBe('Smart Kids Academy');
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/dashboard');
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons) {
      const response = await page.request.get(icon.src);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('image/png');
      const bytes = await response.body();
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  } finally { await session.detach(); }
  await page.getByRole('button', { name: 'App setup', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'App setup', exact: true });
  await expect(help.getByRole('img', { name: 'Smart Kids Academy app icon' })).toBeVisible();
  await help.getByRole('button', { name: 'iPhone / iPad' }).click();
  await expect(help.getByText('Open as Web App', { exact: true })).toBeVisible();
});

test('phone setup replaces More, fits at 320px and preserves the open child form', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await authenticatedApi(page, { freshSession: true });
  await page.goto('/children');
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  const draft = page.getByRole('form', { name: 'Add child', exact: true }).getByLabel('First name', { exact: true });
  await draft.fill('Synthetic unsaved draft');
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await page.getByRole('dialog', { name: 'More', exact: true }).getByRole('button', { name: 'App setup' }).click();
  const help = page.getByRole('dialog', { name: 'App setup', exact: true });
  await expect(help).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await help.getByRole('button', { name: 'iPhone / iPad' }).click();
  const widths = await help.evaluate(element => ({ content: element.scrollWidth, available: element.clientWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.available + 1);
  const box = await help.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  for (const button of await help.getByRole('button').all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(draft).toHaveValue('Synthetic unsaved draft');
});
