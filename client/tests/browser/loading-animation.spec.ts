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
async function setup(page: Page, busyResponses = 0) {
  const http = await authenticatedApi(page);
  const response = await http.post(api + '/rooms', { data: { name: 'Thinking room ' + randomUUID().slice(0, 8), ageMinMonths: 36, ageMaxMonths: 60, capacity: 12 } });
  expect(response.status()).toBe(201); const room = (await response.json()).data;
  const drafts: Route[] = []; const outside: string[] = [];
  const image = { id: 'loading-picture-1', step: 1, caption: steps[0], width: 128, height: 128 };
  const state = { completed: 0, cancellations: 0, finished: false };
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['blob:', 'data:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) outside.push(request.url());
  });
  await page.route(api + '/activity-ai/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (path.endsWith('/images/status')) return respond(route, { enabled: true, available: true, busy: false, model: 'sd_xl_base_1.0.safetensors', message: 'Ready' });
    if (path.endsWith('/activity-ai/status')) return respond(route, { enabled: true, available: true, model: 'browser-model', sourceCount: 0, message: 'Ready' });
    if (path.endsWith('/draft')) {
      drafts.push(route);
      if (drafts.length <= busyResponses) return route.fulfill({ status: 429, headers: { ...cors, 'Retry-After': '2', 'Access-Control-Expose-Headers': 'Retry-After' },
        json: { error: { code: 'AI_BUSY', message: 'Another AI request is running. Try again shortly.' } } });
      return;
    }
    if (/\/images\/loading-picture-[12]$/.test(path)) return route.fulfill({ status: 200, headers: cors, contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
    if (path.endsWith('/images/jobs') && request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBeTruthy();
      return respond(route, { id: 'loading-job', status: 'running', completed: 0, total: 2, images: [] });
    }
    if (path.endsWith('/images/jobs/loading-job')) {
      if (request.method() === 'DELETE') {
        state.cancellations++;
        return respond(route, { id: 'loading-job', status: 'cancelled', completed: 0, total: 2, images: [] });
      }
      return respond(route, { id: 'loading-job', status: state.finished ? 'complete' : 'running', completed: state.completed, total: 2, images: state.finished ? [image, { ...image, id: 'loading-picture-2', step: 2, caption: steps[1] }] : state.completed ? [image] : [] });
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
  return { dialog, drafts, result, state, outside, http, room };
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
// These checks never scroll a waiting scene into view. The app must bring its
// artwork, status and stop action into the dialog's actual visible viewport.
async function fullyInWaitingViewport(page: Page, dialog: Locator, element: Locator) {
  await expect.poll(async () => {
    const box = await element.boundingBox();
    const bounds = await dialog.evaluate(dialogElement => {
      const rect = dialogElement.getBoundingClientRect();
      const header = dialogElement.querySelector('.app-modal-header')!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      return { left: Math.max(rect.left, left), right: Math.min(rect.right, left + (viewport?.width ?? innerWidth)),
        top: Math.max(header.bottom, top), bottom: Math.min(rect.bottom, top + (viewport?.height ?? innerHeight)) };
    });
    return !!box && box.x >= bounds.left - 1 && box.x + box.width <= bounds.right + 1 &&
      box.y >= bounds.top - 1 && box.y + box.height <= bounds.bottom + 1;
  }, { message: 'The complete waiting control should be visible without scrolling' }).toBe(true);
  await fits(page, dialog);
}
async function waitingView(page: Page, dialog: Locator, stopName: string, label: string) {
  const pending = dialog.locator('.app-modal-pending');
  await expect(pending).toBeVisible();
  await expect(pending).toBeFocused();
  await expect.poll(() => dialog.evaluate(element => element.scrollTop)).toBe(0);
  const scene = pending.locator('.ska-loading-scene:not(.is-compact)');
  await expect(scene.getByRole('status')).toContainText(label);
  await fullyInWaitingViewport(page, dialog, scene.locator('svg.ska-loading-scene__art'));
  await fullyInWaitingViewport(page, dialog, scene.getByRole('status'));
  await fullyInWaitingViewport(page, dialog, pending.getByRole('button', { name: stopName, exact: true }));
  await expect(pending.getByRole('button', { name: stopName, exact: true })).toBeEnabled();
  return { pending, scene };
}
async function motionFrames(element: Locator, milliseconds = 420) {
  return element.evaluate((node, duration) => new Promise<{ y: number; transform: string }[]>(resolve => {
    const frames: { y: number; transform: string }[] = [], start = performance.now();
    function frame(now: number) {
      frames.push({ y: node.getBoundingClientRect().y, transform: getComputedStyle(node).transform });
      if (now - start >= duration) resolve(frames); else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }), milliseconds);
}
async function expectMoving(element: Locator) {
  const frames = await motionFrames(element);
  expect(new Set(frames.map(frame => frame.transform)).size, 'Rendered SVG transforms should change across real frames').toBeGreaterThan(1);
  expect(Math.max(...frames.map(frame => frame.y)) - Math.min(...frames.map(frame => frame.y)), 'Rendered SVG coordinates should move').toBeGreaterThan(.03);
}
async function expectStill(element: Locator) {
  const frames = await motionFrames(element, 240);
  expect(new Set(frames.map(frame => frame.transform)).size).toBe(1);
  expect(Math.max(...frames.map(frame => frame.y)) - Math.min(...frames.map(frame => frame.y))).toBeLessThan(.03);
}
for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 780 }, { width: 768, height: 850 }, { width: 1280, height: 850 }]) {
  test(`text and picture waiting views are visible and animated at ${viewport.width}px`, async ({ page }, testInfo) => {
    test.setTimeout(45000); await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'no-preference' });
    const { dialog, drafts, result, state, outside } = await setup(page);
    const create = dialog.getByRole('button', { name: 'Create AI ideas', exact: true });
    // Scrolling is allowed to reach the initial action, before work starts.
    await create.scrollIntoViewIfNeeded();
    if (viewport.width <= 393) expect(await dialog.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await create.click(); await expect.poll(() => drafts.length).toBe(1);
    const { pending, scene } = await waitingView(page, dialog, 'Stop AI generation', 'Creating ideas on your local AI server…');
    await expect(scene.getByRole('progressbar')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('visible-thinking-loading.png') });
    await page.evaluate(() => document.fonts.ready);
    const thought = scene.locator('.ska-loading-scene__thought');
    await expectMoving(thought);
    await scene.getByRole('button', { name: 'Pause animation', exact: true }).click(); await expectStill(thought);
    await scene.getByRole('button', { name: 'Resume animation', exact: true }).click(); await expectMoving(thought);
    await respond(drafts[0], result);
    await expect(pending).toHaveCount(0);
    const card = dialog.getByRole('article', { name: 'AI idea 1', exact: true });
    await expect(card).toBeVisible();
    const draw = card.getByRole('button', { name: 'Create step pictures', exact: true });
    // Reaching another initial action may scroll the restored results.
    await draw.scrollIntoViewIfNeeded(); await draw.click();
    const pictures = await waitingView(page, dialog, 'Cancel picture generation', 'Creating step pictures: 0 of 2 complete.');
    const progress = pictures.scene.getByRole('progressbar');
    await fullyInWaitingViewport(page, dialog, progress);
    await expect.poll(() => progressValue(progress, 'value')).toBe(0); await expect.poll(() => progressValue(progress, 'max')).toBe(2);
    state.completed = 1;
    await expect(pictures.scene.getByRole('status')).toContainText('Creating step pictures: 1 of 2 complete.');
    await expect.poll(() => progressValue(progress, 'value')).toBe(1);
    await fullyInWaitingViewport(page, dialog, pictures.pending.getByRole('button', { name: 'Cancel picture generation', exact: true }));
    await pictures.pending.getByRole('button', { name: 'Cancel picture generation', exact: true }).click();
    await expect.poll(() => state.cancellations).toBe(1); await expect(pictures.pending).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Review idea 1', exact: true })).toBeEnabled(); expect(outside).toEqual([]);
  });
}

test('pictures for the third idea return to its own gallery when complete', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 780 });
  const { dialog, drafts, result, state } = await setup(page);
  const first = result.drafts[0];
  result.drafts.push({ ...first, name: 'Second paper collage' }, { ...first, name: 'Third paper collage' });
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click(); await expect.poll(() => drafts.length).toBe(1);
  await respond(drafts[0], result);
  const third = dialog.getByRole('article', { name: 'AI idea 3', exact: true });
  const draw = third.getByRole('button', { name: 'Create step pictures', exact: true });
  await draw.scrollIntoViewIfNeeded(); await draw.click();
  const { pending, scene } = await waitingView(page, dialog, 'Cancel picture generation', 'Creating step pictures: 0 of 2 complete.');
  await expect(scene.getByRole('status')).toContainText('Pictures for idea 3.');
  state.completed = 2; state.finished = true;
  await expect(pending).toHaveCount(0);
  const target = third.locator('#activity-ai-picture-result-2');
  await expect(target).toBeFocused();
  const gallery = third.getByRole('region', { name: 'Activity step pictures', exact: true });
  await fullyInWaitingViewport(page, dialog, gallery.getByRole('heading', { name: 'Step pictures', exact: true }));
  await expect(gallery.getByRole('img')).toHaveCount(2);
  await expect(third.getByRole('button', { name: 'Review idea 3', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('third-idea-picture-outcome.png') });
});

test('reduced motion is explained, optional animation moves, and stopping ignores a late idea', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  const { dialog, drafts, result } = await setup(page);
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click(); await expect.poll(() => drafts.length).toBe(1);
  const { pending, scene } = await waitingView(page, dialog, 'Stop AI generation', 'Creating ideas on your local AI server…');
  await expect(scene).toContainText('Reduced motion is on.'); const thought = scene.locator('.ska-loading-scene__thought'); await expectStill(thought);
  await expect(scene.getByRole('button', { name: 'Pause animation', exact: true })).toHaveCount(0);
  const play = scene.getByRole('button', { name: 'Play animation', exact: true });
  await fullyInWaitingViewport(page, dialog, play); await play.click(); await expectMoving(thought);
  await scene.getByRole('button', { name: 'Pause animation', exact: true }).click(); await expectStill(thought);
  await pending.getByRole('button', { name: 'Stop AI generation', exact: true }).click();
  await expect(pending).toHaveCount(0); await expect(dialog).toContainText('AI generation stopped.');
  await respond(drafts[0], result).catch(() => {});
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
});

test('a busy AI waits visibly and retries automatically before showing the ideas', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 780 });
  const { dialog, drafts, result } = await setup(page, 1);
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  const { pending, scene } = await waitingView(page, dialog, 'Stop AI generation', 'Waiting for your activity ideas…');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => drafts.length).toBe(2);
  await expect(scene.getByRole('status')).toContainText('Waiting for your activity ideas…');
  await respond(drafts[1], result); await expect(pending).toHaveCount(0);
  await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true })).toBeVisible();
});

test('stopping while the AI is busy cancels the delayed retry', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const { dialog, drafts } = await setup(page, 10);
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  const { pending } = await waitingView(page, dialog, 'Stop AI generation', 'Waiting for your activity ideas…');
  await pending.getByRole('button', { name: 'Stop AI generation', exact: true }).click(); await expect(pending).toHaveCount(0);
  // Cross the fixture's Retry-After deadline to prove no later POST is sent.
  await page.waitForTimeout(2200); expect(drafts).toHaveLength(1);
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
});

test('a failed generation removes the waiting animation and keeps retry available', async ({ page }) => {
  const { dialog, drafts } = await setup(page);
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click(); await expect.poll(() => drafts.length).toBe(1);
  await expect(dialog.locator('.app-modal-pending')).toBeVisible();
  await drafts[0].fulfill({ status: 424, headers: cors, json: { error: { message: 'Synthetic AI unavailable.' } } });
  await expect(dialog.locator('.app-modal-pending')).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toContainText('Synthetic AI unavailable.');
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
});

test('weekly generation also replaces scrolled settings with visible status and stop', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); const http = await authenticatedApi(page);
  const response = await http.post(api + '/rooms', { data: { name: 'Week waiting ' + randomUUID().slice(0, 8), ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 } });
  expect(response.status()).toBe(201); const room = (await response.json()).data;
  expect((await http.post(api + '/activity', { data: { name: 'Waiting paper activity ' + randomUUID().slice(0, 8), description: 'Arrange large paper pieces.', durationMinutes: 20, ageMinMonths: 24, ageMaxMonths: 60, roomId: room.id, materials: [] } })).status()).toBe(201);
  const requests: Route[] = [];
  await page.route(api + '/schedule/plan/generate', route => { requests.push(route); });
  await page.goto('/activities'); await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  const generate = page.getByRole('button', { name: 'Generate week', exact: true }); await expect(generate).toBeEnabled(); await generate.click();
  const dialog = page.getByRole('dialog', { name: 'Generate week', exact: true });
  const preview = dialog.getByRole('button', { name: 'Preview generated week', exact: true }); await preview.scrollIntoViewIfNeeded();
  expect(await dialog.evaluate(element => element.scrollTop)).toBeGreaterThan(0); await preview.click(); await expect.poll(() => requests.length).toBe(1);
  const { pending } = await waitingView(page, dialog, 'Stop generation', 'Finding activities and checking this week…');
  await pending.getByRole('button', { name: 'Stop generation', exact: true }).click(); await expect(pending).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toContainText('Generation stopped.'); await requests[0].abort().catch(() => {});
});

test('CCRC explains reduced motion, supports optional animation, and can stop reading', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 780 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await authenticatedApi(page);
  const uploads: Route[] = [];
  await page.route(statementApi, async route => { if (route.request().method() === 'POST') { uploads.push(route); return; } return route.continue(); });
  await page.goto(statementPage); await expect(page.getByRole('heading', { name: 'CCRC statements', exact: true })).toBeVisible();
  const payload = JSON.parse(await readFile(new URL('../../../server/tests/fixtures/ccrc-statements/synthetic-photo-png.json', import.meta.url), 'utf8')) as { name: string; contentType: string; dataBase64: string };
  await page.getByLabel('Choose statement file', { exact: true }).setInputFiles({ name: payload.name, mimeType: payload.contentType, buffer: Buffer.from(payload.dataBase64, 'base64') });
  await page.getByRole('button', { name: 'Read statement', exact: true }).click(); await expect.poll(() => uploads.length).toBe(1);
  const main = page.locator('main'), scene = main.locator('.ska-loading-scene:not(.is-compact)');
  await expect(scene.getByRole('status')).toContainText('Reading the statement locally.');
  await expect(scene).toContainText('Reduced motion is on.'); const thought = scene.locator('.ska-loading-scene__thought'); await expectStill(thought);
  await expect(scene.getByRole('button', { name: 'Pause animation', exact: true })).toHaveCount(0);
  await scene.getByRole('button', { name: 'Play animation', exact: true }).click(); await expectMoving(thought);
  await expect(scene.getByRole('progressbar')).toHaveCount(0); await fits(page, main);
  await page.screenshot({ path: testInfo.outputPath('ccrc-optional-animation-loading.png') });
  await main.getByRole('button', { name: 'Stop reading', exact: true }).click(); await expect(scene).toHaveCount(0);
  await expect(main.getByRole('alert')).toContainText('Reading stopped.'); await expect(main.getByRole('button', { name: 'Retry same upload', exact: true })).toBeEnabled();
  await uploads[0].fulfill({ status: 424, headers: cors, json: { error: { message: 'Late synthetic extraction response.' } } }).catch(() => {});
  await expect(main.getByRole('form', { name: 'Review CCRC statement', exact: true })).toHaveCount(0);
});
