import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { authenticatedApi } from './auth-helpers';

let sessionCookies: Awaited<ReturnType<BrowserContext['cookies']>>;
test.beforeAll(async ({ browser }) => {
  // Reuse one real fixture session for layout checks instead of making every
  // viewport consume another login attempt in the shared API's rate limit.
  const context = await browser.newContext();
  try {
    await authenticatedApi(await context.newPage());
    sessionCookies = await context.cookies();
  } finally { await context.close(); }
});
test.beforeEach(async ({ context }) => { await context.addCookies(sessionCookies); });

for (const width of [320, 375, 390, 430]) {
  test.describe(`mobile shell at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

    test('fits the phone, keeps navigation visible, and follows existing routes', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/dashboard');
      const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
      await expect(nav).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Desktop navigation' })).toBeHidden();
      await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('region', { name: 'Recent changes' })).toBeVisible();
      expect(await page.evaluate(() => window.innerWidth)).toBe(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const box = (await nav.boundingBox())!;
      for (const target of await nav.locator('a, button').all()) {
        const bounds = (await target.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      expect((await nav.boundingBox())!.y).toBe(box.y);
      const lastCard = (await page.getByRole('region', { name: 'Recent changes' }).boundingBox())!;
      expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(box.y);

      await nav.getByRole('link', { name: 'Children' }).click();
      await expect(page).toHaveURL(/\/children$/);
      await expect(nav.getByRole('link', { name: 'Children' })).toHaveAttribute('aria-current', 'page');
      await nav.getByRole('link', { name: 'Meals' }).click();
      await expect(page).toHaveURL(/\/meals$/);
      await expect(nav.getByRole('link', { name: 'Meals' })).toHaveAttribute('aria-current', 'page');
      await nav.getByRole('button', { name: 'More' }).click();
      const sheet = page.getByRole('dialog', { name: 'More', exact: true });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Accounts', exact: true })).toBeVisible();
      await sheet.getByRole('link', { name: 'Attendance', exact: true }).click();
      await expect(page).toHaveURL(/\/attendance$/);
      await expect(sheet).toHaveCount(0);
      await expect(nav.getByRole('button', { name: 'More' })).toHaveAttribute('aria-current', 'true');
      await page.reload();
      await expect(nav.getByRole('button', { name: 'More' })).toHaveAttribute('aria-current', 'true');
      await page.goBack();
      await expect(page).toHaveURL(/\/meals$/);
      await expect(nav.getByRole('link', { name: 'Meals' })).toHaveAttribute('aria-current', 'page');
      expect(errors).toEqual([]);
    });
  });
}

test('More contains keyboard focus, dismisses correctly, and handles account actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Sign out a separate session so the shared layout-test session stays valid.
  // Login deliberately revokes an incoming old session cookie, so clear it first.
  await page.context().clearCookies();
  await authenticatedApi(page);
  await page.goto('/children');
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  const more = nav.getByRole('button', { name: 'More' });
  await more.click();
  const sheet = page.getByRole('dialog', { name: 'More', exact: true });
  await expect(sheet.getByRole('button', { name: 'Close more' })).toBeFocused();
  for (let index = 0; index < 15; index++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await more.click();
  await page.mouse.click(8, 8);
  await expect(sheet).toHaveCount(0);

  await more.click();
  await sheet.getByRole('button', { name: 'Change password', exact: true }).click();
  const password = page.getByRole('dialog', { name: 'Account settings' });
  await expect(password.getByLabel('Current password')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  await password.getByRole('button', { name: 'Cancel', exact: true }).scrollIntoViewIfNeeded();
  await expect(password.getByRole('button', { name: 'Close account settings' })).toBeInViewport({ ratio: 1 });
  await password.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(password).toHaveCount(0);
  await more.click();
  await sheet.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(nav).toHaveCount(0);
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('resize and browser history cannot leave an invisible modal blocking the desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  await mobile.getByRole('link', { name: 'Children' }).click();
  await mobile.getByRole('button', { name: 'More' }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await mobile.getByRole('button', { name: 'More' }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(mobile).toBeHidden();
  const desktop = page.getByRole('navigation', { name: 'Desktop navigation' });
  await expect(desktop).toBeVisible();
  await desktop.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeFocused();
});

test('a mobile session expiry removes navigation and private page state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(nav).toBeVisible();
  await page.route('**/api/children**', (route) => route.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Sign in to continue.' } }),
  }));
  await nav.getByRole('link', { name: 'Children' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('session has expired');
  await expect(nav).toHaveCount(0);
});
