import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { api, authenticatedApi, origin } from './auth-helpers';
import type { StaffCompliance, StaffDocumentDetails } from '../../src/api/staffDocuments';
import type { RegistrationForm } from '../../src/api/registrationForms';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==', 'base64');
function daysAfter(today: string, days: number) {
  const date = new Date(today + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
async function fits(page: Page) {
  const dimensions = await page.locator('main').evaluate(main => ({ available: main.clientWidth, content: main.scrollWidth,
    screen: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(dimensions.content, 'Employee paperwork must fit the main content').toBeLessThanOrEqual(dimensions.available + 1);
  expect(dimensions.document, 'Employee paperwork must not require horizontal scrolling').toBeLessThanOrEqual(dimensions.screen + 1);
  for (const control of await page.getByRole('region', { name: 'Staff documents and training', exact: true }).locator('button:visible, input:visible, select:visible, textarea:visible').all()) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds!.width > 1 && bounds!.height > 1) {
      expect(bounds!.x).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dimensions.screen + 1);
    }
  }
}

test('employee requirements show missing and forty-day reminders, preserve renewal history and clear private previews at sign-out', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 900 });
  const http = await authenticatedApi(page, { freshSession: true });
  const suffix = crypto.randomUUID().slice(0, 8);
  const employeeName = 'Synthetic Training ' + suffix;
  const title = 'Synthetic required certificate ' + suffix;
  const forms: RegistrationForm[] = [];
  const original = await readFile(new URL('../../../server/tests/fixtures/child-documents/synthetic.pdf', import.meta.url));
  const staffResponse = await http.post(api + '/staff', { data: { name: employeeName, role: 'Teacher', active: true, roomId: null } });
  expect(staffResponse.status()).toBe(201);
  const { data: employee } = await staffResponse.json();
  const base = `${api}/staff/${employee.id}/documents`;
  const settings = await (await http.get(api + '/staff-compliance/settings')).json();
  if (settings.warningDays !== 40) expect((await http.put(api + '/staff-compliance/settings', { data: { warningDays: 40, version: settings.version } })).status()).toBe(200);
  const today = ((await (await http.get(api + '/staff-compliance')).json()) as StaffCompliance).today;
  const externalRequests: string[] = [];
  page.context().on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) externalRequests.push(url.origin);
  });
  async function createRequirement(formTitle: string, audience = 'employee') {
    const response = await http.post(api + '/registration-forms', { data: { title: formTitle, instructions: 'Synthetic required form.',
      category: 'other', audience, required: true, ...(audience === 'employee' ? { expirationRequired: true } : {}),
      requestId: crypto.randomUUID(), file: { name: 'synthetic-blank.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
    expect(response.status()).toBe(201);
    const { form } = await response.json(); forms.push(form); return form as RegistrationForm;
  }
  let previewUrl = '';
  let saved: StaffDocumentDetails | undefined;
  try {
    const requirement = await createRequirement(title);
    const childTemplate = await createRequirement('Synthetic child-only ' + suffix, 'child');
    const facilityTemplate = await createRequirement('Synthetic facility-only ' + suffix, 'facility');
    await page.goto('/staff');
    await page.getByRole('searchbox', { name: 'Search staff', exact: true }).fill(employeeName);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'Documents & training for ' + employeeName, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Staff documents and training', exact: true });
    const checklist = panel.getByRole('region', { name: 'Employee requirements', exact: true });
    const card = checklist.getByRole('article', { name: title, exact: true });
    await expect(card).toContainText('Missing document');
    await expect(checklist.getByRole('article', { name: childTemplate.title, exact: true })).toHaveCount(0);
    await expect(checklist.getByRole('article', { name: facilityTemplate.title, exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: 'Attach completed ' + title, exact: true }).click();
    const form = panel.getByRole('form', { name: 'Add staff document', exact: true });
    await expect(form.getByLabel('Document title', { exact: true })).toHaveValue(title);
    await form.getByLabel('Issued date (optional)', { exact: true }).fill(today);
    await form.getByLabel('Expiration date', { exact: true }).fill(daysAfter(today, 40));
    await form.getByLabel('Issuer (optional)', { exact: true }).fill('Synthetic training provider');
    await form.getByLabel('Certificate reference (optional)', { exact: true }).fill('Synthetic reference');
    await form.getByLabel('Document notes (optional)', { exact: true }).fill('Synthetic private training metadata.');
    await form.getByLabel('Upload a staff document', { exact: true }).setInputFiles({ name: 'synthetic-certificate.pdf', mimeType: 'application/pdf', buffer: original });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await fits(page);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await form.getByRole('button', { name: 'Save staff document', exact: true }).click();
    await expect(card).toContainText('Needs review');
    const uploaded = await (await http.get(base)).json();
    const documentId = uploaded.items.find((item: { registrationFormId: string }) => item.registrationFormId === requirement.id).id;
    const initial = await (await http.get(`${base}/${documentId}`)).json() as StaffDocumentDetails;
    expect(initial.document).toMatchObject({ issuedOn: today, expiresOn: daysAfter(today, 40), nonExpiring: false, reviewedRevisionId: null });
    await panel.getByRole('checkbox', { name: 'I checked this document and its dates', exact: true }).check();
    await panel.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await expect(card).toContainText('Renewal due soon');
    const overview = page.getByRole('region', { name: 'Employee document reminders', exact: true });
    const overviewLink = overview.getByRole('link', { name: employeeName + ' · ' + title, exact: true });
    await expect(overviewLink).toBeVisible();
    await expect(overviewLink.locator('..')).toContainText('Renewal due soon');
    await expect(overviewLink.locator('..')).not.toContainText('Missing document');
    const warning = ((await (await http.get(api + '/staff-compliance')).json()) as StaffCompliance).items.find(item => item.staffId === employee.id && item.requirementId === requirement.id);
    expect(warning).toMatchObject({ status: 'expiring', daysRemaining: 40, expiresOn: daysAfter(today, 40) });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await fits(page);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await panel.getByRole('button', { name: 'Upload new version', exact: true }).click();
    const renewal = panel.getByRole('form', { name: 'Renew staff document', exact: true });
    await renewal.getByLabel('Issued date (optional)', { exact: true }).fill(today);
    await renewal.getByLabel('Expiration date', { exact: true }).fill(daysAfter(today, 365));
    await renewal.getByLabel('Upload a staff document', { exact: true }).setInputFiles({ name: 'synthetic-renewal.png', mimeType: 'image/png', buffer: png });
    await renewal.getByRole('button', { name: 'Save new version', exact: true }).click();
    await expect(card).toContainText('Needs review');
    saved = await (await http.get(`${base}/${documentId}`)).json() as StaffDocumentDetails;
    expect(saved.revisions).toHaveLength(2);
    expect(saved.document).toMatchObject({ id: documentId, expiresOn: daysAfter(today, 365), reviewedRevisionId: null });
    expect(saved.revisions.find(revision => revision.id === initial.revisions[0].id)).toMatchObject({ expiresOn: daysAfter(today, 40), current: false });
    expect(await (await http.get(`${base}/${documentId}/revisions/${initial.revisions[0].id}/content`)).body()).toEqual(original);
    await panel.getByRole('checkbox', { name: 'I checked this document and its dates', exact: true }).check();
    await panel.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await expect(card).toContainText('Complete');
    await expect(overview.getByRole('button', { name: 'Check employee documents', exact: true })).toBeEnabled();
    await expect(overview.getByRole('alert')).toHaveCount(0);
    await expect(overviewLink).toHaveCount(0);
    expect(((await (await http.get(api + '/staff-compliance')).json()) as StaffCompliance).items.some(item => item.staffId === employee.id && item.requirementId === requirement.id)).toBe(false);
    await panel.getByRole('button', { name: 'Preview staff document version 2', exact: true }).click();
    const image = panel.getByRole('img', { name: 'Staff document version 2 preview', exact: true });
    await expect(image).toBeVisible();
    previewUrl = (await image.getAttribute('src'))!;
    expect(previewUrl).toMatch(/^blob:/);
    await page.screenshot({ path: testInfo.outputPath('staff-compliance-mobile.png'), fullPage: true });
    expect(externalRequests, 'Staff documents and reminders must stay on the academy computer').toEqual([]);
  } finally {
    for (const form of forms) {
      const detail = await http.get(`${api}/registration-forms/${form.id}`);
      if (detail.ok()) {
        const { form: current } = await detail.json();
        expect((await http.put(`${api}/registration-forms/${form.id}`, { data: { version: current.version, title: current.title,
          instructions: current.instructions, category: current.category, required: current.required, active: false } })).status()).toBe(200);
      }
    }
    if (settings.warningDays !== 40) {
      const current = await (await http.get(api + '/staff-compliance/settings')).json();
      expect((await http.put(api + '/staff-compliance/settings', { data: { warningDays: settings.warningDays, version: current.version } })).status()).toBe(200);
    }
    expect((await http.put(`${api}/staff/${employee.id}`, { data: { active: false, version: employee.version } })).status()).toBe(200);
  }
  // Cleanup uses direct API calls and must not dispose the open preview before
  // the session lifecycle action being checked below.
  await expect(page.getByRole('img', { name: 'Staff document version 2 preview', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Staff document version 2 preview', exact: true })).toHaveAttribute('src', previewUrl);
  await page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('dialog', { name: 'More', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Staff documents and training', exact: true })).toHaveCount(0);
  expect(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, previewUrl)).toBe(false);
  expect((await page.request.get(`${base}/${saved!.document.id}/revisions/${saved!.document.currentRevisionId}/content`)).status()).toBe(401);
});

test('editors see minimal renewal reminders while viewers and both roles cannot read employee files', async ({ page, browser }) => {
  test.setTimeout(90000);
  const http = await authenticatedApi(page);
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = 'Synthetic restricted employee ' + suffix;
  const title = 'Synthetic restricted certificate ' + suffix;
  const employeeResponse = await http.post(api + '/staff', { data: { name, role: 'Teacher', active: true, roomId: null } });
  expect(employeeResponse.status()).toBe(201);
  const { data: employee } = await employeeResponse.json();
  const templateResponse = await http.post(api + '/registration-forms', { data: { title, instructions: 'Synthetic employee requirements.', category: 'other',
    audience: 'employee', required: true, expirationRequired: true, requestId: crypto.randomUUID(), file: { name: 'synthetic-blank.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
  expect(templateResponse.status()).toBe(201);
  const { form } = await templateResponse.json();
  const today = ((await (await http.get(api + '/staff-compliance')).json()) as StaffCompliance).today;
  const base = `${api}/staff/${employee.id}/documents`;
  const uploaded = await http.post(base, { data: { title: 'Synthetic private certificate', category: 'medical', documentDate: null,
    notes: 'Synthetic private medical information.', issuer: 'Synthetic private issuer', reference: 'Synthetic private reference', issuedOn: null,
    expiresOn: daysAfter(today, -1), nonExpiring: false, warningDays: null, registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId,
    requestId: crypto.randomUUID(), file: { name: 'synthetic-private-file.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
  expect(uploaded.status()).toBe(201);
  const saved = await uploaded.json();
  expect((await http.put(`${base}/${saved.document.id}/review`, { data: { version: saved.document.version, reviewed: true } })).status()).toBe(200);
  try {
    for (const role of ['editor', 'viewer']) {
      const username = 'training-' + role + '-' + suffix;
      const temporaryPassword = 'Synthetic temporary training passphrase 20!';
      const password = 'Synthetic changed training passphrase 20!';
      const created = await http.post(api + '/admin/accounts', { data: { username, displayName: 'Synthetic ' + role, role, documentAccess: 'none', password: temporaryPassword } });
      expect(created.status()).toBe(201);
      const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 900 } });
      try {
        const other = await context.newPage();
        const login = await other.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporaryPassword } });
        expect(login.status()).toBe(200);
        const changed = await other.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await login.json()).csrfToken }, data: { currentPassword: temporaryPassword, password } });
        expect(changed.status()).toBe(200);
        const headers = { Origin: origin, 'X-CSRF-Token': (await changed.json()).csrfToken };
        const privateRequests: string[] = [];
        other.on('request', request => { if (/\/api\/(?:registration-forms|staff\/[^/]+\/documents)/.test(new URL(request.url()).pathname)) privateRequests.push(request.url()); });
        await other.goto('/dashboard');
        await other.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('button', { name: 'More', exact: true }).click();
        await other.getByRole('dialog', { name: 'More', exact: true }).getByRole('link', { name: 'Staff', exact: true }).click();
        await other.getByRole('searchbox', { name: 'Search staff', exact: true }).fill(name);
        await other.getByRole('button', { name: 'Search', exact: true }).click();
        await other.getByRole('button', { name: 'View details for ' + name, exact: true }).click();
        const profile = other.getByRole('dialog', { name: 'Staff details', exact: true });
        await expect(profile).toContainText(name);
        await expect(profile).toContainText('Teacher');
        await expect(profile.locator('input, select, textarea')).toHaveCount(0);
        await expect(profile).not.toContainText('Synthetic private');
        await expect(profile).not.toContainText(title);
        await profile.getByRole('button', { name: 'Close staff details', exact: true }).click();
        const action = other.getByRole('button', { name: 'Documents & training for ' + name, exact: true });
        if (role === 'editor') {
          await expect(action).toBeVisible();
          await action.click();
          const panel = other.getByRole('region', { name: 'Staff documents and training', exact: true });
          await expect(panel).toContainText(title);
          await expect(panel).toContainText('Expired');
          await expect(panel.locator('input[type="file"]')).toHaveCount(0);
          const response = await other.request.get(api + '/staff-compliance');
          expect(response.status()).toBe(200);
          const alerts = (await response.json()) as StaffCompliance;
          const item = alerts.items.find(value => value.staffId === employee.id)!;
          expect(item).toMatchObject({ employeeName: name, requirementTitle: title, status: 'expired', daysRemaining: -1 });
          expect(Object.keys(item).every(key => ['staffId', 'employeeName', 'requirementId', 'requirementTitle', 'status', 'expiresOn', 'daysRemaining', 'warningDays', 'nextReminderDate'].includes(key))).toBe(true);
          expect(JSON.stringify(alerts)).not.toMatch(/Synthetic private|synthetic-private-file|dataBase64|sha256|currentRevisionId|reviewedBy/);
        } else {
          await expect(action).toHaveCount(0);
          await expect(other.getByRole('region', { name: 'Staff documents and training', exact: true })).toHaveCount(0);
          expect((await other.request.get(api + '/staff-compliance')).status()).toBe(403);
          expect((await other.request.get(api + '/staff-compliance/settings')).status()).toBe(403);
        }
        expect(privateRequests).toEqual([]);
        for (const path of [base, base + '/checklist', `${base}/${saved.document.id}`, `${base}/${saved.document.id}/revisions/${saved.revision.id}/content`]) {
          expect((await other.request.get(path)).status()).toBe(403);
        }
        expect((await other.request.head(`${base}/${saved.document.id}/revisions/${saved.revision.id}/content`)).status()).toBe(403);
        expect((await other.request.post(base, { headers, data: {} })).status()).toBe(403);
        expect((await other.request.put(api + '/staff-compliance/settings', { headers, data: { warningDays: 30, version: 1 } })).status()).toBe(403);
      } finally { await context.close(); }
    }
  } finally {
    const detail = await http.get(`${api}/registration-forms/${form.id}`);
    if (detail.ok()) {
      const { form: current } = await detail.json();
      expect((await http.put(`${api}/registration-forms/${form.id}`, { data: { version: current.version, title: current.title,
        instructions: current.instructions, category: current.category, required: current.required, active: false } })).status()).toBe(200);
    }
    expect((await http.put(`${api}/staff/${employee.id}`, { data: { active: false, version: employee.version } })).status()).toBe(200);
  }
});
