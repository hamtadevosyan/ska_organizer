import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
export const api = 'http://127.0.0.1:3009/api';
export const origin = 'http://127.0.0.1:5179';
export const adminPassword = 'Synthetic browser passphrase 20!';
export async function signIn(page: Page, username = 'browser-admin', password = adminPassword) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
export async function authenticatedApi(page: Page) {
  const response = await page.request.post(`${api}/auth/login`, { headers: { Origin: origin }, data: { username: 'browser-admin', password: adminPassword } });
  expect(response.status()).toBe(200);
  const csrf = (await response.json()).csrfToken;
  const headers = { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  // Cookies are shared with this browser context; only the fixture wrapper supplies headers for direct API calls.
  return {
    get: (url: string) => page.request.get(url, { headers }),
    post: (url: string, options: { data: unknown }) => page.request.post(url, { ...options, headers }),
  };
}
