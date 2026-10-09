import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { api, authenticatedApi, origin } from './auth-helpers';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==';
function syntheticPdf() {
  const first = 'BT /F1 14 Tf 20 100 Td (First synthetic blank page) Tj ET';
  const second = 'BT /F1 14 Tf 20 100 Td (Second synthetic blank page) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
  ];
  // Synthetic content is ASCII, so string lengths are byte offsets.
  let value = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(value.length); value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = value.length;
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return btoa(value);
}
type Form = { id: string; title: string; instructions: string; category: string; audience: string; required: boolean; active: boolean; version: number };
type SharedFile = { name: string; type: string; dataBase64: string };
type ShareCall = { active: boolean; keys: string[]; title: string | undefined; files: SharedFile[] };
type Harness = { supported: boolean; cancelNext: boolean; printCalls: number; calls: ShareCall[] };
type FixtureWindow = typeof window & { __blankShareFixture: Harness };

test('Share / Print prepares the original blank file, preserves activation and offers a byte-exact download fallback', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const state: Harness = { supported: true, cancelNext: false, printCalls: 0, calls: [] };
    (window as FixtureWindow).__blankShareFixture = state;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: ShareData) =>
      state.supported && data.files?.length === 1 && data.files[0] instanceof File });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      // Capture activation before awaiting file bytes, just as the native menu
      // checks the gesture at invocation. Real API fetching is never mocked.
      const call: ShareCall = { active: navigator.userActivation.isActive, keys: Object.keys(data).sort(), title: data.title, files: [] };
      state.calls.push(call);
      for (const file of data.files || []) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        call.files.push({ name: file.name, type: file.type, dataBase64: btoa(String.fromCharCode(...bytes)) });
      }
      if (state.cancelNext) { state.cancelNext = false; throw new DOMException('Synthetic menu cancellation', 'AbortError'); }
    } });
    window.print = () => { state.printCalls++; };
  });
  // This test revokes only its disposable login, never another screen's cache.
  const http = await authenticatedApi(page, { freshSession: true });
  const forms: Form[] = [];
  let archived = false;
  const external: string[] = [];
  page.context().on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) external.push(url.origin);
  });
  try {
    for (const fixture of [
      { name: 'PNG', contentType: 'image/png', filename: 'synthetic-blank.png', data: png, extension: '.png' },
      { name: 'PDF', contentType: 'application/pdf', filename: 'synthetic-blank.pdf', data: syntheticPdf(), extension: '.pdf' },
    ]) {
      const title = `Synthetic blank share ${fixture.name} ${crypto.randomUUID().slice(0, 8)}`;
      const created = await http.post(`${api}/registration-forms`, { data: {
        title, instructions: 'Synthetic surrounding instructions must not become a shared message.',
        category: 'consent', audience: 'facility', required: false, requestId: crypto.randomUUID(),
        file: { name: fixture.filename, contentType: fixture.contentType, dataBase64: fixture.data },
      } });
      expect(created.status()).toBe(201);
      forms.push((await created.json()).form as Form);
      await page.goto('/registration-forms');
      await page.getByRole('region', { name: 'Template list', exact: true }).getByRole('button', { name: new RegExp(title) }).click();
      const shareAction = page.getByRole('button', { name: `Share / Print blank ${title}`, exact: true });
      const options = page.getByRole('region', { name: 'Share or print blank form', exact: true });
      await shareAction.click();
      await expect(options).toBeVisible();
      await expect(options.getByRole('button', { name: 'Open share menu', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => (window as FixtureWindow).__blankShareFixture.calls)).toEqual([]);
      const expectedCall = { active: true, keys: ['files', 'title'], title: 'Blank ' + title,
        files: [{ name: 'blank-' + title + fixture.extension, type: fixture.contentType, dataBase64: fixture.data }] };
      if (fixture.name === 'PNG') {
        await page.evaluate(() => { (window as FixtureWindow).__blankShareFixture.cancelNext = true; });
        await options.getByRole('button', { name: 'Open share menu', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__blankShareFixture.calls)).toEqual([expectedCall]);
        await expect(options.getByRole('button', { name: 'Open share menu', exact: true })).toBeEnabled();
        await expect(options).toBeVisible();
        await expect(page.getByRole('region', { name: 'Selected registration template', exact: true }).getByRole('alert')).toHaveCount(0);
      }
      await options.getByRole('button', { name: 'Open share menu', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__blankShareFixture.calls))
        .toEqual(fixture.name === 'PNG' ? [expectedCall, expectedCall] : [expectedCall]);
      expect(await page.evaluate(() => (window as FixtureWindow).__blankShareFixture.printCalls)).toBe(0);
      await expect(page.locator('iframe, object[type="application/pdf"], embed[type="application/pdf"]')).toHaveCount(0);
      await options.getByRole('button', { name: 'Close share options', exact: true }).click();
      await expect(options).toHaveCount(0);
      await page.evaluate(() => { (window as FixtureWindow).__blankShareFixture.supported = false; });
      await shareAction.click();
      await expect(options.getByRole('button', { name: 'Download to share or print', exact: true })).toBeVisible();
      const download = page.waitForEvent('download');
      await options.getByRole('button', { name: 'Download to share or print', exact: true }).click();
      const saved = await download;
      expect(saved.suggestedFilename()).toBe('blank-' + title + fixture.extension);
      expect((await readFile((await saved.path())!)).toString('base64')).toBe(fixture.data);
      await options.getByRole('button', { name: 'Close share options', exact: true }).click();
      await expect(options).toHaveCount(0);
    }
    const last = forms.at(-1)!;
    await page.getByRole('button', { name: `Share / Print blank ${last.title}`, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Share or print blank form', exact: true })).toBeVisible();
    for (const form of forms) {
      expect((await http.put(`${api}/registration-forms/${form.id}`, { data: {
        version: form.version, title: form.title, instructions: form.instructions, category: form.category,
        audience: form.audience, required: form.required, active: false,
      } })).status()).toBe(200);
    }
    archived = true;
    expect((await http.post(`${api}/auth/logout`, { data: {} })).status()).toBe(204);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Share or print blank form', exact: true })).toHaveCount(0);
    expect(external, 'Blank-form preparation and downloads must stay on local academy services').toEqual([]);
  } finally {
    if (!archived) for (const form of forms) {
      const detail = await http.get(`${api}/registration-forms/${form.id}`);
      if (detail.ok()) {
        const current = (await detail.json()).form as Form;
        await http.put(`${api}/registration-forms/${form.id}`, { data: { ...current, active: false } });
      }
    }
  }
});
