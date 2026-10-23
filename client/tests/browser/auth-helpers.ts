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
      const cookies = (await page.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
      expect(cookies.length, 'Login must supply one fixture session cookie').toBe(1);
      // Every layout-test context, including the first login, uses a browser-
      // session copy. An absolute Expires imported from the request cookie jar
      // must not discard a valid fixture during a browser/API workflow.
      // The real server still enforces idle/absolute expiry and revocation;
      // remembered-login.spec.ts checks unmodified production cookie lifetimes.
      const fixtureCookies = cookies.map(cookie => ({ ...cookie, expires: -1 }));
      await page.context().addCookies(fixtureCookies);
      if (!freshSession) sharedAdminCookies = fixtureCookies;
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

// Linked employee fixtures enter through the same manager clock API used in
// production. Tests never disable or bypass the employee check-in requirement.
export async function recordStaffClock(http: Awaited<ReturnType<typeof authenticatedApi>>, staffId: string, action: 'checkin' | 'checkout') {
  const status = await http.get(api + '/work-time/clock');
  expect(status.status(), 'The administrator must be able to read the real staff clock').toBe(200);
  const person = (await status.json()).data.staff.find((item: { id: string }) => item.id === staffId) as { id: string; active: boolean; checkedIn: boolean; version: number } | undefined;
  expect(person, 'The linked staff fixture must exist in the real clock projection').toBeDefined();
  expect(person!.active).toBe(true); expect(person!.checkedIn).toBe(action === 'checkout');
  const response = await http.post(api + '/work-time/staff/' + staffId + '/clock', { data: { action, version: person!.version, requestId: globalThis.crypto.randomUUID() } });
  expect(response.status(), 'The fixture clock event must be authorized and persisted').toBe(200);
}
