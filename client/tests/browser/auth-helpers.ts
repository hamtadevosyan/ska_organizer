import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
export const api = 'http://127.0.0.1:3009/api';
export const origin = 'http://127.0.0.1:5179';
export const adminPassword = 'Synthetic browser passphrase 20!';
// Domain/layout checks share one real fixture session per Playwright worker.
// Keep it in memory only. Authentication/logout cases use separate sessions.
let sharedAdminCookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;

export async function signIn(page: Page, username = 'browser-admin', password = adminPassword) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const signedIn = page.waitForResponse(response => response.url() === `${api}/auth/login` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await signedIn).status(), 'Fixture sign-in must succeed before checking the destination screen').toBe(200);
}
export async function authenticatedApi(page: Page, { freshSession = false } = {}) {
  if (!freshSession && sharedAdminCookies) {
    await page.context().addCookies(sharedAdminCookies);
  } else {
    // A real login revokes an incoming old session. Do not revoke the cached
    // session when a test asks for its own disposable sign-out session.
    await page.context().clearCookies({ name: 'skao_session' });
    const response = await page.request.post(`${api}/auth/login`, { headers: { Origin: origin }, data: { username: 'browser-admin', password: adminPassword } });
    expect(response.status(), 'The isolated browser fixture must accept the administrator login').toBe(200);
    if (!freshSession) sharedAdminCookies = await page.context().cookies(api);
  }
  // Still validate the cookie through the real API and use its current CSRF
  // token. Reusing a session must not hide expiry or authorization failures.
  const session = await page.request.get(`${api}/auth/session`, { headers: { Origin: origin } });
  expect(session.status(), 'The browser fixture session must remain valid').toBe(200);
  const csrf = (await session.json()).csrfToken;
  const headers = { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  // Cookies are shared with this browser context; only the fixture wrapper supplies headers for direct API calls.
  return {
    get: (url: string) => page.request.get(url, { headers }),
    put: (url: string, options: { data: unknown }) => page.request.put(url, { ...options, headers }),
    post: (url: string, options: { data: unknown }) => page.request.post(url, { ...options, headers }),
  };
}
