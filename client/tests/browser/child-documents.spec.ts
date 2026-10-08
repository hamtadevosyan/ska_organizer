import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { api, authenticatedApi, origin } from './auth-helpers';

// Small, valid synthetic paperwork. These fixtures contain no child records.
function syntheticPdf(text: string) {
  const stream = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`;
  const secondStream = 'BT /F1 14 Tf 20 100 Td (Second synthetic page) Tj ET';
  const stampStream = '1 0 0 rg 0 0 80 40 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [8 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${Buffer.byteLength(secondStream)} >>\nstream\n${secondStream}\nendstream`,
    '<< /Type /Annot /Subtype /Stamp /Rect [20 20 100 60] /F 4 /AP << /N 9 0 R >> /Name /Approved >>',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 80 40] /Resources << >> /Length ${Buffer.byteLength(stampStream)} >>\nstream\n${stampStream}\nendstream`,
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNQTrv/HwAEgAJoq/U0KAAAAABJRU5ErkJggg==', 'base64');
type Revision = { id: string; revision: number; current: boolean; uploadedBy: string; changeNote: string | null };
type Details = { document: { id: string; childId: string; title: string; category: string; version: number; currentRevisionId: string }; revisions: Revision[]; total: number };

async function fits(page: Page) {
  const size = await page.locator('main').evaluate(main => ({ content: main.scrollWidth, width: main.clientWidth,
    page: document.documentElement.scrollWidth, screen: document.documentElement.clientWidth }));
  expect(size.content, 'Document forms and history must fit the available main content').toBeLessThanOrEqual(size.width + 1);
  expect(size.page, 'The page must not require horizontal scrolling').toBeLessThanOrEqual(size.screen + 1);
  for (const control of await page.getByRole('region', { name: 'Documents', exact: true }).locator('button:visible, input:visible, select:visible, textarea:visible').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    // Camera file inputs are intentionally hidden inside a visible capture label.
    if (box!.width > 1 && box!.height > 1) {
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.screen + 1);
    }
  }
}
async function childFromResponse(response: Pick<APIResponse, 'status' | 'json'>) {
  expect(response.status()).toBe(201);
  return await response.json() as { id: string; firstName: string; lastName: string };
}
async function renderedPdf(page: Page, number = 1) {
  const canvas = page.getByRole('img', { name: 'PDF page ' + number, exact: true });
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(element => {
    const value = element as HTMLCanvasElement;
    if (!value.width || !value.height) return { rendered: false, width: value.width, height: value.height, marks: 0 };
    const pixels = value.getContext('2d')!.getImageData(0, 0, value.width, value.height).data;
    let marks = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      // Count black text separately from the red saved stamp appearance.
      if (pixels[index + 3] > 180 && pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) marks++;
    }
    return { rendered: value.width > 10 && value.height > 10 && marks > 20, width: value.width, height: value.height, marks };
  }), { message: 'PDF preview must draw the synthetic text, not merely show an empty container' }).toMatchObject({ rendered: true });
}
async function savedStampVisible(page: Page) {
  const canvas = page.getByRole('img', { name: 'PDF page 1', exact: true });
  await expect.poll(() => canvas.evaluate(element => {
    const value = element as HTMLCanvasElement;
    const pixels = value.getContext('2d')!.getImageData(0, 0, value.width, value.height).data;
    let red = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index + 1] < 80 && pixels[index + 2] < 80 && pixels[index + 3] > 180) red++;
    }
    return red;
  }), { message: 'The saved stamp appearance must remain visible in the PDF, without interactive document controls' }).toBeGreaterThan(100);
}

for (const width of [390, 1280]) {
  test(`child paperwork retains metadata, old files and drafts through a failed revision at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) {
      // Older Safari builds lack this API; the bundled legacy PDF renderer
      // must still show paperwork without asking staff to change a device.
      await page.addInitScript(() => { Object.defineProperty(Promise, 'withResolvers', { value: undefined, configurable: true, writable: true }); });
    }
    const http = await authenticatedApi(page);
    const externalRequests: string[] = [];
    page.context().on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && ![origin, new URL(api).origin].includes(url.origin)) externalRequests.push(url.origin);
    });
    const surname = 'Documents ' + width + ' ' + crypto.randomUUID().slice(0, 8);
    await page.goto('/children');
    await page.getByRole('button', { name: 'Add child', exact: true }).click();
    await page.getByLabel('First name', { exact: true }).fill('Synthetic');
    await page.getByLabel('Last name', { exact: true }).fill(surname);
    await page.getByLabel('Date of birth', { exact: true }).fill('2023-01-01');
    await page.getByRole('checkbox', { name: 'Add documents after saving', exact: true }).check();
    const created = page.waitForResponse(response => response.url() === api + '/children' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save child', exact: true }).click();
    const child = await childFromResponse(await created);
    await expect(page.getByRole('form', { name: 'Add document', exact: true })).toBeVisible();
    const base = `${api}/children/${child.id}/documents`;
    expect((await (await http.get(base)).json()).total).toBe(0);

    const original = syntheticPdf('Synthetic consent paperwork');
    await page.getByLabel('Document title', { exact: true }).fill('Synthetic consent');
    await page.getByRole('combobox', { name: 'Document category', exact: true }).selectOption('consent');
    await page.getByLabel('Document date (optional)', { exact: true }).fill('2026-01-02');
    await page.getByRole('textbox', { name: 'Document notes (optional)', exact: true }).fill('Synthetic paperwork for browser checks only.');
    await page.getByLabel('Upload a document', { exact: true }).setInputFiles({ name: 'synthetic-consent.pdf', mimeType: 'application/pdf', buffer: original });
    await fits(page);
    await page.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Document saved.' })).toBeVisible();
    const list = await (await http.get(base)).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ childId: child.id, title: 'Synthetic consent', category: 'consent', documentDate: '2026-01-02' });
    const documentId = list.items[0].id;
    const initial = await (await http.get(base + '/' + documentId)).json() as Details;
    expect(initial.revisions).toHaveLength(1);
    const first = initial.revisions[0];
    await expect(page.getByRole('region', { name: 'Selected document', exact: true })).toContainText('Uploaded by browser-admin');
    await page.getByRole('button', { name: 'Preview version 1', exact: true }).click();
    await renderedPdf(page);
    await savedStampVisible(page);
    await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous PDF page', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Next PDF page', exact: true }).click();
    await renderedPdf(page, 2);
    await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Previous PDF page', exact: true }).click();
    await renderedPdf(page);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('child-document-mobile.png'), fullPage: true });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download version 1', exact: true }).click();
    const savedFile = await download;
    expect(savedFile.suggestedFilename()).toBe('synthetic-consent.pdf');
    expect(await readFile((await savedFile.path())!)).toEqual(original);
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();

    await page.getByRole('button', { name: 'Edit document details', exact: true }).click();
    await page.getByLabel('Document title', { exact: true }).fill('Synthetic updated consent');
    await page.getByRole('textbox', { name: 'Document notes (optional)', exact: true }).fill('Metadata updated; the original file is retained.');
    await page.getByRole('button', { name: 'Save document details', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Document details saved.' })).toBeVisible();
    await page.getByRole('button', { name: 'Upload new version', exact: true }).click();
    await page.getByLabel('Upload a document', { exact: true }).setInputFiles({ name: 'synthetic-scan.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('textbox', { name: 'Change note (optional)', exact: true }).fill('Synthetic revised scan.');
    await page.route('**/api/children/*/documents/*/revisions', route => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: { message: 'Synthetic storage outage. Try again.' } }) }));
    await page.getByRole('button', { name: 'Save new version', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Documents', exact: true }).getByRole('alert')).toContainText('Synthetic storage outage');
    await expect(page.getByRole('textbox', { name: 'Change note (optional)', exact: true })).toHaveValue('Synthetic revised scan.');
    await expect(page.getByRole('form', { name: 'Add document version', exact: true })).toContainText('synthetic-scan.png');
    const failed = await (await http.get(base + '/' + documentId)).json() as Details;
    expect(failed.document.currentRevisionId).toBe(initial.document.currentRevisionId);
    expect(failed.revisions).toHaveLength(1);
    await fits(page);
    await page.unroute('**/api/children/*/documents/*/revisions');
    await page.getByRole('button', { name: 'Save new version', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'New version saved. Previous versions are kept.' })).toBeVisible();
    const revised = await (await http.get(base + '/' + documentId)).json() as Details;
    expect(revised.document).toMatchObject({ id: documentId, childId: child.id, title: 'Synthetic updated consent' });
    expect(revised.revisions).toHaveLength(2);
    expect(revised.revisions.find(value => value.current)).toMatchObject({ revision: 2, changeNote: 'Synthetic revised scan.', uploadedBy: 'browser-admin' });
    expect(revised.revisions.find(value => value.id === first.id)).toMatchObject({ revision: 1, current: false });
    expect(await (await http.get(base + '/' + documentId + '/revisions/' + first.id + '/content')).body()).toEqual(original);
    await page.getByRole('button', { name: 'Preview version 2', exact: true }).click();
    const image = page.getByRole('img', { name: 'Document version 2 preview', exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await fits(page);
    await page.reload();
    await page.getByRole('searchbox', { name: 'Search children', exact: true }).fill('Synthetic ' + surname);
    await page.getByRole('button', { name: 'View Synthetic ' + surname, exact: true }).click();
    await page.getByRole('button', { name: /^Synthetic updated consent Consent form · Updated/ }).click();
    await expect(page.getByRole('region', { name: 'Selected document', exact: true })).toContainText('Version 2');
    await expect(page.getByRole('region', { name: 'Selected document', exact: true })).toContainText('Version 1');
    expect(externalRequests, 'Document capture, rendering and downloads must use the academy origin and local API only').toEqual([]);
  });
}

test('failed or cancelled child creation cannot upload paperwork; camera capture previews, retakes and confirms at 320px', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 320, height: 844 });
  const http = await authenticatedApi(page);
  let documentWrites = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/children\/[^/]+\/documents(?:\/[^/]+\/revisions)?$/.test(new URL(request.url()).pathname)) documentWrites++; });
  await page.goto('/children');
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  await page.getByLabel('First name', { exact: true }).fill('Cancelled');
  await page.getByRole('checkbox', { name: 'Add documents after saving', exact: true }).check();
  await page.getByRole('form', { name: 'Add child', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Add child', exact: true })).toHaveCount(0);
  expect(documentWrites).toBe(0);
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  await page.getByLabel('First name', { exact: true }).fill('Failed');
  await page.getByLabel('Last name', { exact: true }).fill('Creation');
  await page.getByLabel('Date of birth', { exact: true }).fill('2023-01-01');
  await page.getByRole('checkbox', { name: 'Add documents after saving', exact: true }).check();
  await page.route('**/api/children', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic creation failure.' } }) }) : route.continue());
  await page.getByRole('button', { name: 'Save child', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Add child', exact: true }).getByRole('alert')).toContainText('Synthetic creation failure.');
  await expect(page.getByRole('form', { name: 'Add document', exact: true })).toHaveCount(0);
  expect(documentWrites).toBe(0);
  await page.unroute('**/api/children');
  await page.getByRole('form', { name: 'Add child', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  const surname = 'Camera ' + crypto.randomUUID().slice(0, 8);
  const child = await childFromResponse(await http.post(api + '/children', { data: { firstName: 'Synthetic', lastName: surname, dateOfBirth: '2023-01-01', roomId: null } }));
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search children', exact: true }).fill('Synthetic ' + surname);
  await page.getByRole('button', { name: 'View Synthetic ' + surname, exact: true }).click();
  await page.getByRole('button', { name: 'Add document', exact: true }).click();
  // Scanner filenames and titles can contain long words; the narrow layout
  // must still keep all fields and history actions within the screen.
  await page.getByLabel('Document title', { exact: true }).fill('Synthetic camera consent ' + 'x'.repeat(120));
  const camera = page.getByLabel('Take a photo', { exact: true });
  await expect(camera).toHaveAttribute('capture', 'environment');
  await camera.setInputFiles({ name: 'first-photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('img', { name: 'Captured document preview', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save document', exact: true })).toBeDisabled();
  const retakenFilename = 'retaken-photo-' + 'x'.repeat(120) + '.png';
  await page.getByLabel('Retake photo', { exact: true }).setInputFiles({ name: retakenFilename, mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('form', { name: 'Add document', exact: true })).toContainText(retakenFilename);
  expect(documentWrites).toBe(0);
  expect((await (await http.get(`${api}/children/${child.id}/documents`)).json()).total).toBe(0);
  await fits(page);
  await page.getByRole('button', { name: 'Confirm photo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save document', exact: true })).toBeEnabled();
  expect(documentWrites).toBe(0);
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Document saved.' })).toBeVisible();
  expect(documentWrites).toBe(1);
  await expect(page.getByRole('region', { name: 'Selected document', exact: true })).toContainText(retakenFilename);
  await fits(page);
});

test('document permission is separate from the roster; a granted viewer can read but cannot change files', async ({ page, browser }) => {
  test.setTimeout(60000);
  const http = await authenticatedApi(page);
  const suffix = crypto.randomUUID().slice(0, 8);
  const child = await childFromResponse(await http.post(api + '/children', { data: { firstName: 'Synthetic', lastName: 'Permission ' + suffix, dateOfBirth: '2023-01-01', roomId: null } }));
  const base = `${api}/children/${child.id}/documents`;
  const created = await http.post(base, { data: { title: 'Synthetic restricted paperwork', category: 'medical', documentDate: null, notes: '', requestId: crypto.randomUUID(), file: { name: 'synthetic-paperwork.pdf', contentType: 'application/pdf', dataBase64: syntheticPdf('Synthetic restricted paperwork').toString('base64') } } });
  expect(created.status()).toBe(201);
  const saved = await created.json();
  for (const documentAccess of ['none', 'view']) {
    const username = 'docs-' + documentAccess + '-' + suffix;
    const temporaryPassword = 'Synthetic temporary paperwork passphrase 20!';
    const password = 'Synthetic changed paperwork passphrase 20!';
    const accountResponse = await http.post(api + '/admin/accounts', { data: { username, displayName: 'Synthetic ' + documentAccess, role: 'viewer', documentAccess, password: temporaryPassword } });
    expect(accountResponse.status()).toBe(201);
    const account = (await accountResponse.json()).data;
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
    try {
      const other = await context.newPage();
      const login = await other.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporaryPassword } });
      expect(login.status()).toBe(200);
      const csrf = (await login.json()).csrfToken;
      const changed = await other.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': csrf }, data: { currentPassword: temporaryPassword, password } });
      expect(changed.status()).toBe(200);
      const headers = { Origin: origin, 'X-CSRF-Token': (await changed.json()).csrfToken };
      await other.goto('/children');
      await other.getByRole('searchbox', { name: 'Search children', exact: true }).fill('Synthetic Permission ' + suffix);
      await other.getByRole('button', { name: 'View Synthetic Permission ' + suffix, exact: true }).click();
      expect((await other.request.get(api + '/children/' + child.id + '/profile')).status()).toBe(200);
      if (documentAccess === 'none') {
        await expect(other.getByText('Document access is managed separately. Ask an administrator if you need it.', { exact: true })).toBeVisible();
        expect((await other.request.get(base)).status()).toBe(403);
        expect((await other.request.get(`${base}/${saved.document.id}/revisions/${saved.revision.id}/content`)).status()).toBe(403);
        await expect(other.getByText('Synthetic restricted paperwork', { exact: true })).toHaveCount(0);
      } else {
        await other.getByRole('button', { name: /^Synthetic restricted paperwork Medical record · Updated/ }).click();
        await expect(other.getByRole('button', { name: 'Add document', exact: true })).toHaveCount(0);
        await expect(other.getByRole('button', { name: 'Upload new version', exact: true })).toHaveCount(0);
        await expect(other.getByRole('button', { name: 'Edit document details', exact: true })).toHaveCount(0);
        await other.getByRole('button', { name: 'Preview version 1', exact: true }).click();
        await renderedPdf(other);
        const content = await other.request.get(`${base}/${saved.document.id}/revisions/${saved.revision.id}/content`);
        expect(content.status()).toBe(200);
        expect(content.headers()['cache-control']).toContain('no-store');
        expect((await other.request.post(base, { headers, data: {} })).status()).toBe(403);
        expect((await other.request.put(base + '/' + saved.document.id, { headers, data: {} })).status()).toBe(403);
        await fits(other);
        expect((await http.put(api + '/admin/accounts/' + account.id, { data: {
          displayName: 'Synthetic view', role: 'viewer', disabled: false, documentAccess: 'none',
        } })).status()).toBe(200);
        // An actual document request observes the revoked session immediately;
        // this must not depend on a focus-probe timer or browser clock.
        await other.getByRole('button', { name: 'Download version 1', exact: true }).click();
        await expect(other.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
        await expect(other.getByRole('region', { name: 'Document preview', exact: true })).toHaveCount(0);
        expect((await other.request.get(`${base}/${saved.document.id}/revisions/${saved.revision.id}/content`)).status()).toBe(401);
      }
    } finally { await context.close(); }
  }
});
