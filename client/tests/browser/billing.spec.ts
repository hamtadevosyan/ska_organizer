import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';
import { billingChild, billingData, billingDate } from './billing-fixtures';
import type { BillingDetail } from './billing-fixtures';

type ConfiguredDetail = BillingDetail & {
  profile: { enabled: boolean; familyCents: number; ccrcCents: number; pausedForEnrollment?: boolean; pausedOn?: string; billingStart: string } | null;
  pendingMonthlyCharges: number;
};

async function fits(page: Page, width: number) {
  const main = await page.locator('main').evaluate(element => ({ width: element.scrollWidth, viewport: window.innerWidth }));
  expect(main.width).toBeLessThanOrEqual(main.viewport + 1);
  const amounts = await page.locator('.billing-summary dd:visible').evaluateAll(elements => elements.map(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const boxes = [...range.getClientRects()];
    return { amount: element.textContent, lines: new Set(boxes.map(box => Math.round(box.top))).size,
      left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)) };
  }));
  for (const amount of amounts) {
    expect(amount.lines, 'The full monetary amount must stay on one readable line: ' + amount.amount).toBe(1);
    expect(amount.left).toBeGreaterThanOrEqual(0);
    expect(amount.right).toBeLessThanOrEqual(width + 1);
  }
  for (const button of await page.locator('.billing-page button:visible').all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
}

test('mobile tuition setup preserves charged months and pauses billing across enrollment changes', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 1000 });
  const http = await authenticatedApi(page), suffix = randomUUID().slice(0, 8);
  const created = await http.post(api + '/children', { data: {
    firstName: 'TuitionSetup' + suffix, lastName: 'Synthetic', dateOfBirth: '2023-01-01', roomId: null,
  } });
  expect(created.status()).toBe(201);
  const child = await created.json() as { id: string };
  const path = api + '/billing/children/' + child.id;
  const initial = await billingData<ConfiguredDetail>(await http.get(path));
  expect(initial.profile).toBeNull(); expect(initial.charges).toHaveLength(0);
  const month = initial.today.slice(0, 7);
  await page.goto('/billing?child=' + child.id);
  await page.getByRole('button', { name: 'Set up tuition', exact: true }).click();
  const setup = page.getByRole('form', { name: 'Billing setup', exact: true });
  await setup.getByLabel('Billing starts', { exact: true }).fill(month + '-01');
  await setup.getByLabel('Applies from month', { exact: true }).fill(month);
  await setup.getByLabel('Family monthly amount ($)', { exact: true }).fill('300.00');
  await setup.getByLabel('CCRC monthly amount ($)', { exact: true }).fill('700.00');
  await setup.getByLabel('Family due day', { exact: true }).fill('31');
  await setup.getByLabel('CCRC due day', { exact: true }).fill('31');
  await setup.getByLabel('Registration fee ($)', { exact: true }).fill('100.00');
  await setup.getByRole('checkbox', { name: 'Create monthly tuition charges', exact: true }).check();
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === path + '/profile');
  await setup.getByRole('button', { name: 'Save tuition setup', exact: true }).click();
  const first = await billingData<ConfiguredDetail>(await saved);
  expect(first.charges).toHaveLength(1);
  expect(first.charges[0]).toMatchObject({ kind: 'monthly', payers: { family: { amountCents: 30000 }, ccrc: { amountCents: 70000 } } });
  expect(first.charges.some(charge => charge.kind === 'registration')).toBe(false);
  await page.reload();
  await expect(page.getByRole('article', { name: 'Charge ' + first.charges[0].title, exact: true })).toBeVisible();
  const futureMonth = new Date(month + '-01T12:00:00Z'); futureMonth.setUTCMonth(futureMonth.getUTCMonth() + 1);
  await page.getByRole('button', { name: 'Edit tuition setup', exact: true }).click();
  await setup.getByLabel('Applies from month', { exact: true }).fill(futureMonth.toISOString().slice(0, 7));
  await setup.getByLabel('Family monthly amount ($)', { exact: true }).fill('400.00');
  await setup.getByLabel('CCRC monthly amount ($)', { exact: true }).fill('600.00');
  const edited = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === path + '/profile');
  await setup.getByRole('button', { name: 'Save tuition setup', exact: true }).click();
  const changed = await billingData<ConfiguredDetail>(await edited);
  expect(changed.profile).toMatchObject({ familyCents: 40000, ccrcCents: 60000 });
  expect(changed.charges).toEqual(first.charges);

  expect((await http.put(api + '/children/' + child.id + '/enrollment', { data: { active: false } })).status()).toBe(200);
  const ended = await billingData<ConfiguredDetail>(await http.get(path));
  expect(ended.profile).toMatchObject({ enabled: false, pausedForEnrollment: true, pausedOn: initial.today });
  expect(ended.charges).toEqual(first.charges);
  expect((await http.put(api + '/children/' + child.id + '/enrollment', { data: { active: true } })).status()).toBe(200);
  const reactivated = await billingData<ConfiguredDetail>(await http.get(path));
  expect(reactivated.profile).toMatchObject({ enabled: false, pausedForEnrollment: true });
  expect(reactivated.pendingMonthlyCharges).toBe(0);
  const checked = await billingData<ConfiguredDetail>(await http.post(path + '/generate', { data: {
    version: reactivated.version, requestId: randomUUID(), throughMonth: month,
  } }));
  expect(checked.profile?.enabled).toBe(false);
  expect(checked.charges).toEqual(first.charges);

  await page.reload();
  await page.getByRole('button', { name: 'Edit tuition setup', exact: true }).click();
  await expect(setup.getByLabel('Billing starts', { exact: true })).toHaveValue(initial.today);
  await expect(setup.getByRole('checkbox', { name: 'Create monthly tuition charges', exact: true })).not.toBeChecked();
  await setup.getByRole('checkbox', { name: 'Create monthly tuition charges', exact: true }).check();
  await setup.getByRole('checkbox', { name: 'I reviewed the new billing start and end dates before resuming tuition.', exact: true }).check();
  const resumed = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === path + '/profile');
  await setup.getByRole('button', { name: 'Save tuition setup', exact: true }).click();
  const renewed = await billingData<ConfiguredDetail>(await resumed);
  expect(renewed.profile).toMatchObject({ enabled: true, pausedForEnrollment: false, billingStart: initial.today });
  expect(renewed.charges).toEqual(first.charges);
  await fits(page, 320);
});

for (const width of [320, 390, 1280]) test(`registration, partial tuition payment and overdue balances persist at ${width}px`, async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width, height: 1000 });
  const http = await authenticatedApi(page);
  const fixture = await billingChild(http);
  const title = 'Registration ' + randomUUID().slice(0, 8);
  await page.goto('/billing?child=' + fixture.child.id);
  await expect(page.getByRole('heading', { name: 'Tuition & payments', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Billing child', exact: true })).toHaveValue(fixture.child.id);
  await page.getByRole('button', { name: 'Add registration fee', exact: true }).click();
  const registration = page.getByRole('form', { name: 'Add registration fee', exact: true });
  await registration.getByLabel('Fee name', { exact: true }).fill(title);
  await registration.getByLabel('Family amount ($)', { exact: true }).fill('100.00');
  await registration.getByLabel('CCRC amount ($)', { exact: true }).fill('200.00');
  await registration.getByLabel('Family due date', { exact: true }).fill(billingDate(fixture.detail.today, -5));
  await registration.getByLabel('CCRC due date', { exact: true }).fill(billingDate(fixture.detail.today, 30));
  await registration.getByLabel('Reason', { exact: true }).fill('Explicit synthetic enrollment fee');
  const charged = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === fixture.path + '/charges');
  await registration.getByRole('button', { name: 'Save registration fee', exact: true }).click();
  const savedCharge = await billingData<BillingDetail>(await charged);
  const charge = savedCharge.charges.find(value => value.title === title)!;
  expect(charge).toBeTruthy();
  expect(charge.payers.family).toMatchObject({ outstandingCents: 10000, daysOverdue: 5, overdue: true });
  expect(charge.payers.ccrc).toMatchObject({ outstandingCents: 20000, overdue: false });
  await expect(page.getByRole('article', { name: 'Charge ' + title, exact: true })).toBeVisible();
  await fits(page, width);

  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  const payment = page.getByRole('form', { name: 'Record payment', exact: true });
  await payment.getByRole('combobox', { name: 'Paid by', exact: true }).selectOption('family');
  await payment.getByLabel('Amount received ($)', { exact: true }).fill('40.00');
  await payment.getByLabel('Payment date', { exact: true }).fill(fixture.detail.today);
  await payment.getByLabel('Reference (optional)', { exact: true }).fill('Synthetic family receipt ' + width);
  await payment.getByRole('combobox', { name: 'Apply payment to', exact: true }).selectOption(charge.id);
  const paid = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === fixture.path + '/payments');
  await payment.getByRole('button', { name: 'Save payment', exact: true }).click();
  const paymentResponse = await paid;
  const payload = paymentResponse.request().postDataJSON();
  const firstPayment = await billingData<BillingDetail>(paymentResponse);
  expect(firstPayment.payments).toHaveLength(1);
  expect(firstPayment.charges.find(value => value.id === charge.id)?.payers.family).toMatchObject({ paidCents: 4000, outstandingCents: 6000, overdue: true });
  expect(firstPayment.charges.find(value => value.id === charge.id)?.payers.ccrc).toMatchObject({ paidCents: 0, outstandingCents: 20000, overdue: false });

  // Repeating the exact successful request must not credit the account twice.
  const replayed = await billingData<BillingDetail>(await http.post(fixture.path + '/payments', { data: payload }));
  expect(replayed.version).toBe(firstPayment.version);
  expect(replayed.payments).toHaveLength(1);
  expect(replayed.totals).toEqual(firstPayment.totals);
  await page.reload();
  const card = page.getByRole('article', { name: 'Charge ' + title, exact: true });
  await expect(card).toContainText('$60.00');
  await expect(card).toContainText('$200.00');
  await fits(page, width);
  if (width === 320 || width === 1280) await page.screenshot({ path: test.info().outputPath('billing-' + width + '.png'), fullPage: true });
  await page.goto('/dashboard');
  const alerts = page.getByRole('region', { name: 'Tuition overdue alerts', exact: true });
  await expect(alerts).toContainText(fixture.child.firstName);

  const current = await billingData<BillingDetail>(await http.get(fixture.path));
  const settled = await billingData<BillingDetail>(await http.post(fixture.path + '/payments', { data: {
    version: current.version, requestId: randomUUID(), payer: 'family', amountCents: 6000,
    date: current.today, method: 'cash', reference: 'Synthetic remaining family balance', chargeId: charge.id,
  } }));
  expect(settled.charges.find(value => value.id === charge.id)?.payers.family.outstandingCents).toBe(0);
  expect(settled.charges.find(value => value.id === charge.id)?.payers.ccrc.outstandingCents).toBe(20000);
  await page.reload();
  const resolvedAlerts = page.getByRole('region', { name: 'Tuition overdue alerts', exact: true });
  await expect(resolvedAlerts.getByText('No tuition payments are five days overdue.', { exact: true })).toBeVisible();
  await expect(resolvedAlerts).not.toContainText(fixture.child.firstName);
});

test('editors and class viewers cannot open tuition pages or receive financial data', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const http = await authenticatedApi(page);
  const { child, path } = await billingChild(http, 'PrivateBilling');
  const suffix = randomUUID().slice(0, 8);
  const temporary = 'Synthetic billing temporary 20!', password = 'Synthetic billing changed 20!';
  for (const role of ['editor', 'viewer']) {
    const username = role + '-billing-' + suffix;
    expect((await http.post(api + '/admin/accounts', { data: {
      username, displayName: role + ' Billing example', role, roomId: null, password: temporary,
    } })).status()).toBe(201);
    const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
    try {
      const other = await context.newPage();
      const login = await other.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporary } });
      expect(login.status()).toBe(200);
      const changed = await other.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await login.json()).csrfToken }, data: { currentPassword: temporary, password } });
      expect(changed.status()).toBe(200);
      const cookies = (await context.cookies(api)).filter(cookie => cookie.name === 'skao_session');
      await context.addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
      const financialRequests: string[] = [];
      other.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/billing')) financialRequests.push(new URL(request.url()).pathname); });
      await other.goto('/billing?child=' + child.id);
      await expect(other).toHaveURL(role === 'viewer' ? /\/classroom$/ : /\/children$/);
      await expect(other.getByRole('heading', { name: 'Tuition & payments', exact: true })).toHaveCount(0);
      await expect(other.getByRole('link', { name: 'Tuition', exact: true })).toHaveCount(0);
      await expect(other.getByRole('region', { name: 'Tuition overdue alerts', exact: true })).toHaveCount(0);
      expect(financialRequests).toEqual([]);
      for (const url of [api + '/billing', api + '/billing/alerts', path]) expect((await other.request.get(url)).status()).toBe(403);
    } finally { await context.close(); }
  }
});
