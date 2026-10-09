import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';
import type { RegistrationForm } from '../../src/api/registrationForms';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==', 'base64');

async function fits(page: Page) {
  const size = await page.locator('main').evaluate(main => ({ width: main.clientWidth, content: main.scrollWidth,
    screen: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content, 'Staff content must fit without hidden horizontal overflow').toBeLessThanOrEqual(size.width + 1);
  expect(size.document).toBeLessThanOrEqual(size.screen + 1);
  for (const control of await page.locator('main button:visible, main input:visible, main select:visible, dialog[open] button:visible').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.screen + 1);
  }
}

async function openStaff(page: Page, width: number) {
  if (width < 768) {
    await page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('dialog', { name: 'More', exact: true }).getByRole('link', { name: 'Staff', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'More', exact: true })).toHaveCount(0);
  } else {
    await page.getByRole('navigation', { name: 'Desktop navigation', exact: true }).getByRole('link', { name: 'Staff', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
}

for (const width of [320, 390, 1280]) {
  test(`staff details and a name-only required certificate work at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90000);
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width, height: 900 });
    const http = await authenticatedApi(page);
    const suffix = crypto.randomUUID().slice(0, 8);
    const employeeName = 'Synthetic Staff Profile ' + suffix;
    const title = 'Synthetic CPR Certificate ' + suffix;
    const response = await http.post(api + '/staff', { data: { name: employeeName, role: 'Lead teacher', active: true, roomId: null } });
    expect(response.status()).toBe(201);
    const { data: employee } = await response.json();
    let requirement: RegistrationForm | undefined;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto('/dashboard');
      await openStaff(page, width);
      await page.getByRole('searchbox', { name: 'Search staff', exact: true }).fill(employeeName);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const view = page.getByRole('button', { name: 'View details for ' + employeeName, exact: true });
      await view.click();
      const profile = page.getByRole('dialog', { name: 'Staff details', exact: true });
      await expect(profile).toContainText(employeeName);
      await expect(profile).toContainText('Lead teacher');
      await expect(profile).toContainText('Unassigned');
      await expect(profile).toContainText('Active');
      await expect(profile.locator('input, select, textarea')).toHaveCount(0);
      await fits(page);
      await profile.getByRole('button', { name: 'Close staff details', exact: true }).click();
      await expect(view).toBeFocused();

      await page.getByRole('link', { name: 'Add employee requirement', exact: true }).click();
      const form = page.getByRole('form', { name: 'Add employee requirement', exact: true });
      await expect(form).toBeVisible();
      await expect(form.getByRole('checkbox', { name: 'Required for every active employee', exact: true })).toBeChecked();
      await expect(form.getByRole('combobox', { name: /Template for/ })).toHaveValue('employee');
      await form.getByLabel('Certificate or document name', { exact: true }).fill(title);
      await form.getByRole('checkbox', { name: 'Expiration date required', exact: true }).check();
      await fits(page);
      const saved = page.waitForResponse(result => result.url() === api + '/registration-forms' && result.request().method() === 'POST');
      await form.getByRole('button', { name: 'Save employee requirement', exact: true }).click();
      const savedResponse = await saved;
      expect(savedResponse.status()).toBe(201);
      expect(savedResponse.request().postDataJSON()).not.toHaveProperty('file');
      const data = await savedResponse.json();
      requirement = data.form;
      expect(data.revision).toBeNull();
      expect(requirement).toMatchObject({ title, audience: 'employee', required: true, expirationRequired: true, currentRevisionId: null, templateRevision: 0 });
      await expect(page.getByRole('status').filter({ hasText: 'Employee requirement added.' })).toBeVisible();
      await expect(form).toHaveCount(0);
      await page.goto('/registration-forms');
      await expect(form).toHaveCount(0);
      await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
      await openStaff(page, width);
      await page.getByRole('searchbox', { name: 'Search staff', exact: true }).fill(employeeName);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('button', { name: 'Documents & training for ' + employeeName, exact: true }).click();
      const panel = page.getByRole('region', { name: 'Staff documents and training', exact: true });
      const card = panel.getByRole('article', { name: title, exact: true });
      await expect(card).toContainText('Missing document');
      await expect(card.getByRole('button', { name: /Download blank/ })).toHaveCount(0);
      await card.getByRole('button', { name: 'Attach completed ' + title, exact: true }).click();
      const upload = panel.getByRole('form', { name: 'Add staff document', exact: true });
      await expect(upload.getByLabel('Document title', { exact: true })).toHaveValue(title);
      await upload.getByLabel('Expiration date', { exact: true }).fill('2099-01-01');
      await upload.getByLabel('Upload a staff document', { exact: true }).setInputFiles({ name: 'synthetic-completed-certificate.png', mimeType: 'image/png', buffer: png });
      await upload.getByRole('button', { name: 'Save staff document', exact: true }).click();
      await expect(card).toContainText('Needs review');
      await panel.getByRole('checkbox', { name: 'I checked this document and its dates', exact: true }).check();
      await panel.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
      await expect(card).toContainText('Complete');
      await fits(page);
      await page.screenshot({ path: testInfo.outputPath('staff-required-certificate-' + width + '.png'), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      if (requirement) {
        const details = await http.get(`${api}/registration-forms/${requirement.id}`);
        if (details.ok()) {
          const { form: current } = await details.json();
          expect((await http.put(`${api}/registration-forms/${current.id}`, { data: { version: current.version, title: current.title,
            instructions: current.instructions, category: current.category, required: current.required,
            expirationRequired: current.expirationRequired, active: false } })).status()).toBe(200);
        }
      }
      expect((await http.put(`${api}/staff/${employee.id}`, { data: { active: false, version: employee.version } })).status()).toBe(200);
    }
  });
}
