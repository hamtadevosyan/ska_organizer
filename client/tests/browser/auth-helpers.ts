import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
export const api = 'http://127.0.0.1:3009/api';
export const origin = 'http://127.0.0.1:5179';
export const adminPassword = 'Synthetic browser passphrase 20!';

export async function signIn(page: Page, username = 'browser-admin', password = adminPassword) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const signedIn = page.waitForResponse(response => response.url() === `${api}/auth/login` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await signedIn).status(), 'Fixture sign-in must succeed before checking the destination screen').toBe(200);
}
// Domain/layout checks share a real fixture session per Playwright worker.
// Keep credentials in memory. A factory lets lifecycle regressions use their
// own cache without signing out the session used by unrelated screen checks.
export function createAuthenticatedApi() {
  let sharedAdminCookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;
  return async function authenticatedApi(page: Page, { freshSession = false } = {}) {
    if (!freshSession && sharedAdminCookies) {
      await page.context().addCookies(sharedAdminCookies);
    } else {
      // Do not revoke the cached session when a test needs a disposable login.
      await page.context().clearCookies({ name: 'skao_session' });
      const response = await page.request.post(`${api}/auth/login`, { headers: { Origin: origin }, data: { username: 'browser-admin', password: adminPassword } });
      expect(response.status(), 'The isolated browser fixture must accept the administrator login').toBe(200);
      if (!freshSession) {
        const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
        expect(cookies.length, 'Login must supply one fixture session cookie').toBe(1);
        // Only transferred layout-test copies are browser-session cookies.
        // Importing an absolute Expires from another context/clock must not
        // discard the fixture before the real backend can validate it. The
        // server still enforces its original idle/absolute expiry and revocation.
        // Real cookie lifetimes remain covered by remembered-login.spec.ts.
        sharedAdminCookies = cookies.map(cookie => ({ ...cookie, expires: -1 }));
      }
    }
    const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
    expect(cookies.length, 'The browser fixture cookie must be installed before checking its session').toBe(1);
    const session = await page.request.get(`${api}/auth/session`, { headers: { Origin: origin } });
    let reason = '';
    if (session.status() !== 200) {
      const body = await session.json().catch(() => null);
      // Diagnose auth failure without printing cookies, tokens or response data.
      if (['AUTH_REQUIRED', 'SESSION_EXPIRED'].includes(body?.error?.code)) reason = ` (${body.error.code})`;
    }
    // A 401 is a failure. Never silently reauthenticate an expired/revoked cache.
    expect(session.status(), 'The browser fixture session must remain valid' + reason).toBe(200);
    const csrf = (await session.json()).csrfToken;
    const headers = { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
    return {
      get: (url: string) => page.request.get(url, { headers }),
      put: (url: string, options: { data: unknown }) => page.request.put(url, { ...options, headers }),
      post: (url: string, options: { data: unknown }) => page.request.post(url, { ...options, headers }),
    };
  };
}
export const authenticatedApi = createAuthenticatedApi();
