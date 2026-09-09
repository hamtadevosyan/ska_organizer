import { expect, test } from '@playwright/test';
import { api, origin, signIn } from './auth-helpers';

test('administrator creates an account, first sign-in changes its password, and sign-out rejects cookie replay', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  expect((await request.get(`${api}/meals`)).status()).toBe(401);
  await signIn(page);
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('browser-viewer');
  await page.getByLabel('Display name', { exact: true }).fill('Browser Viewer');
  await page.getByLabel('Access', { exact: true }).selectOption('viewer');
  await page.getByLabel('Temporary password', { exact: true }).fill('Browser temporary passphrase 20!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Account created.');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, 'browser-viewer', 'Browser temporary passphrase 20!');
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Meals', exact: true })).toHaveCount(0);
  await page.getByLabel('Current password', { exact: true }).fill('Browser temporary passphrase 20!');
  await page.getByLabel('New password', { exact: true }).fill('Browser changed passphrase 20!');
  await page.getByLabel('Confirm new password', { exact: true }).fill('Browser changed passphrase 20!');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await page.getByRole('link', { name: 'Meals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save Menu' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Meal Setup' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Accounts', exact: true })).toHaveCount(0);
  const session = await page.request.get(`${api}/auth/session`);
  const csrf = (await session.json()).csrfToken;
  const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === 'skao_session');
  const cookie = `skao_session=${cookies[0].value}`;
  expect((await page.request.post(`${api}/meals`, { headers: { Origin: origin, 'X-CSRF-Token': csrf }, data: { name: 'Forbidden', type: 'breakfast' } })).status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect((await request.get(`${api}/meals`, { headers: { Cookie: cookie } })).status()).toBe(401);
  expect(errors).toEqual([]);
});

test('an administrator disables a signed-in account and the next request clears its private screen', async ({ page, browser }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('browser-disabled');
  await page.getByLabel('Display name', { exact: true }).fill('Disable Example');
  await page.getByLabel('Temporary password', { exact: true }).fill('Disabled temporary passphrase 20!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Account created.');
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const other = await otherContext.newPage();
    await signIn(other, 'browser-disabled', 'Disabled temporary passphrase 20!');
    await other.getByLabel('Current password', { exact: true }).fill('Disabled temporary passphrase 20!');
    await other.getByLabel('New password', { exact: true }).fill('Disabled changed passphrase 20!');
    await other.getByLabel('Confirm new password', { exact: true }).fill('Disabled changed passphrase 20!');
    await other.getByRole('button', { name: 'Save password', exact: true }).click();
    await other.getByRole('link', { name: 'Meals', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Generate Menu' })).toBeEnabled();
    await page.getByLabel('Account', { exact: true }).selectOption({ label: 'Disable Example (browser-disabled)' });
    await page.getByLabel('Disabled', { exact: true }).check();
    page.once('dialog', (dialog) => { void dialog.accept(); });
    await page.getByRole('button', { name: 'Save account', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Account access updated.');
    await other.getByRole('button', { name: 'Generate Menu' }).click();
    await expect(other.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(other.getByRole('status')).toContainText('session has expired');
    await expect(other.getByRole('button', { name: 'Save Menu' })).toHaveCount(0);
  } finally { await otherContext.close(); }
});
