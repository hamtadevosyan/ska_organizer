import { expect, test } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';
import type { RegistrationForm } from '../../src/api/registrationForms';
import type { StaffDocumentDetails, StaffChecklist } from '../../src/api/staffDocuments';

test.use({ actionTimeout: 15000 });

// An actual, self-contained text PDF exercises the local PDF.js worker rather
// than replacing the date analyzer with a browser mock.
function certificatePdf() {
  const stream = 'BT /F1 16 Tf 50 740 Td (Synthetic staff certificate) Tj 0 -30 Td (Issued: January 1, 2026) Tj 0 -30 Td (Expires: March 31, 2030) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let contents = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(contents)); contents += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(contents);
  contents += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(contents);
}

for (const width of [320, 1280]) {
  test(`confirm a locally read expiration date and retain a chosen reminder at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    const http = await authenticatedApi(page);
    const suffix = crypto.randomUUID().slice(0, 8);
    const employeeName = 'Synthetic upload ' + suffix;
    const title = 'Synthetic expiry requirement ' + suffix;
    const employeeResponse = await http.post(api + '/staff', { data: { name: employeeName, role: 'Teacher', active: true, roomId: null } });
    expect(employeeResponse.status()).toBe(201);
    const { data: employee } = await employeeResponse.json();
    const requirementResponse = await http.post(api + '/registration-forms', { data: {
      title, instructions: 'Synthetic certificate.', category: 'other', audience: 'employee', required: true,
      expirationRequired: true, requestId: crypto.randomUUID(),
    } });
    expect(requirementResponse.status()).toBe(201);
    let requirement = (await requirementResponse.json()).form as RegistrationForm;
    const outsideRequests: string[] = [];
    page.context().on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) outsideRequests.push(url.origin);
    });
    const base = `${api}/staff/${employee.id}/documents`;
    try {
      await page.goto('/staff');
      await page.getByRole('searchbox', { name: 'Search staff', exact: true }).fill(employeeName);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('button', { name: 'Documents & training for ' + employeeName, exact: true }).click();
      await page.getByRole('button', { name: 'Attach completed ' + title, exact: true }).click();
      const form = page.getByRole('form', { name: 'Add staff document', exact: true });
      await form.getByLabel('Upload a staff document', { exact: true }).setInputFiles({ name: 'synthetic-expiry.pdf', mimeType: 'application/pdf', buffer: certificatePdf() });
      const suggestion = form.getByRole('button', { name: 'Use expiration date 2030-03-31', exact: true });
      await expect(suggestion).toBeVisible({ timeout: 30000 });
      await expect(form.getByLabel('Expiration date', { exact: true })).toHaveValue('');
      await suggestion.click();
      await expect(form.getByLabel('Expiration date', { exact: true })).toHaveValue('2030-03-31');
      await form.getByLabel('Remind me', { exact: true }).selectOption('30');
      await expect(form.getByLabel('Reminder days (optional)', { exact: true })).toHaveValue('30');
      const dimensions = await page.locator('main').evaluate(main => ({ width: main.clientWidth, content: main.scrollWidth,
        screen: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
      expect(dimensions.document).toBeLessThanOrEqual(dimensions.screen + 1);
      await form.getByRole('button', { name: 'Save staff document', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Selected staff document', exact: true })).toBeVisible();
      const list = await (await http.get(base)).json();
      const details = await (await http.get(base + '/' + list.items[0].id)).json() as StaffDocumentDetails;
      expect(details.document).toMatchObject({ expiresOn: '2030-03-31', warningDays: 30, reviewedRevisionId: null });
      const checklist = await (await http.get(base + '/checklist')).json() as StaffChecklist;
      expect(checklist.items.find(item => item.form.id === requirement.id)).toMatchObject({ warningDays: 30, nextReminderDate: '2030-03-01' });
      await page.getByRole('button', { name: 'Preview staff document version 1', exact: true }).click();
      await expect(page.getByRole('img', { name: 'PDF page 1', exact: true })).toBeVisible();
      expect(await page.getByRole('img', { name: 'PDF page 1', exact: true }).evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
      await page.reload();
      await page.getByRole('button', { name: 'Documents & training for ' + employeeName, exact: true }).click();
      await page.getByRole('button', { name: new RegExp('^' + title + ' Expires 2030-03-31') }).click();
      await page.getByRole('button', { name: 'Edit document details', exact: true }).click();
      await expect(page.getByLabel('Remind me', { exact: true })).toHaveValue('30');
      await expect(page.getByLabel('Expiration date', { exact: true })).toHaveValue('2030-03-31');
      expect(outsideRequests).toEqual([]);
    } finally {
      expect((await http.put(api + '/staff/' + employee.id, { data: { version: employee.version, active: false } })).status()).toBe(200);
      requirement = (await (await http.get(api + '/registration-forms/' + requirement.id)).json()).form;
      expect((await http.put(api + '/registration-forms/' + requirement.id, { data: { version: requirement.version,
        title: requirement.title, instructions: requirement.instructions, category: requirement.category,
        required: requirement.required, active: false } })).status()).toBe(200);
    }
  });
}
