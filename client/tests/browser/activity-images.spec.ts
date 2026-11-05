import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';

// UI contract fixture: authentication and rooms use the real isolated server.
// Only model/media replies are synthetic; backend ownership/ACL tests cover the
// corresponding server routes without a Windows GPU or external video traffic.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABrElEQVR4nO3cMUrDYBiAYVtc3byKowheQTyIHkQPIl5BEEePopuD4FAcugiCpDXJ0+r7zEnzkzff1v9ffLy/HMRZ6gX8dwXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwB2OOSik9OLqdfx3fPT/W9u35c1NwHYoAlYuztaTbeOry7fRvsslue3Y/3Uz1YPV9vd2ARgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwDbYojTizqHZbL1zaDb7907/mEWH9llNAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwDf6WMoV9OeF5Ok0Ahidg7fHmdZ4HnV0fz/Og4ZoArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsANhObFHawZ1Ds2kCsM6OxpoArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgH0CryIf2vMeXjEAAAAASUVORK5CYII=', 'base64');
const steps = ['Put the large paper shapes on the table.', 'Arrange the large shapes into a shared collage.'];
const description = 'Purpose: Explore shapes together.\n\nPreparation: Prepare large paper shapes.\n\nHow to do it:\n1. ' + steps[0] + '\n2. ' + steps[1];
const images = steps.map((caption, index) => ({ id: 'browser-picture-' + (index + 1), step: index + 1, caption, width: 128, height: 128 }));
const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS' };
async function fits(page: Page, dialog: Locator) {
  const size = await dialog.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width + 1); expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  for (const control of await dialog.locator('button:visible, select:visible, input:not([type="checkbox"]):visible').all()) {
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.x + box!.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}
for (const width of [320, 768, 1280]) test(`step pictures and unreviewed video search work at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(45000); await page.setViewportSize({ width, height: 1000 });
  const http = await authenticatedApi(page);
  const roomResponse = await http.post(api + '/rooms', { data: { name: 'Picture room ' + randomUUID().slice(0, 8), ageMinMonths: 36, ageMaxMonths: 60, capacity: 12 } });
  expect(roomResponse.status()).toBe(201); const room = (await roomResponse.json()).data;
  const imageRequests: string[] = []; const jobRequests: Record<string, unknown>[] = []; const saved: Record<string, unknown>[] = [];
  const external: string[] = []; let completeImages = false;
  page.on('request', request => { const url = new URL(request.url()); if (!['blob:', 'data:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) external.push(request.url()); });
  const draft = { name: 'Shared paper collage', description, durationMinutes: 20, ageMinMonths: 36, ageMaxMonths: 60,
    roomId: room.id, materials: [], materialsNotes: 'Large paper shapes and washable glue.', sourceIds: [], visualSteps: steps,
    tutorialLinks: [{ title: 'Search YouTube for how-to videos', publisher: 'YouTube', kind: 'search', url: 'https://www.youtube.com/results?search_query=preschool+paper+collage+how+to' }] };
  await page.route(api + '/activity-ai/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const send = (data: unknown) => route.fulfill({ status: 200, headers: cors, json: { data } });
    if (path.endsWith('/images/status')) return send({ enabled: true, available: true, busy: false, model: 'sd_xl_base_1.0.safetensors', message: 'Ready' });
    if (path.endsWith('/activity-ai/status')) return send({ enabled: true, available: true, model: 'browser-model', sourceCount: 0, message: 'Ready' });
    if (path.endsWith('/draft')) return send({ model: 'browser-model', generatedAt: '2026-11-04T00:00:00Z', sources: [], warnings: [], drafts: [draft] });
    if (path.endsWith('/images/jobs') && request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBeTruthy(); jobRequests.push(request.postDataJSON());
      return send({ id: 'browser-job', status: 'running', completed: 0, total: 2, images: [] });
    }
    if (path.endsWith('/images/jobs/browser-job')) return send({ id: 'browser-job', status: request.method() === 'DELETE' ? 'cancelled' : completeImages ? 'complete' : 'running', completed: completeImages ? 2 : 0, total: 2, images: completeImages ? images : [] });
    if (/\/images\/browser-picture-[12]$/.test(path)) { imageRequests.push(path); return route.fulfill({ status: 200, headers: cors, contentType: 'image/png', body: png }); }
    return route.fulfill({ status: 404, headers: cors, json: { error: { message: 'Unexpected media UI fixture request.' } } });
  });
  await page.route(api + '/activity', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON(); saved.push(body);
    return route.fulfill({ status: 201, headers: cors, json: { data: { ...body, id: 'saved-browser-pictures', version: 1, illustrations: images } } });
  });
  await page.goto('/activities');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  await expect(page.getByRole('button', { name: 'AI activity ideas', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'AI activity ideas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI activity ideas', exact: true });
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  const card = dialog.getByRole('article', { name: 'AI idea 1', exact: true });
  await expect(card).toContainText('Unreviewed search');
  await expect(card.getByRole('link', { name: /Search YouTube/ })).toHaveAttribute('target', '_blank');
  await expect(card).not.toContainText('No related how-to video');
  await expect(dialog).not.toContainText('Planning sources (0)');
  expect(jobRequests).toHaveLength(0); expect(imageRequests).toHaveLength(0); await fits(page, dialog);
  await card.getByRole('button', { name: 'Create step pictures', exact: true }).click();
  const pending = dialog.locator('.app-modal-pending');
  await expect(pending).toBeVisible();
  await expect(pending.getByRole('status')).toContainText('Creating step pictures: 0 of 2 complete.');
  await expect(pending.getByRole('status')).toBeInViewport();
  const cancelPictures = pending.getByRole('button', { name: 'Cancel picture generation', exact: true });
  await expect(cancelPictures).toBeEnabled(); await expect(cancelPictures).toBeInViewport();
  await expect(card).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Review idea 1', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true, includeHidden: true })
    .getByRole('button', { name: 'Review idea 1', exact: true, includeHidden: true })).toBeDisabled();
  completeImages = true;
  await expect(pending).toHaveCount(0);
  await expect(card.getByRole('img')).toHaveCount(2); await fits(page, dialog);
  for (const image of await card.getByRole('img').all()) { await expect(image).toHaveAttribute('src', /^blob:/); await expect(image).toHaveCSS('object-fit', 'contain'); await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(128); }
  await card.getByRole('img').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('step-pictures.png') });
  expect(jobRequests).toHaveLength(1); expect(jobRequests[0]).toEqual({ name: draft.name, description: description + '\n\nAI-assisted educational draft. Review safety and suitability before use.', steps });
  await card.getByRole('button', { name: 'Review idea 1', exact: true }).click();
  const form = dialog.getByRole('form', { name: 'New activity', exact: true });
  await expect(form.getByRole('img')).toHaveCount(2); await fits(page, dialog);
  await form.getByRole('button', { name: 'Save activity', exact: true }).click();
  await expect(dialog).toContainText('Activity saved to your library.');
  expect(saved).toHaveLength(1); expect(saved[0].illustrations).toEqual(images.map(({ id }) => ({ id })));
  expect(external).toEqual([]);
});

test('an image startup failure shows its safe reason and preserves review and retry', async ({ page }) => {
  test.setTimeout(30000); await page.setViewportSize({ width: 393, height: 780 });
  const http = await authenticatedApi(page);
  const roomResponse = await http.post(api + '/rooms', { data: { name: 'Image recovery ' + randomUUID().slice(0, 8), ageMinMonths: 36, ageMaxMonths: 60, capacity: 12 } });
  expect(roomResponse.status()).toBe(201); const room = (await roomResponse.json()).data;
  let jobs = 0;
  const safeMessage = 'The image process did not become ready in time. Check the image worker on the AI laptop before retrying.';
  const draft = { name: 'Shared paper collage recovery', description, durationMinutes: 20, ageMinMonths: 36, ageMaxMonths: 60,
    roomId: room.id, materials: [], materialsNotes: 'Large paper shapes.', sourceIds: [], visualSteps: steps, tutorialLinks: [] };
  await page.route(api + '/activity-ai/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const send = (value: unknown) => route.fulfill({ status: 200, headers: cors, json: { data: value } });
    if (path.endsWith('/images/status')) return send({ enabled: true, available: true, busy: false, model: 'sd_xl_base_1.0.safetensors', message: 'Ready' });
    if (path.endsWith('/activity-ai/status')) return send({ enabled: true, available: true, model: 'browser-model', sourceCount: 0, message: 'Ready' });
    if (path.endsWith('/draft')) return send({ model: 'browser-model', generatedAt: '2026-11-04T00:00:00Z', sources: [], warnings: [], drafts: [draft] });
    if (path.endsWith('/images/jobs') && route.request().method() === 'POST') {
      jobs++;
      return send({ id: 'recovery-job-' + jobs, status: 'running', completed: 0, total: 2, images: [] });
    }
    if (path.endsWith('/images/jobs/recovery-job-1')) return send({ id: 'recovery-job-1', status: 'failed', code: 'IMAGE_STARTUP_TIMEOUT', message: safeMessage, completed: 0, total: 2, images: [] });
    if (path.endsWith('/images/jobs/recovery-job-2')) return send({ id: 'recovery-job-2', status: 'complete', completed: 2, total: 2, images });
    if (/\/images\/browser-picture-[12]$/.test(path)) return route.fulfill({ status: 200, headers: cors, contentType: 'image/png', body: png });
    return route.fulfill({ status: 404, headers: cors, json: { error: { message: 'Unexpected recovery fixture request.' } } });
  });
  await page.goto('/activities');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  await page.getByRole('button', { name: 'AI activity ideas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI activity ideas', exact: true });
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  const idea = dialog.getByRole('article', { name: 'AI idea 1', exact: true });
  await idea.getByRole('button', { name: 'Create step pictures', exact: true }).click();
  const message = idea.getByRole('alert');
  await expect(message).toHaveText(safeMessage); await expect(message).toBeInViewport();
  await expect(message).toBeFocused();
  await expect(dialog.locator('.app-modal-pending')).toHaveCount(0);
  await expect(idea).toContainText(description);
  await expect(idea.getByRole('button', { name: 'Review idea 1', exact: true })).toBeEnabled();
  await expect(idea.getByRole('img')).toHaveCount(0);
  await idea.getByRole('button', { name: 'Retry step pictures', exact: true }).click();
  await expect(idea.getByRole('img')).toHaveCount(2);
  await expect(idea.getByRole('alert')).toHaveCount(0);
  expect(jobs).toBe(2);
  await idea.getByRole('button', { name: 'Review idea 1', exact: true }).click();
  const form = dialog.getByRole('form', { name: 'New activity', exact: true });
  await expect(form.getByRole('img')).toHaveCount(2);
  await expect(form.getByLabel('Description', { exact: true })).toHaveValue(description + '\n\nAI-assisted educational draft. Review safety and suitability before use.');
});
