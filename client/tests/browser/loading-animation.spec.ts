import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';
import { statementApi, statementPage } from './ccrc-statement-fixtures';

// Authentication and room selection use the isolated app. Only inference
// replies are held, so waits are deterministic and need no artificial timer.
const steps = ['Put the large paper shapes on the table.', 'Arrange the shapes into a shared collage.'];
const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS' };
async function respond(route: Route, data: unknown) {
  await route.fulfill({ status: 200, headers: cors, json: { data } });
}
async function setup(page: Page) {
  const http = await authenticatedApi(page);
  const response = await http.post(api + '/rooms', { data: { name: 'Thinking room ' + randomUUID().slice(0, 8), ageMinMonths: 36, ageMaxMonths: 60, capacity: 12 } });
  expect(response.status()).toBe(201); const room = (await response.json()).data;
  const drafts: Route[] = []; const outside: string[] = [];
  const image = { id: 'loading-picture-1', step: 1, caption: steps[0], width: 128, height: 128 };
  const state = { completed: 0, cancellations: 0 };
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['blob:', 'data:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) outside.push(request.url());
  });
  await page.route(api + '/activity-ai/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (path.endsWith('/images/status')) return respond(route, { enabled: true, available: true, busy: false, model: 'sd_xl_base_1.0.safetensors', message: 'Ready' });
    if (path.endsWith('/activity-ai/status')) return respond(route, { enabled: true, available: true, model: 'browser-model', sourceCount: 0, message: 'Ready' });
    if (path.endsWith('/draft')) { drafts.push(route); return; }
    if (path.endsWith('/images/jobs') && request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBeTruthy();
      return respond(route, { id: 'loading-job', status: 'running', completed: 0, total: 2, images: [] });
    }
    if (path.endsWith('/images/jobs/loading-job')) {
      if (request.method() === 'DELETE') {
        state.cancellations++;
        return respond(route, { id: 'loading-job', status: 'cancelled', completed: 0, total: 2, images: [] });
      }
      return respond(route, { id: 'loading-job', status: 'running', completed: state.completed, total: 2, images: state.completed ? [image] : [] });
    }
    return route.fulfill({ status: 404, headers: cors, json: { error: { message: 'Unexpected loading fixture request.' } } });
  });
  const result = { model: 'browser-model', generatedAt: '2026-11-04T00:00:00Z', sources: [], warnings: [], drafts: [{
    name: 'Shared paper collage', description: 'Prepare large paper shapes, then take turns arranging a shared collage.',
    roomId: room.id, durationMinutes: 20, ageMinMonths: 36, ageMaxMonths: 60, materials: [], materialsNotes: '', sourceIds: [], tutorialLinks: [], visualSteps: steps,
  }] };
  await page.goto('/activities');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  await expect(page.getByRole('button', { name: 'AI activity ideas', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'AI activity ideas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI activity ideas', exact: true });
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
  return { dialog, drafts, result, state, outside };
}
async function fits(page: Page, container: Locator) {
  const size = await container.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width + 1);
  expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  for (const button of await container.getByRole('button').all()) {
    if (!await button.isVisible()) continue;
    const box = await button.boundingBox(); expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.x + box!.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}
function progressValue(progress: Locator, property: 'value' | 'max') {
  return progress.evaluate((element, propertyName) => element.tagName === 'PROGRESS'
    ? (element as HTMLProgressElement)[propertyName]
    : Number(element.getAttribute(propertyName === 'value' ? 'aria-valuenow' : 'aria-valuemax')), property);
}
for (const width of [320, 768, 1280]) test(`creative waiting state stays useful at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(45000); await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { dialog, drafts, result, state, outside } = await setup(page);
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  await expect.poll(() => drafts.length).toBe(1);
  const scene = dialog.locator('.ska-loading-scene:not(.is-compact)');
  await expect(scene).toBeVisible(); await expect(scene.locator('svg.ska-loading-scene__art')).toBeVisible();
  await expect(scene.getByRole('status')).toContainText('Creating ideas on your local AI server…');
  await expect(scene.getByRole('progressbar')).toHaveCount(0); // No invented percentages for unknown generation time.
  await fits(page, dialog); await scene.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('thinking-loading.png') });
  const thought = scene.locator('.ska-loading-scene__thought');
  await expect(thought).not.toHaveCSS('animation-name', 'none');
  await scene.getByRole('button', { name: 'Pause animation', exact: true }).click();
  await expect(thought).toHaveCSS('animation-play-state', 'paused');
  await expect(dialog.getByRole('button', { name: 'Stop AI generation', exact: true })).toBeEnabled();
  await scene.getByRole('button', { name: 'Resume animation', exact: true }).click();
  await expect(thought).toHaveCSS('animation-play-state', 'running');
  await respond(drafts[0], result);
  await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true })).toBeVisible();
  await expect(scene).toHaveCount(0);
  const card = dialog.getByRole('article', { name: 'AI idea 1', exact: true });
  await card.getByRole('button', { name: 'Create step pictures', exact: true }).click();
  const pictures = card.locator('.ska-loading-scene:not(.is-compact)');
  await expect(pictures).toBeVisible();
  const progress = pictures.getByRole('progressbar'); await expect(progress).toBeVisible();
  await expect.poll(() => progressValue(progress, 'value')).toBe(0); await expect.poll(() => progressValue(progress, 'max')).toBe(2);
  state.completed = 1;
  await expect(pictures.getByRole('status')).toContainText('Creating step pictures: 1 of 2 complete.');
  await expect.poll(() => progressValue(progress, 'value')).toBe(1);
  await fits(page, dialog);
  await card.getByRole('button', { name: 'Cancel picture generation', exact: true }).click();
  await expect.poll(() => state.cancellations).toBe(1);
  await expect(pictures).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Review idea 1', exact: true })).toBeEnabled();
  expect(outside).toEqual([]);
});

test('reduced motion stays static and cancellation ignores a late idea response', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  const { dialog, drafts, result } = await setup(page);
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click(); await expect.poll(() => drafts.length).toBe(1);
  const scene = dialog.locator('.ska-loading-scene:not(.is-compact)');
  await expect(scene.getByRole('status')).toContainText('Creating ideas on your local AI server…');
  await expect(scene.locator('.ska-loading-scene__thought')).toHaveCSS('animation-name', 'none');
  await expect(scene.getByRole('button', { name: 'Pause animation', exact: true })).toBeHidden();
  await expect(scene.getByRole('progressbar')).toHaveCount(0); await fits(page, dialog);
  await dialog.getByRole('button', { name: 'Stop AI generation', exact: true }).click();
  await expect(scene).toHaveCount(0); await expect(dialog).toContainText('AI generation stopped.');
  await respond(drafts[0], result).catch(() => {}); // Browsers may discard the already-aborted request.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
});

test('a failed generation removes the waiting animation and keeps retry available', async ({ page }) => {
  const { dialog, drafts } = await setup(page);
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click(); await expect.poll(() => drafts.length).toBe(1);
  await expect(dialog.locator('.ska-loading-scene:not(.is-compact)')).toBeVisible();
  await drafts[0].fulfill({ status: 424, headers: cors, json: { error: { message: 'Synthetic AI unavailable.' } } });
  await expect(dialog.locator('.ska-loading-scene:not(.is-compact)')).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toContainText('Synthetic AI unavailable.');
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
});

test('CCRC inherits static reduced motion and can stop statement reading', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await authenticatedApi(page);
  const uploads: Route[] = [];
  await page.route(statementApi, async route => {
    if (route.request().method() === 'POST') { uploads.push(route); return; }
    return route.continue();
  });
  await page.goto(statementPage);
  await expect(page.getByRole('heading', { name: 'CCRC statements', exact: true })).toBeVisible();
  const payload = JSON.parse(await readFile(new URL('../../../server/tests/fixtures/ccrc-statements/synthetic-photo-png.json', import.meta.url), 'utf8')) as { name: string; contentType: string; dataBase64: string };
  await page.getByLabel('Choose statement file', { exact: true }).setInputFiles({ name: payload.name, mimeType: payload.contentType, buffer: Buffer.from(payload.dataBase64, 'base64') });
  await page.getByRole('button', { name: 'Read statement', exact: true }).click();
  await expect.poll(() => uploads.length).toBe(1);
  const main = page.locator('main'), scene = main.locator('.ska-loading-scene:not(.is-compact)');
  await expect(scene.getByRole('status')).toContainText('Reading the statement locally.');
  await expect(scene.locator('.ska-loading-scene__thought')).toHaveCSS('animation-name', 'none');
  await expect(scene.getByRole('button', { name: 'Pause animation', exact: true })).toBeHidden();
  await expect(scene.getByRole('progressbar')).toHaveCount(0);
  await fits(page, main); await scene.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('ccrc-reduced-motion-loading.png') });
  await main.getByRole('button', { name: 'Stop reading', exact: true }).click();
  await expect(scene).toHaveCount(0); await expect(main.getByRole('alert')).toContainText('Reading stopped.');
  await expect(main.getByRole('button', { name: 'Retry same upload', exact: true })).toBeEnabled();
  await uploads[0].fulfill({ status: 424, headers: cors, json: { error: { message: 'Late synthetic extraction response.' } } }).catch(() => {});
  await expect(main.getByRole('form', { name: 'Review CCRC statement', exact: true })).toHaveCount(0);
});
