import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, authenticatedApi, origin, recordStaffClock } from './auth-helpers';
import { billingData } from './billing-fixtures';
import { childLedger, statementApi, statementData, statementFixture, statementPage } from './ccrc-statement-fixtures';

async function fits(page: Page, width: number) {
  expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
  for (const element of await page.locator('main button:visible, main input:visible, main select:visible, main textarea:visible').all()) {
    const box = await element.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    if (await element.evaluate(element => element.matches('button,select'))) {
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  }
}

for (const width of [320, 390, 1280]) test(`review a two-page statement and register its child payments exactly once at ${width}px`, async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 1000 });
  const externalRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) externalRequests.push(url.origin);
  });
  const http = await authenticatedApi(page), fixture = await statementFixture(http);
  const before = await Promise.all(fixture.children.map(child => childLedger(http, child.child.id)));
  await page.goto('/billing');
  await page.getByRole('link', { name: 'Import CCRC statement', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CCRC statements', exact: true })).toBeVisible();
  await page.getByLabel('Choose statement file', { exact: true }).setInputFiles(fixture.file);
  const upload = page.waitForResponse(response => response.url() === statementApi && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Read statement', exact: true }).click();
  const uploaded = await statementData(await upload, 201);
  expect(uploaded.status).toBe('draft');
  expect(uploaded.extraction.pageCount).toBe(2);
  expect(uploaded.extraction.pages).toHaveLength(2);
  expect(uploaded.extraction.pages[1].text).toContain('Ben');
  expect(uploaded.extraction.lines.map(line => line.page)).toEqual([1, 2]);
  expect(uploaded.extraction.lines.map(line => line.amountCents)).toEqual([60000, 40000]);
  expect(uploaded.review.lines.every(line => !line.childId && !line.reviewed)).toBe(true);
  const form = page.getByRole('form', { name: 'Review CCRC statement', exact: true });
  await expect(form).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm and register payments', exact: true })).toBeDisabled();
  for (const [index, child] of fixture.children.entries()) expect(await childLedger(http, child.child.id)).toEqual(before[index]);

  const source = await page.request.get(statementApi + '/' + uploaded.id + '/content');
  expect(source.status()).toBe(200);
  expect(source.headers()['cache-control']).toContain('no-store');
  expect(source.headers()['content-disposition']).toContain('attachment');
  expect(await source.body()).toEqual(fixture.file.buffer);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original', exact: true }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(fixture.file.name);
  expect(await readFile((await downloaded.path())!)).toEqual(fixture.file.buffer);

  await form.getByLabel('Statement reference', { exact: true }).fill(fixture.file.reference);
  await form.getByLabel('Payment reference', { exact: true }).fill(fixture.file.reference);
  await form.getByLabel('Payment date', { exact: true }).fill(fixture.today);
  await form.getByLabel('Statement total ($)', { exact: true }).fill(width === 320 ? '999.99' : '1000.00');
  await expect(form.getByLabel('Number of pages', { exact: true })).toHaveValue('2');
  for (const [index, child] of fixture.children.entries()) {
    const number = index + 1;
    const row = form.getByRole('article', { name: 'Statement payment line ' + number, exact: true });
    await expect(row.getByRole('combobox', { name: 'Line ' + number + ' child', exact: true })).toHaveValue('');
    await row.getByRole('combobox', { name: 'Line ' + number + ' child', exact: true }).selectOption(child.child.id);
    await row.getByLabel('Line ' + number + ' service month', { exact: true }).fill(fixture.serviceMonth);
    await row.getByLabel('Line ' + number + ' amount paid ($)', { exact: true }).fill(index === 0 ? '600.00' : '400.00');
    await row.getByText('Different payment date or reference for this line', { exact: true }).click();
    await row.getByLabel('Line ' + number + ' payment date (optional)', { exact: true }).fill('');
    await row.getByLabel('Line ' + number + ' payment reference (optional)', { exact: true }).fill('');
    await row.getByLabel('Line ' + number + ' note (optional)', { exact: true }).fill('Checked synthetic source page ' + number);
    await row.getByRole('checkbox', { name: 'I checked line ' + number + ' against the original.', exact: true }).check();
  }
  await form.getByRole('checkbox', { name: 'I checked page 1 of the original statement.', exact: true }).check();
  await form.getByRole('checkbox', { name: 'I checked page 2 of the original statement.', exact: true }).check();
  await form.getByLabel('Reconciliation note', { exact: true }).fill('Synthetic fixture: both pages checked and service month and payment date corrected to the real fixture calendar.');
  await form.getByRole('checkbox', { name: 'I compared all payment lines and totals with the original statement.', exact: true }).check();
  async function saveReview() {
    const saved = page.waitForResponse(response => response.url() === statementApi + '/' + uploaded.id + '/review' && response.request().method() === 'PUT');
    await form.getByRole('button', { name: 'Save review', exact: true }).click();
    return statementData(await saved);
  }
  let reviewed = await saveReview();
  if (width === 320) {
    await expect(page.getByText('The included payment lines must add up to the statement total exactly.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm and register payments', exact: true })).toBeDisabled();
    for (const [index, child] of fixture.children.entries()) expect(await childLedger(http, child.child.id)).toEqual(before[index]);
    await form.getByLabel('Statement total ($)', { exact: true }).fill('1000.00');
    await form.getByRole('checkbox', { name: 'I compared all payment lines and totals with the original statement.', exact: true }).check();
    reviewed = await saveReview();
  }
  expect(reviewed.status).toBe('draft');
  expect(reviewed.review.lines.map(line => [line.childId, line.serviceMonth, line.amountCents])).toEqual(fixture.children.map((child, index) => [child.child.id, fixture.serviceMonth, index === 0 ? 60000 : 40000]));
  for (const [index, child] of fixture.children.entries()) expect(await childLedger(http, child.child.id)).toEqual(before[index]);
  await fits(page, width);
  if (width === 320) await page.screenshot({ path: test.info().outputPath('ccrc-review-320.png'), fullPage: true });

  await page.getByRole('checkbox', { name: 'I want to register these reviewed payments.', exact: true }).check();
  const posting = page.waitForResponse(response => response.url() === statementApi + '/' + uploaded.id + '/post' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm and register payments', exact: true }).click();
  const response = await posting, posted = await statementData(response);
  expect(posted.status).toBe('posted'); expect(posted.postedPayments).toHaveLength(2);
  await expect(page.getByRole('region', { name: 'Registered statement payments', exact: true })).toBeVisible();
  for (const [index, child] of fixture.children.entries()) {
    const ledger = await childLedger(http, child.child.id);
    expect(ledger.payments).toHaveLength(1);
    expect(ledger.payments[0]).toMatchObject({ payer: 'ccrc', date: fixture.today, amountCents: index === 0 ? 60000 : 40000,
      source: { statementId: uploaded.id, serviceMonth: fixture.serviceMonth, page: index + 1 } });
    expect(ledger.charges[0]).toMatchObject({ month: fixture.serviceMonth, pendingCcrc: true, payers: { family: { dueDate: null, overdue: false } } });
    expect(ledger.totals.awaitingCcrcCents).toBe(index === 0 ? 60000 : 80000);
  }
  const replayed = await statementData(await http.post(statementApi + '/' + uploaded.id + '/post', { data: response.request().postDataJSON() }));
  expect(replayed.version).toBe(posted.version); expect(replayed.postedPayments).toEqual(posted.postedPayments);
  const duplicate = await statementData(await http.post(statementApi, { data: {
    requestId: randomUUID(), file: { name: fixture.file.name, contentType: fixture.file.mimeType, dataBase64: fixture.file.buffer.toString('base64') },
  } }), 201);
  expect(duplicate.id).toBe(uploaded.id); expect(duplicate.status).toBe('posted');
  for (const child of fixture.children) expect((await childLedger(http, child.child.id)).payments).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Registered statement payments', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm and register payments', exact: true })).toHaveCount(0);
  await fits(page, width);
  expect(externalRequests, 'Statement review must not send documents or child data to another origin').toEqual([]);
});

test('cancelling a statement draft keeps its original and leaves both child ledgers unchanged', async ({ page }) => {
  test.setTimeout(90_000);
  const http = await authenticatedApi(page), fixture = await statementFixture(http);
  const before = await Promise.all(fixture.children.map(child => childLedger(http, child.child.id)));
  const uploaded = await statementData(await http.post(statementApi, { data: {
    requestId: randomUUID(), file: { name: fixture.file.name, contentType: fixture.file.mimeType, dataBase64: fixture.file.buffer.toString('base64') },
  } }), 201);
  await page.goto(statementPage + '?statement=' + uploaded.id);
  await expect(page.getByRole('form', { name: 'Review CCRC statement', exact: true })).toBeVisible();
  await page.getByText('Cancel this draft', { exact: true }).click();
  await page.getByLabel('Cancellation reason', { exact: true }).fill('Synthetic import cancelled before registering any payments.');
  const cancelled = page.waitForResponse(response => response.url() === statementApi + '/' + uploaded.id + '/cancel' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Cancel draft without payments', exact: true }).click();
  expect((await statementData(await cancelled)).status).toBe('cancelled');
  await expect(page.getByRole('button', { name: 'Reopen draft', exact: true })).toBeEnabled();
  for (const [index, child] of fixture.children.entries()) expect(await childLedger(http, child.child.id)).toEqual(before[index]);
  const source = await page.request.get(statementApi + '/' + uploaded.id + '/content');
  expect(source.status()).toBe(200); expect(await source.body()).toEqual(fixture.file.buffer);
  await page.reload();
  await expect(page.getByText('This draft is cancelled. Its original is retained and no payments were registered.', { exact: true })).toBeVisible();
});

test('editors, teachers and viewers cannot load statement pages, extracted text or original files', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const http = await authenticatedApi(page), fixture = await statementFixture(http);
  const uploaded = await statementData(await http.post(statementApi, { data: {
    requestId: randomUUID(), file: { name: fixture.file.name, contentType: fixture.file.mimeType, dataBase64: fixture.file.buffer.toString('base64') },
  } }), 201);
  const temporary = 'Synthetic statement temporary 20!', password = 'Synthetic statement changed 20!';
  const suffix = randomUUID().slice(0, 8);
  for (const role of ['editor', 'teacher', 'viewer']) {
    let staffMemberId: string | undefined;
    if (role === 'teacher') {
      const room = await billingData<{ id: string }>(await http.post(api + '/rooms', { data: { name: 'Statement class ' + suffix, ageMinMonths: 0, ageMaxMonths: 120, capacity: 20 } }), 201);
      const staff = await billingData<{ id: string }>(await http.post(api + '/staff', { data: { name: 'Statement teacher ' + suffix, role: 'Teacher', roomId: room.id } }), 201);
      staffMemberId = staff.id;
      await recordStaffClock(http, staff.id, 'checkin');
    }
    const username = role + '-statement-' + suffix;
    expect((await http.post(api + '/admin/accounts', { data: {
      username, displayName: 'Synthetic statement ' + role, role, password: temporary, ...(staffMemberId ? { staffMemberId } : { roomId: null }),
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
      const financeRequests: string[] = [];
      other.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/billing')) financeRequests.push(new URL(request.url()).pathname); });
      await other.goto(statementPage + '?statement=' + uploaded.id);
      await expect(other).toHaveURL(role === 'editor' ? /\/children$/ : /\/classroom$/);
      await expect(other.getByRole('link', { name: 'Import CCRC statement', exact: true })).toHaveCount(0);
      await expect(other.locator('body')).not.toContainText(fixture.file.reference);
      expect(financeRequests).toEqual([]);
      for (const endpoint of [statementApi, statementApi + '/' + uploaded.id, statementApi + '/' + uploaded.id + '/content']) {
        const denied = await other.request.get(endpoint);
        expect(denied.status()).toBe(403);
        expect(await denied.text()).not.toContain(fixture.file.reference);
      }
    } finally { await context.close(); }
  }
});
