import { expect, test } from '@playwright/test';
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
type PrintCall = { active: boolean; frameActive: boolean; pages: number; decoded: boolean };

test('blank PNG and every PDF page are ready before an activated print click, and session loss removes the frame', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  // Revocation below must not invalidate the shared session of other screen tests.
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
      { name: 'PNG', contentType: 'image/png', filename: 'synthetic-blank.png', data: png, pages: 1 },
      { name: 'PDF', contentType: 'application/pdf', filename: 'synthetic-blank.pdf', data: syntheticPdf(), pages: 2 },
    ]) {
      const title = `Synthetic blank print ${fixture.name} ${crypto.randomUUID().slice(0, 8)}`;
      const created = await http.post(`${api}/registration-forms`, { data: {
        title, instructions: 'Synthetic surrounding instructions must stay outside the printable pages.',
        category: 'consent', audience: 'facility', required: false, requestId: crypto.randomUUID(),
        file: { name: fixture.filename, contentType: fixture.contentType, dataBase64: fixture.data },
      } });
      expect(created.status()).toBe(201);
      forms.push((await created.json()).form as Form);
      await page.goto('/registration-forms');
      await page.getByRole('region', { name: 'Template list', exact: true }).getByRole('button', { name: new RegExp(title) }).click();
      await page.getByRole('button', { name: `Print blank ${title}`, exact: true }).click();
      await expect(page.getByRole('region', { name: 'Blank form ready to print', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open print dialog', exact: true })).toBeEnabled();
      const frame = page.locator('iframe[title="Blank form print"]');
      await expect(frame).toHaveCount(1);
      await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-modals');
      const content = await frame.evaluate((element, expectedPages) => {
        const document = (element as HTMLIFrameElement).contentDocument!;
        const images = Array.from(document.images);
        return {
          pages: images.length,
          decoded: images.length === expectedPages && images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
          rasterOnly: images.every(image => image.src.startsWith('data:image/png;base64,')),
          bodyText: document.body.textContent?.trim(),
          activeElements: document.querySelectorAll('script, iframe, object, embed, a, input, form').length,
          imageMarks: images.map(image => {
            const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let marks = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              if (pixels[index + 3] > 180 && pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) marks++;
            }
            return marks;
          }),
        };
      }, fixture.pages);
      expect(content).toMatchObject({ pages: fixture.pages, decoded: true, rasterOnly: true, bodyText: '', activeElements: 0 });
      if (fixture.name === 'PDF') for (const marks of content.imageMarks) expect(marks, 'Every printable PDF page must contain the synthetic text').toBeGreaterThan(20);
      // Headless Chromium has no physical printer dialog. Replace only its final
      // synchronous native call, after real fetch, rendering and image decoding.
      // A lost user gesture fails this assertion; no application source is mocked.
      await frame.evaluate(element => {
        const target = (element as HTMLIFrameElement).contentWindow!;
        const parent = window as typeof window & { __blankPrintCalls?: PrintCall[] };
        parent.__blankPrintCalls = [];
        target.print = () => {
          const images = Array.from(target.document.images);
          parent.__blankPrintCalls!.push({ active: navigator.userActivation.isActive, frameActive: target.navigator.userActivation.isActive,
            pages: images.length, decoded: images.every(image => image.complete && image.naturalWidth > 0) });
        };
      });
      await page.getByRole('button', { name: 'Open print dialog', exact: true }).click();
      expect(await page.evaluate(() => (window as typeof window & { __blankPrintCalls?: PrintCall[] }).__blankPrintCalls))
        .toEqual([{ active: true, frameActive: true, pages: fixture.pages, decoded: true }]);
      await page.getByRole('button', { name: 'Close print preview', exact: true }).click();
      await expect(frame).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Blank form ready to print', exact: true })).toHaveCount(0);
    }
    // Prepare once more, then invalidate the real session while it is open.
    const last = forms.at(-1)!;
    await page.getByRole('button', { name: `Print blank ${last.title}`, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Blank form ready to print', exact: true })).toBeVisible();
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
    await expect(page.locator('iframe[title="Blank form print"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Blank form ready to print', exact: true })).toHaveCount(0);
    expect(external, 'Blank-form fetching and raster printing must stay on local academy services').toEqual([]);
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
