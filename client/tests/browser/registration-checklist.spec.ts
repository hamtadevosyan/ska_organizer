import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { api, authenticatedApi, origin } from './auth-helpers';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==', 'base64');
type Form = { id: string; title: string; instructions: string; category: string; required: boolean; active: boolean; version: number; currentRevisionId: string };
async function fits(page: Page) {
  const size = await page.locator('main').evaluate(main => ({ width: main.clientWidth, content: main.scrollWidth,
    screen: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width + 1);
  expect(size.document).toBeLessThanOrEqual(size.screen + 1);
  for (const control of await page.getByRole('region', { name: 'Registration checklist', exact: true }).locator('button:visible, input:visible, select:visible').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.screen + 1);
  }
}
for (const width of [320, 1280]) {
  test(`registration packet shows missing, reviewed, revised and newly required forms at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    const http = await authenticatedApi(page);
    const suffix = crypto.randomUUID().slice(0, 8);
    const forms: Form[] = [];
    const external: string[] = [];
    page.context().on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) external.push(url.origin);
    });
    async function createForm(title: string, audience = 'child') {
      const response = await http.post(api + '/registration-forms', { data: { title, instructions: 'Complete and sign this synthetic form.',
        category: 'consent', audience, required: true, requestId: crypto.randomUUID(),
        file: { name: 'synthetic-blank.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
      expect(response.status()).toBe(201);
      const form = (await response.json()).form as Form;
      forms.push(form); return form;
    }
    try {
      const blank = await createForm('Synthetic registration consent ' + suffix);
      const employee = await createForm('Synthetic employee template ' + suffix, 'employee');
      const facility = await createForm('Synthetic facility template ' + suffix, 'facility');
      await page.goto('/children');
      await page.getByRole('button', { name: 'Add child', exact: true }).click();
      await page.getByLabel('First name', { exact: true }).fill('Synthetic');
      await page.getByLabel('Last name', { exact: true }).fill('Registration ' + suffix);
      await page.getByLabel('Date of birth', { exact: true }).fill('2023-01-01');
      await expect(page.getByRole('checkbox', { name: 'Add documents after saving', exact: true })).toBeChecked();
      await page.getByRole('button', { name: 'Save child', exact: true }).click();
      const checklist = page.getByRole('region', { name: 'Registration checklist', exact: true });
      await expect(checklist).toBeVisible();
      await expect(checklist.getByRole('article', { name: employee.title, exact: true })).toHaveCount(0);
      await expect(checklist.getByRole('article', { name: facility.title, exact: true })).toHaveCount(0);
      await expect(checklist).toContainText('Enrollment 75%');
      const card = checklist.getByRole('article', { name: blank.title, exact: true });
      await expect(card).toContainText('Missing');
      await fits(page);
      const download = page.waitForEvent('download');
      await card.getByRole('button', { name: 'Download blank ' + blank.title, exact: true }).click();
      const file = await download;
      expect(await readFile((await file.path())!)).toEqual(png);
      await card.getByRole('button', { name: 'Attach completed ' + blank.title, exact: true }).click();
      await expect(page.getByLabel('Document title', { exact: true })).toHaveValue(blank.title);
      await page.getByLabel('Upload a document', { exact: true }).setInputFiles({ name: 'synthetic-completed.png', mimeType: 'image/png', buffer: png });
      await page.getByRole('button', { name: 'Save document', exact: true }).click();
      await expect(card).toContainText('Needs review');
      await card.getByRole('button', { name: 'Review completed ' + blank.title, exact: true }).click();
      await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeDisabled();
      await page.getByRole('checkbox', { name: 'I checked this copy is filled out and signed where required', exact: true }).check();
      await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
      await expect(card).toContainText('Complete');
      await expect(checklist).toContainText('Enrollment 100%');
      const revised = await http.post(`${api}/registration-forms/${blank.id}/revisions`, { data: { version: blank.version,
        requestId: crypto.randomUUID(), changeNote: 'Synthetic updated registration requirements.',
        file: { name: 'synthetic-blank-v2.png', contentType: 'image/png', dataBase64: png.toString('base64') } } });
      expect(revised.status()).toBe(201);
      forms[0] = (await revised.json()).form;
      await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
      await expect(card).toContainText('Updated form needed');
      const insurance = await createForm('Synthetic insurance form ' + suffix);
      await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
      await expect(checklist.getByRole('article', { name: insurance.title, exact: true })).toContainText('Missing');
      await fits(page);
      if (width === 320) await page.screenshot({ path: testInfo.outputPath('registration-checklist-mobile.png'), fullPage: true });
      expect(external, 'Packet actions must stay local unless the user chooses to share').toEqual([]);
    } finally {
      for (const form of forms) {
        const detail = await http.get(`${api}/registration-forms/${form.id}`);
        if (detail.ok()) {
          const current = (await detail.json()).form as Form;
          expect((await http.put(`${api}/registration-forms/${form.id}`, { data: { version: current.version, title: current.title,
            instructions: current.instructions, category: current.category, required: current.required, active: false } })).status()).toBe(200);
        }
      }
    }
  });
}
