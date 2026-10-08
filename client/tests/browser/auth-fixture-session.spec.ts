import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, createAuthenticatedApi } from './auth-helpers';

test('cached fixture cookies survive clock-skewed exports but a revoked server session still fails', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const third = await browser.newContext();
  const authenticate = createAuthenticatedApi();
  let logins = 0;
  function instrument(page: Page, skewExport = false): Page {
    const context = page.context();
    // Only the exported metadata has an old Expires timestamp. The original
    // browser and backend still hold a valid real session, as when transferring
    // cookies between contexts whose clocks disagree. No auth endpoint is mocked.
    return {
      context: () => ({
        addCookies: context.addCookies.bind(context),
        clearCookies: context.clearCookies.bind(context),
        cookies: async (urls?: string | string[]) => (await context.cookies(urls)).map(cookie =>
          skewExport ? { ...cookie, expires: 1 } : cookie),
      }),
      request: {
        get: page.request.get.bind(page.request),
        put: page.request.put.bind(page.request),
        post: async (...args: Parameters<Page['request']['post']>) => {
          if (args[0] === `${api}/auth/login`) logins++;
          return page.request.post(...args);
        },
      },
    } as unknown as Page;
  }
  try {
    await authenticate(instrument(await first.newPage(), true));
    const other = await second.newPage();
    const http = await authenticate(instrument(other));
    const cookies = (await second.cookies(api)).filter(cookie => cookie.name === 'skao_session');
    expect(cookies.length).toBe(1);
    expect(cookies[0].expires, 'Transferred fixture cookies live only in this context; the backend keeps real expiry').toBe(-1);
    expect((await http.get(`${api}/auth/session`)).status()).toBe(200);
    expect(logins).toBe(1);
    expect((await http.post(`${api}/auth/logout`, { data: {} })).status()).toBe(204);
    await expect(authenticate(instrument(await third.newPage()))).rejects.toThrow(/browser fixture session must remain valid.*SESSION_EXPIRED/);
    expect(logins, 'A rejected cached session must not be hidden by an automatic login').toBe(1);
  } finally {
    await first.close(); await second.close(); await third.close();
  }
});
