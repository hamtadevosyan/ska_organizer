import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';
async function data<T>(response: APIResponse, status = 200): Promise<T> { expect(response.status(), await response.text()).toBe(status); return (await response.json()).data as T; }
type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type PayReviewDetail = {
  profile: { version: number; rules: { mode: string; workweekStart: number; confirmed: boolean; reference: string; dailyScheduledMinutes: number } };
  ledger: { version: number; days: { date: string; review: { state: string; suggestedPaidMillis: number; requiresOvertimeReview?: boolean; reasons: { code: string; message: string; action: string }[] } }[] };
};
async function configurePay(http: Http, staffId: string) {
  const base = api + '/payroll/staff/' + staffId;
  let detail = await data<PayReviewDetail>(await http.get(base));
  await data(await http.post(base + '/rates', { data: { version: detail.profile.version, effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic effective rate for direct review' } }));
  detail = await data<PayReviewDetail>(await http.get(base));
  await data(await http.post(base + '/profile', { data: { version: detail.profile.version, rules: { ...detail.profile.rules, confirmed: true, reference: 'Synthetic payroll reviewer checked applicable rules' }, reason: 'Synthetic reviewed rules for direct review' } }));
}
type ScheduledWorkDay = {
  staffId: string; date: string; plannedStart: string | null; plannedEnd: string | null; plannedMinutes: number;
  checkin: string; checkout: string; paidMillis: number; outsideMillis: number; status: string; reason: string;
};
type WorkSchedule = {
  today: string; timeZone: string; items: ScheduledWorkDay[];
  staff: { id: string; scheduleVersion: number; entries: { startTime?: string; endTime?: string; minutes: number; effectiveOn: string; reason: string }[] }[];
};
for (const width of [320, 390]) test(`approved start and end times persist and flag short work outside the window at ${width}px`, async ({ page, browser }) => {
  test.setTimeout(90_000);
  const http = await authenticatedApi(page);
  const suffix = randomUUID().slice(0, 8);
  const employee = await data<{ id: string; name: string }>(await http.post(api + '/staff', { data: { name: 'Approved window ' + suffix, role: 'Other' } }), 201);
  const temporary = 'Synthetic window temporary 20!', password = 'Synthetic window changed 20!';
  for (const role of ['editor', 'teacher']) await data(await http.post(api + '/admin/accounts', { data: {
    username: 'window-' + role + '-' + suffix, displayName: role + ' Window example', role, password: temporary,
    ...(role === 'teacher' ? { staffMemberId: employee.id } : {}),
  } }), 201);
  const editorContext = await browser.newContext({ viewport: { width, height: 1000 } });
  const teacherContext = await browser.newContext({ viewport: { width, height: 1000 } });
  try {
    const editor = await editorContext.newPage(), teacher = await teacherContext.newPage();
    editor.setDefaultTimeout(10_000);
    async function login(accountPage: typeof editor, role: string) {
      const response = await accountPage.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username: 'window-' + role + '-' + suffix, password: temporary, rememberMe: true } });
      expect(response.status()).toBe(200);
      const changed = await accountPage.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await response.json()).csrfToken }, data: { currentPassword: temporary, password } });
      expect(changed.status()).toBe(200);
      const cookies = (await accountPage.context().cookies(api)).filter(cookie => cookie.name === 'skao_session');
      await accountPage.context().addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
      return { Origin: origin, 'X-CSRF-Token': (await changed.json()).csrfToken };
    }
    await login(editor, 'editor');
    const headers = await login(teacher, 'teacher');
    const initialResponse = await editor.request.get(api + '/work-time');
    const initial = await data<WorkSchedule>(initialResponse);
    // Use the fixture server's current facility clock, so this works at any time of day.
    const serverNow = new Date(initialResponse.headers().date);
    expect(Number.isFinite(serverNow.getTime())).toBe(true);
    const localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: initial.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(serverNow));
    const outsideStart = localHour < 12 ? '16:00' : '08:00', outsideEnd = localHour < 12 ? '17:00' : '09:00';
    const outsideLabel = localHour < 12 ? '4:00 PM–5:00 PM' : '8:00 AM–9:00 AM';

    await editor.goto('/staff/work-time');
    await editor.getByRole('combobox', { name: 'Work-time employee', exact: true }).selectOption(employee.id);
    await editor.getByLabel('Approved start time', { exact: true }).fill('08:00');
    await editor.getByLabel('Approved end time', { exact: true }).fill('17:00');
    await expect(editor.getByText('8:00 AM–5:00 PM · 9 hr scheduled. No automatic deductions.', { exact: true })).toBeVisible();
    await editor.getByLabel('Effective date', { exact: true }).fill(initial.today);
    await editor.getByLabel('Reason for schedule change', { exact: true }).fill('Agreed 8 AM to 5 PM schedule');
    await editor.getByRole('button', { name: 'Save approved schedule', exact: true }).click();
    await expect(editor.getByLabel('Reason for schedule change', { exact: true })).toHaveValue('');
    await editor.reload();
    await editor.getByRole('combobox', { name: 'Work-time employee', exact: true }).selectOption(employee.id);
    await expect(editor.getByLabel('Approved start time', { exact: true })).toHaveValue('08:00');
    await expect(editor.getByLabel('Approved end time', { exact: true })).toHaveValue('17:00');
    await editor.getByText('Schedule history', { exact: true }).click();
    await expect(editor.getByRole('listitem').filter({ hasText: 'Agreed 8 AM to 5 PM schedule' })).toContainText('8:00 AM–5:00 PM');
    const saved = await data<WorkSchedule>(await editor.request.get(api + '/work-time'));
    expect(saved.staff.find(person => person.id === employee.id)?.entries).toMatchObject([
      { startTime: '08:00', endTime: '17:00', minutes: 540, effectiveOn: initial.today, reason: 'Agreed 8 AM to 5 PM schedule' },
    ]);

    // Save a different window before this employee's first clock, then record only a few real milliseconds.
    await editor.getByLabel('Approved start time', { exact: true }).fill(outsideStart);
    await editor.getByLabel('Approved end time', { exact: true }).fill(outsideEnd);
    await editor.getByLabel('Reason for schedule change', { exact: true }).fill('Approved window for outside-time review');
    await editor.getByRole('button', { name: 'Save approved schedule', exact: true }).click();
    await expect(editor.getByLabel('Reason for schedule change', { exact: true })).toHaveValue('');
    await data(await teacher.request.post(api + '/time-clock', { headers, data: { action: 'checkin', version: 0, requestId: randomUUID() } }));
    const own = await data<{ version: number; checkedIn: boolean }>(await teacher.request.get(api + '/time-clock'));
    await data(await teacher.request.post(api + '/time-clock', { headers, data: { action: 'checkout', version: own.version, requestId: randomUUID() } }));
    const recorded = await data<WorkSchedule>(await editor.request.get(api + '/work-time'));
    const day = recorded.items.find(item => item.staffId === employee.id && item.date === initial.today)!;
    expect(day).toMatchObject({ plannedStart: outsideStart, plannedEnd: outsideEnd, plannedMinutes: 60, status: 'pending' });
    expect(day.paidMillis).toBeGreaterThan(0);
    expect(day.paidMillis).toBeLessThan(day.plannedMinutes * 60_000);
    expect(day.outsideMillis).toBe(day.paidMillis);

    await editor.getByRole('button', { name: 'Refresh work time', exact: true }).click();
    const dayLog = editor.getByRole('article', { name: employee.name + ' time on ' + initial.today, exact: true });
    await expect(dayLog.getByText('Needs manager review', { exact: true })).toBeVisible();
    await expect(dayLog.getByText('Approved schedule', { exact: true }).locator('..').locator('dd')).toHaveText(outsideLabel);
    const localClock = (instant: string) => new Date(instant).toLocaleTimeString('en-US', { timeZone: initial.timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit' });
    await expect(dayLog.getByText('Actual check-in', { exact: true }).locator('..').locator('dd')).toHaveText(localClock(day.checkin));
    await expect(dayLog.getByText('Actual checkout', { exact: true }).locator('..').locator('dd')).toHaveText(localClock(day.checkout));
    await expect(dayLog.getByText('Time outside approved schedule', { exact: true })).toBeVisible();

    // The pay screen explains the outside-window issue before opening any review form.
    await configurePay(http, employee.id);
    const payDetail = await data<PayReviewDetail>(await http.get(api + '/payroll/staff/' + employee.id));
    const payDay = payDetail.ledger.days.find(item => item.date === initial.today)!;
    const outsideReason = payDay.review.reasons.find(reason => reason.action === 'work-time')!;
    expect(outsideReason).toBeTruthy();
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/staff/payroll');
    await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(employee.id);
    await page.getByLabel('Pay period start', { exact: true }).fill(initial.today);
    await page.getByLabel('Pay period end', { exact: true }).fill(initial.today);
    const payCard = page.getByRole('article', { name: 'Pay review for ' + initial.today, exact: true });
    await expect(payCard.getByText('Needs attention', { exact: true })).toBeVisible();
    await expect(payCard.getByText(outsideReason.message, { exact: true })).toBeVisible();
    await expect(payCard.getByText('Approved schedule', { exact: true }).locator('..').locator('dd')).toHaveText(outsideLabel);
    await expect(payCard.getByText('Actual check-in', { exact: true }).locator('..').locator('dd')).toHaveText(localClock(day.checkin));
    await expect(payCard.getByText('Actual checkout', { exact: true }).locator('..').locator('dd')).toHaveText(localClock(day.checkout));
    await expect(payCard.getByRole('button', { name: 'Approve recorded hours for ' + initial.today, exact: true })).toHaveCount(0);
    const outsideAction = payCard.getByRole('link', { name: 'Review outside time for ' + initial.today, exact: true });
    await expect(outsideAction).toHaveAttribute('href', '/staff/work-time?staff=' + employee.id + '&date=' + initial.today);
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
    if (width === 320) await payCard.screenshot({ path: test.info().outputPath('visible-outside-pay-review.png') });
    await outsideAction.click();
    await expect(page.getByRole('combobox', { name: 'Work-time employee', exact: true })).toHaveValue(employee.id);
    await expect(page.getByRole('article', { name: employee.name + ' time on ' + initial.today, exact: true })).toBeVisible();

    expect((await editor.request.get(api + '/payroll/staff/' + employee.id)).status()).toBe(403);
    await expect(editor.getByRole('navigation', { name: 'Staff sections' }).getByRole('link', { name: 'Pay & time', exact: true })).toHaveCount(0);
    const review = editor.getByRole('article').filter({ has: editor.getByRole('heading', { name: employee.name + ' · ' + initial.today, exact: true }) });
    await review.getByLabel('Extra-work review note', { exact: true }).fill('Manager verified the actual work outside the approved window');
    await review.getByRole('button', { name: 'Confirm extra time was worked', exact: true }).click();
    await expect(dayLog.getByText('Outside time confirmed', { exact: true })).toBeVisible();
    const reviewed = await data<WorkSchedule>(await editor.request.get(api + '/work-time'));
    expect(reviewed.items.find(item => item.staffId === employee.id && item.date === initial.today)).toMatchObject({
      plannedStart: outsideStart, plannedEnd: outsideEnd, checkin: day.checkin, checkout: day.checkout,
      paidMillis: day.paidMillis, outsideMillis: day.outsideMillis, status: 'confirmed',
      reason: 'Manager verified the actual work outside the approved window',
    });
    // Operational confirmation by an editor cannot approve overtime pay for an administrator.
    const needsAdminReview = await data<PayReviewDetail>(await http.get(api + '/payroll/staff/' + employee.id));
    const reviewedDay = needsAdminReview.ledger.days.find(item => item.date === initial.today)!;
    expect(reviewedDay.review.requiresOvertimeReview).toBe(true);
    // This synthetic short clock is proposed as one paid hour, while the
    // original few milliseconds outside the window still require review.
    const roundedWorkMillis = reviewedDay.review.suggestedPaidMillis;
    expect(roundedWorkMillis).toBe(3600000);
    await page.goto('/staff/payroll');
    await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(employee.id);
    await page.getByLabel('Pay period start', { exact: true }).fill(initial.today);
    await page.getByLabel('Pay period end', { exact: true }).fill(initial.today);
    const manualCard = page.getByRole('article', { name: 'Pay review for ' + initial.today, exact: true });
    const premium = manualCard.getByLabel('Additional pay for ' + initial.today + ' ($)', { exact: true });
    const approval = manualCard.getByRole('button', { name: 'Approve reviewed pay for ' + initial.today, exact: true });
    await expect(premium).toHaveValue('');
    await expect(manualCard.getByLabel('I reviewed overtime and additional pay for ' + initial.today + '.', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel(/Overtime hours at 1\.5/)).toHaveCount(0);
    await expect(page.getByLabel('Double-time hours', { exact: true })).toHaveCount(0);
    const approvalWrites: unknown[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url() === api + '/payroll/staff/' + employee.id + '/approvals') approvalWrites.push(request.postDataJSON()); });
    await approval.click();
    expect(approvalWrites).toHaveLength(0);
    await premium.fill('12.34');
    await manualCard.getByLabel('Pay review reason for ' + initial.today, { exact: true }).fill('Administrator explicitly reviewed the outside work and entered this additional amount');
    await expect(manualCard.getByLabel('I checked the hours and overtime for ' + initial.today + '.', { exact: true })).toHaveCount(0);
    await approval.click();
    expect(approvalWrites).toHaveLength(0);
    await manualCard.getByLabel('I reviewed overtime and additional pay for ' + initial.today + '.', { exact: true }).check();
    const savedApproval = page.waitForResponse(response => response.url() === api + '/payroll/staff/' + employee.id + '/approvals' && response.request().method() === 'POST');
    await approval.click();
    expect((await savedApproval).status()).toBe(200);
    expect(approvalWrites).toEqual([expect.objectContaining({ mode: 'manual-reviewed', paidMillis: roundedWorkMillis, premiumCents: 1234, overtimeReviewed: true })]);
    const savedPay = await data<{ ledger: { days: { date: string; paidMillis: number; approval: { mode: string; paidMillis: number; premiumCents: number; overtimeReviewed: boolean }; review: { state: string } }[] } }>(await http.get(api + '/payroll/staff/' + employee.id));
    expect(savedPay.ledger.days.find(item => item.date === initial.today)).toMatchObject({
      paidMillis: day.paidMillis, approval: { mode: 'manual-reviewed', paidMillis: roundedWorkMillis, premiumCents: 1234, overtimeReviewed: true }, review: { state: 'approved' },
    });
    await page.getByRole('button', { name: 'Calculate pay', exact: true }).click();
    const expectedCents = Math.round(roundedWorkMillis / 3600000 * 2000) + 1234;
    const expectedMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(expectedCents / 100);
    await expect(page.getByRole('heading', { name: 'Gross pay before taxes: ' + expectedMoney, exact: true })).toBeVisible();
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
    expect(await editor.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
  } finally { await editorContext.close(); await teacherContext.close(); }
});
for (const width of [320, 1280]) test(`own clock and private pay review through HTTP at ${width}px`, async ({ page, browser }) => {
  test.setTimeout(90_000); page.setDefaultTimeout(10_000); await page.setViewportSize({ width, height: 1000 }); const http = await authenticatedApi(page); const suffix = randomUUID().slice(0, 8);
  const room = await data<{ id: string }>(await http.post(api + '/rooms', { data: { name: 'Clock class ' + suffix, ageMinMonths: 0, ageMaxMonths: 60, capacity: 10 } }), 201);
  const employee = await data<{ id: string; name: string }>(await http.post(api + '/staff', { data: { name: 'Clock employee ' + suffix, role: 'Teacher', roomId: room.id } }), 201);
  const password = 'Synthetic payroll changed 20!'; const temporary = 'Synthetic payroll temporary 20!'; const username = 'clock-' + suffix;
  await data(await http.post(api + '/admin/accounts', { data: { username, displayName: employee.name, role: 'teacher', staffMemberId: employee.id, password: temporary } }), 201);
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  try {
    const teacher = await context.newPage(); const response = await teacher.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporary, rememberMe: true } }); expect(response.status()).toBe(200); const login = await response.json() as { csrfToken: string };
    expect((await teacher.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': login.csrfToken }, data: { currentPassword: temporary, password } })).status()).toBe(200);
    const cookies = (await context.cookies(api)).filter(cookie => cookie.name === 'skao_session'); await context.addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
    await teacher.goto('/my-time'); await teacher.getByRole('button', { name: 'Check in to work', exact: true }).click();
    await expect(teacher.getByRole('button', { name: 'Check out of work', exact: true })).toBeEnabled(); await expect(teacher.getByRole('button', { name: 'Check in to work', exact: true })).toHaveCount(0);
    await expect(teacher.getByRole('button', { name: /break/i })).toHaveCount(0); await teacher.getByRole('button', { name: 'Check out of work', exact: true }).click();
    await expect(teacher.getByRole('button', { name: 'Check in to work', exact: true })).toBeEnabled(); expect((await teacher.request.get(api + '/payroll/staff/' + employee.id)).status()).toBe(403);
    const own = await data<{ checkedIn: boolean; version: number }>(await teacher.request.get(api + '/time-clock')); expect(JSON.stringify(own)).not.toMatch(/rates|taxId|bankAccount|approvals|sessions|days|Millis/);
    const base = api + '/payroll/staff/' + employee.id;
    const detail=await data<{ledger:{sessions:{id:string}[]}}>(await http.get(base));
    await data(await http.post(base + '/corrections', { data: { version: own.version, sessionId: detail.ledger.sessions[0].id, start: '2026-09-21T15:00:00Z', end: '2026-09-21T21:41:42Z', breaks: [], reason: 'Synthetic historical fixture correction', voided: false } }));
    await page.goto('/dashboard');
    if (width === 320) {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      const more = page.getByRole('navigation', { name: 'More navigation' });
      await expect(more.getByRole('link', { name: 'Work time', exact: true })).toHaveCount(0);
      await expect(more.getByRole('link', { name: 'Staff pay & time', exact: true })).toHaveCount(0);
      await more.getByRole('link', { name: 'Staff', exact: true }).click();
    } else {
      const desktop = page.getByRole('navigation', { name: 'Desktop navigation' });
      await expect(desktop.getByRole('link', { name: 'Work time', exact: true })).toHaveCount(0);
      await expect(desktop.getByRole('link', { name: 'Staff pay & time', exact: true })).toHaveCount(0);
      await desktop.getByRole('link', { name: 'Staff', exact: true }).click();
    }
    const sections = page.getByRole('navigation', { name: 'Staff sections' });
    await expect(sections.getByRole('link', { name: 'Staff information', exact: true })).toHaveAttribute('aria-current', 'page');
    await sections.getByRole('link', { name: 'Work time', exact: true }).click();
    await expect(page).toHaveURL(/\/staff\/work-time$/);
    await expect(sections.getByRole('link', { name: 'Work time', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sections.getByRole('link', { name: 'Staff information', exact: true })).not.toHaveAttribute('aria-current');
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await sections.getByRole('link', { name: 'Pay & time', exact: true }).click();
    await expect(page).toHaveURL(/\/staff\/payroll$/);
    await expect(sections.getByRole('link', { name: 'Pay & time', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(employee.id);
    await expect(page.getByLabel('Pay period start', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Calculate pay', exact: true })).toHaveCount(1);
    await expect(page.getByLabel('Employee SSN (optional)', { exact: true })).toHaveCount(0);
    await page.getByLabel('Pay period start', { exact: true }).fill('2026-09-21'); await page.getByLabel('Pay period end', { exact: true }).fill('2026-09-21');
    await page.getByLabel('Hourly rate ($ per hour)', { exact: true }).fill('20'); await page.getByLabel('Rate starts on', { exact: true }).fill('2026-01-01');
    await page.getByRole('button', { name: 'Save hourly rate', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save hourly rate', exact: true })).toHaveCount(0);
    await page.getByLabel('Payroll review note', { exact: true }).fill('Synthetic reviewer verified standard overtime, paid rest, actual unpaid breaks and adjustments.');
    await page.getByLabel('The applicable classification, overtime and adjustments have been reviewed.', { exact: true }).check();
    await page.getByRole('button', { name: 'Save reviewed payroll rules', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save reviewed payroll rules', exact: true })).toHaveCount(0);
    const roundedDetail = await data<PayReviewDetail>(await http.get(base));
    const roundedDay = roundedDetail.ledger.days.find(day => day.date === '2026-09-21')!;
    expect(roundedDay.review.suggestedPaidMillis).toBe(7 * 3600000);
    const roundingReason = roundedDay.review.reasons.find(reason => reason.code === 'ROUNDING_REVIEW')!;
    expect(roundingReason).toBeTruthy();
    // Posting the old fractional value directly cannot bypass the paid-time
    // policy shown by the calculator. The administrator must review seven hours.
    await data(await http.post(base + '/approvals', { data: {
      version: roundedDetail.ledger.version, profileVersion: roundedDetail.profile.version,
      date: '2026-09-21', status: 'approved', mode: 'manual-reviewed', paidMillis: 24102000,
      premiumCents: 0, adjustmentCents: 0, rulesReviewed: true, overtimeReviewed: false,
      reason: 'Synthetic attempt to retain the old fractional paid value',
    } }), 400);
    const dayToApprove = page.getByRole('article', { name: 'Pay review for 2026-09-21', exact: true });
    await expect(dayToApprove.getByText('Needs attention', { exact: true })).toBeVisible();
    await expect(dayToApprove.getByText(roundingReason.message, { exact: true })).toBeVisible();
    if (width === 320) await dayToApprove.screenshot({ path: test.info().outputPath('rounding-review-warning.png') });
    await expect(dayToApprove.getByLabel('I checked the hours and overtime for 2026-09-21.', { exact: true })).toHaveCount(0);
    await expect(dayToApprove.getByRole('button', { name: 'Approve recorded hours for 2026-09-21', exact: true })).toBeVisible();
    // The approval is available without opening another review or adjustment screen.
    await expect(dayToApprove.getByRole('button', { name: 'Review hours for 2026-09-21', exact: true })).toHaveCount(0);
    const approvedResponse = page.waitForResponse(response => response.url() === base + '/approvals' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Approve recorded hours for 2026-09-21', exact: true }).click();
    expect((await approvedResponse).status()).toBe(200);
    const approved = await data<{ ledger: { days: { date: string; paidMillis: number; approval: { paidMillis: number } }[] } }>(await http.get(base));
    expect(approved.ledger.days.find(day => day.date === '2026-09-21')).toMatchObject({ paidMillis: 24102000, approval: { paidMillis: 7 * 3600000 } });
    await expect(page.getByLabel('Pay period start', { exact: true })).toHaveValue('2026-09-21');
    await expect(page.getByLabel('Pay period end', { exact: true })).toHaveValue('2026-09-21');
    const calculate = page.getByRole('button', { name: 'Calculate pay', exact: true });
    await expect(calculate).toHaveCount(1);
    if (width === 320) { await calculate.scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath('pay-ready-mobile.png') }); }
    const calculated = page.waitForResponse(response => response.url() === base + '/preview' && response.request().method() === 'POST');
    await calculate.click();
    expect((await calculated).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Gross pay before taxes: $140.00', exact: true })).toBeVisible();
    const result = page.getByRole('region', { name: 'Pay calculation result', exact: true });
    await expect(result).toContainText('6 hr 41 min 42 sec');
    await expect(result.getByText('Approved paid time', { exact: true }).locator('..').locator('dd')).toHaveText('7 hr');
    await expect(result).not.toContainText('6.695');
    if (width === 320) await result.screenshot({ path: test.info().outputPath('human-time-pay-result.png') });
    await page.getByRole('button', { name: 'Save calculation', exact: true }).click();
    await page.getByText('Saved calculations', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open calculation snapshot', exact: true })).toBeVisible();
    await page.reload(); await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(employee.id); await page.getByText('Saved calculations', { exact: true }).click(); await page.getByRole('button', { name: 'Open calculation snapshot', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Gross pay before taxes: $140.00', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Pay calculation result', exact: true })).toContainText('6 hr 41 min 42 sec');
    await expect(page.getByRole('region', { name: 'Pay calculation result', exact: true }).getByText('Approved paid time', { exact: true }).locator('..').locator('dd')).toHaveText('7 hr');
    await expect(page.getByRole('region', { name: 'Pay calculation result', exact: true })).not.toContainText('6.695');
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: test.info().outputPath('payroll.png'), fullPage: true });
  } finally { await context.close(); }
});
test('editor receives a home reminder and corrects a verified late clockout without private payroll access at 390px', async({page,browser})=>{
 test.setTimeout(90_000);await page.setViewportSize({width:390,height:1000});const http=await authenticatedApi(page);const suffix=randomUUID().slice(0,8);
 const employee=await data<{id:string;name:string}>(await http.post(api+'/staff',{data:{name:'Late clock '+suffix,role:'Other'}}),201);
 const temporary='Synthetic review temporary 20!',password='Synthetic review changed 20!';
 for(const role of ['editor','teacher'])await data(await http.post(api+'/admin/accounts',{data:{username:role+'-'+suffix,displayName:role+' Example',role,...(role==='teacher'?{staffMemberId:employee.id}:{}),password:temporary}}),201);
 const context=await browser.newContext({viewport:{width:390,height:1000}});
 try{
  const other=await context.newPage();
  async function login(role:string){await context.clearCookies();const response=await other.request.post(api+'/auth/login',{headers:{Origin:origin},data:{username:role+'-'+suffix,password:temporary}});expect(response.status()).toBe(200);const csrf=(await response.json()).csrfToken;
   const changed=await other.request.post(api+'/auth/password',{headers:{Origin:origin,'X-CSRF-Token':csrf},data:{currentPassword:temporary,password}});expect(changed.status()).toBe(200);const token=(await changed.json()).csrfToken;const cookies=(await context.cookies(api)).filter(c=>c.name==='skao_session');await context.addCookies(cookies.map(c=>({...c,expires:-1})));return {Origin:origin,'X-CSRF-Token':token};}
  const headers=await login('teacher');expect((await other.request.post(api+'/time-clock',{headers,data:{action:'checkin',version:0,requestId:randomUUID()}})).status()).toBe(200);expect((await other.request.post(api+'/time-clock',{headers,data:{action:'checkout',version:1,requestId:randomUUID()}})).status()).toBe(200);
  const base=api+'/payroll/staff/'+employee.id;const initial=await data<{ledger:{version:number;sessions:{id:string}[]}}>(await http.get(base));
  await data(await http.post(base+'/corrections',{data:{version:initial.ledger.version,sessionId:initial.ledger.sessions[0].id,start:'2026-09-22T15:00:00Z',end:'2026-09-23T00:00:00Z',breaks:[],voided:false,reason:'Synthetic nine-hour late clockout'}}));
  await configurePay(http,employee.id);
  const payDetail=await data<PayReviewDetail>(await http.get(base));
  const payDay=payDetail.ledger.days.find(day=>day.date==='2026-09-22')!;
  const overtimeReason=payDay.review.reasons.find(reason=>/overtime/i.test(reason.message))!;
  expect(overtimeReason).toBeTruthy();
  await page.goto('/staff/payroll');
  await page.getByRole('combobox',{name:'Payroll employee',exact:true}).selectOption(employee.id);
  await page.getByLabel('Pay period start',{exact:true}).fill('2026-09-22');await page.getByLabel('Pay period end',{exact:true}).fill('2026-09-22');
  const payCard=page.getByRole('article',{name:'Pay review for 2026-09-22',exact:true});
  await expect(payCard.getByText('Needs attention',{exact:true})).toBeVisible();
  await expect(payCard.getByText(overtimeReason.message,{exact:true})).toBeVisible();
  await expect(payCard.getByRole('link',{name:'Review outside time for 2026-09-22',exact:true})).toBeVisible();
  await expect(page.getByLabel(/Overtime hours at 1\.5/)).toHaveCount(0);
  await expect(page.getByLabel('Double-time hours',{exact:true})).toHaveCount(0);
  await login('editor');await other.goto('/dashboard');await expect(other.getByRole('region',{name:'Extra employee time reminders'})).toContainText('needs extra-time review');await other.getByRole('link',{name:'Review work time',exact:true}).click();
  await expect(other).toHaveURL(/\/staff\/work-time$/);
  const sections=other.getByRole('navigation',{name:'Staff sections'});
  await expect(sections.getByRole('link')).toHaveCount(2);
  await expect(sections.getByRole('link',{name:'Staff information',exact:true})).toBeVisible();
  await expect(sections.getByRole('link',{name:'Work time',exact:true})).toHaveAttribute('aria-current','page');
  await expect(sections.getByRole('link',{name:'Pay & time',exact:true})).toHaveCount(0);
  await expect(other.getByRole('heading',{name:employee.name+' · 2026-09-22',exact:true})).toBeVisible();expect((await other.request.get(base)).status()).toBe(403);
  await other.getByText('Correct a late clock-out mistake',{exact:true}).click();await other.getByLabel('Actual work ended at (America/Los_Angeles)',{exact:true}).fill('16:00:00');await other.getByLabel('Clock correction reason',{exact:true}).fill('Verified employee stopped work at 4 PM and forgot to clock out');await other.getByLabel('I verified no work was performed after this time.',{exact:true}).check();await other.getByRole('button',{name:'Save verified clock correction',exact:true}).click();
  await expect(other.getByText('No extra time is waiting for review.',{exact:true})).toBeVisible();expect(await other.locator('main').evaluate(e=>e.scrollWidth)).toBeLessThanOrEqual(391);
  const result=await data<{ledger:{sessions:{end:string}[];history:{type:string;before?:{end:string}}[]}}>(await http.get(base));expect(result.ledger.sessions[0].end).toBe('2026-09-22T23:00:00.000Z');expect(result.ledger.history.some(h=>h.type==='clock-error-review'&&h.before?.end==='2026-09-23T00:00:00.000Z')).toBe(true);
  await page.reload();
  await page.getByRole('combobox',{name:'Payroll employee',exact:true}).selectOption(employee.id);
  await page.getByLabel('Pay period start',{exact:true}).fill('2026-09-22');await page.getByLabel('Pay period end',{exact:true}).fill('2026-09-22');
  const correctedPayCard=page.getByRole('article',{name:'Pay review for 2026-09-22',exact:true});
  await expect(correctedPayCard.getByText('Awaiting approval',{exact:true})).toBeVisible();
  await correctedPayCard.getByText('Change paid hours or add an adjustment',{exact:true}).click();
  await correctedPayCard.getByRole('button',{name:'Open detailed approval for 2026-09-22',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Work time and daily approvals',exact:true})).toBeVisible();
  await expect(page.locator('details.payroll-workday[open]')).toHaveCount(1);
  await expect(page.locator('details.payroll-workday[open]>summary')).toContainText('2026-09-22');
  await expect(page.getByLabel('Paid hours',{exact:true})).toBeVisible();
  await expect(page.getByLabel(/Overtime hours at 1\.5/)).toHaveCount(0);
  await expect(page.getByLabel('Double-time hours',{exact:true})).toHaveCount(0);
 }finally{await context.close();}
});
