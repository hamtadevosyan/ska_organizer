import { expect, test, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, origin, adminPassword } from './auth-helpers';

// Real browser profile persistence, using only the isolated synthetic backend.
// Do not export storageState, session credentials or profile files as artifacts.
test('remembered login survives closing and reopening the browser profile; logout revokes it', async ({ request }) => {
  const profile = await mkdtemp(join(tmpdir(), 'skao-remembered-browser-'));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, baseURL: origin });
    let page = await context.newPage();
    await page.goto('/');
    const box = page.getByRole('checkbox', { name: 'Keep me signed in' });
    await expect(box).not.toBeChecked();
    await page.getByLabel('Username', { exact: true }).fill('browser-admin');
    await page.getByLabel('Password', { exact: true }).fill(adminPassword);
    await box.check();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const cookie = (await context.cookies(api)).find(cookie => cookie.name === 'skao_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(29 * 86400);
    await context.close();
    context = await chromium.launchPersistentContext(profile, { headless: true, baseURL: origin });
    page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toHaveCount(0);
    // localStorage contains only the existing non-secret cross-tab notification.
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.every(key => key === 'skao-account-changed')).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Keep me signed in' })).not.toBeChecked();
    expect((await request.get(`${api}/auth/session`, { headers: { Cookie: `skao_session=${cookie.value}` } })).status()).toBe(401);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('unchecked mobile sign-in retains the ordinary cookie lifetime', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('checkbox', { name: 'Keep me signed in' })).not.toBeChecked();
  await page.getByLabel('Username', { exact: true }).fill('browser-admin');
  await page.getByLabel('Password', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
  const cookie = (await page.context().cookies(api)).find(cookie => cookie.name === 'skao_session')!;
  expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(7.9 * 3600);
  expect(cookie.expires - Date.now() / 1000).toBeLessThanOrEqual(8 * 3600);
});
