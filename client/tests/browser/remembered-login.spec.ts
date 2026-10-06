import { expect, test, chromium } from '@playwright/test';
import type { Response } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, origin, adminPassword } from './auth-helpers';

async function expectSessionLifetime(response: Response, seconds: number) {
  expect(response.status(), 'The real fixture login must succeed').toBe(200);
  const sessionHeaders = (await response.headerValues('set-cookie')).filter(value => value.startsWith('skao_session='));
  // Assert counts and public attributes separately so failures never print the session value.
  expect(sessionHeaders.length, 'Login must issue exactly one session cookie').toBe(1);
  const maxAges = sessionHeaders[0].split(';').slice(1).map(value => value.trim()).filter(value => /^max-age=/i.test(value));
  expect(maxAges.length, 'The session cookie must specify exactly one lifetime').toBe(1);
  expect(maxAges[0]).toMatch(/^max-age=\d+$/i);
  expect(Number(maxAges[0].slice('max-age='.length)), 'The login response must retain the configured lifetime').toBe(seconds);
}

// Real browser profile persistence, using only the isolated synthetic backend.
// Do not export storageState, session credentials or profile files as artifacts.
test('remembered login survives closing and reopening the browser profile; logout revokes it', async ({ request, launchOptions }) => {
  const profile = await mkdtemp(join(tmpdir(), 'skao-remembered-browser-'));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { ...launchOptions, headless: true, baseURL: origin });
    let page = await context.newPage();
    await page.goto('/');
    const box = page.getByRole('checkbox', { name: 'Keep me signed in' });
    await expect(box).not.toBeChecked();
    await page.getByLabel('Username', { exact: true }).fill('browser-admin');
    await page.getByLabel('Password', { exact: true }).fill(adminPassword);
    await box.check();
    const loggedIn = page.waitForResponse(response => response.url() === `${api}/auth/login` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expectSessionLifetime(await loggedIn, 30 * 86400);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const cookie = (await context.cookies(api)).find(cookie => cookie.name === 'skao_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/api');
    expect(cookie.expires).toBeGreaterThan(0);
    // Cookie expiry and the page clock belong to the same browser. The runner's
    // Node clock can differ in a virtualized or instrumented test environment.
    const remaining = cookie.expires - await page.evaluate(() => Date.now() / 1000);
    expect(remaining).toBeGreaterThan(29 * 86400);
    expect(remaining).toBeLessThanOrEqual(30 * 86400);
    await context.close();
    context = await chromium.launchPersistentContext(profile, { ...launchOptions, headless: true, baseURL: origin });
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
  const loggedIn = page.waitForResponse(response => response.url() === `${api}/auth/login` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectSessionLifetime(await loggedIn, 8 * 3600);
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
  const cookie = (await page.context().cookies(api)).find(cookie => cookie.name === 'skao_session')!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  expect(cookie.path).toBe('/api');
  expect(cookie.expires).toBeGreaterThan(0);
  const remaining = cookie.expires - await page.evaluate(() => Date.now() / 1000);
  expect(remaining).toBeGreaterThan(7.9 * 3600);
  expect(remaining).toBeLessThanOrEqual(8 * 3600);
});
