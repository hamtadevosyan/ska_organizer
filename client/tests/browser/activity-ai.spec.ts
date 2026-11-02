import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { expect, test } from '@playwright/test';
import type { APIResponse, Locator, Page } from '@playwright/test';
import type { Activity, ActivityPlan } from '../../src/api/activities';
import type { Room } from '../../src/api/rooms';
import { api, authenticatedApi } from './auth-helpers';

// This is a local HTTP substitute for the inference engine, not the Organizer
// API. Authentication, room reads, validation, catalog saves and weekly saves
// all pass through the ordinary application server.
let runtime: Server;
const prompts: Record<string, unknown>[] = [];
let stoppedRequests = 0;
const generatedGuide = {
  purpose: 'Explore shape names while making a shared paper collage and practicing turn taking.',
  preparation: 'An adult prepares large paper shapes, a sheet of paper and washable glue at a clear table.',
  steps: [
    'Show a large paper circle and square, name them together, and invite children to feel the edges.',
    'Offer each child a choice of large shapes and help them describe a color or shape to a partner.',
    'Demonstrate placing a shape on the shared paper, then support children to take turns adding theirs.',
    'Help children attach their chosen shapes with washable glue and describe the finished shared collage.',
  ],
  conversationPrompts: ['What do you notice about the edges?', 'Where would you like to put your shape?'],
  adaptations: 'Offer younger children two large shape choices; invite older children to describe how shapes fit together.',
  safety: 'An adult supervises throughout, prepares cut shapes, and keeps glue and paper away from mouths.',
  cleanup: 'Collect spare paper, put the collage aside to dry, wipe the table and help everyone wash their hands.',
};
const tutorial = {
  title: 'Create Colorful Collages to Learn About Shapes', publisher: 'PBS SoCal — Family Math',
  url: 'https://www.pbs.org/video/create-colorful-collages-to-learn-about-shapes/',
};
const draftNotice = 'AI-assisted educational draft. Review safety and suitability before use.';
test.beforeAll(async () => {
  runtime = createServer(async (request, response) => {
    const send = (body: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url === '/api/status') return send({ cloud: { disabled: true, source: 'synthetic browser fixture' } });
    if (request.url === '/api/tags') return send({ models: [{ name: 'browser-local:latest', size: 1024, digest: 'a'.repeat(64) }] });
    if (request.url === '/api/show') return send({ model_info: { 'general.architecture': 'synthetic' }, details: { family: 'synthetic' }, capabilities: ['completion'] });
    if (request.url !== '/api/generate') return send({ error: 'Unexpected test endpoint' }, 404);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const prompt = JSON.parse(input.prompt) as Record<string, unknown>;
    prompts.push(prompt);
    if (prompt.theme === 'Synthetic outage') return send({ error: 'Synthetic unavailable engine' }, 503);
    if (prompt.theme === 'Slow sorting') {
      response.once('close', () => { stoppedRequests++; });
      return; // The test must cancel the request; no timeout sleeps are needed.
    }
    const avoided = new Set(Array.isArray(prompt.avoidNames) ? prompt.avoidNames : []);
    let next = 1;
    const drafts = Array.from({ length: Number(prompt.activityCount) }, () => {
      let name: string;
      do { name = 'Shape collage ' + prompt.theme + ' ' + next++; } while (avoided.has(name));
      avoided.add(name);
      return { name, ...generatedGuide,
        durationMinutes: prompt.durationMinutes,
        materialsNotes: 'Large colored shapes; review quantities and link available Inventory materials before planning.',
        sourceIds: Array.isArray(prompt.sources) && prompt.sources.some(value => value.id === 'synthetic-turn-taking') ? ['synthetic-turn-taking'] : [],
        videoIds: [],
      };
    });
    return send({ model: 'browser-local:latest', done: true, response: JSON.stringify({ drafts }) });
  });
  await new Promise<void>((resolve, reject) => { runtime.once('error', reject); runtime.listen(11439, '127.0.0.1', resolve); });
});
test.afterAll(async () => { runtime?.closeAllConnections(); await new Promise<void>(resolve => runtime?.close(() => resolve())); });

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
const week = '2026-10-26';
async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}
async function setup(page: Page) {
  const http = await authenticatedApi(page);
  const suffix = randomUUID().slice(0, 8);
  const room = await data<Room>(await http.post(api + '/rooms', { data: { name: 'Private room name ' + suffix, ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 } }), 201);
  const stock = await data<{ id: string; quantity: string }>(await http.post(api + '/inventory', { data: { name: 'Shapes ' + suffix, category: 'Classroom', location: 'Cupboard', unit: 'count', openingQuantity: '10', reorderThreshold: '0', reason: 'Synthetic browser stock', requestId: randomUUID() } }), 201);
  await page.goto('/activities');
  await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
  await page.getByLabel('Week starting Monday', { exact: true }).fill(week);
  await expect(page.getByRole('button', { name: 'AI activity ideas', exact: true })).toBeEnabled();
  return { http, room, stock, suffix };
}
const getPlan = (http: Http, room: Room) => http.get(`${api}/schedule/plan?roomId=${room.id}&weekStart=${week}`).then(response => data<ActivityPlan>(response));
const catalog = (http: Http) => http.get(api + '/activity').then(response => data<Activity[]>(response));
async function open(page: Page) {
  await page.getByRole('button', { name: 'AI activity ideas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI activity ideas', exact: true });
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
  return dialog;
}
async function fits(page: Page, dialog: Locator) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const size = await dialog.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width + 1);
  expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  for (const control of await dialog.locator('button:visible, select:visible, input:not([type="checkbox"]):not([type="radio"]):visible').all()) {
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}

for (const width of [320, 390, 1280]) {
  test(`local AI ideas are reviewed and saved before they can enter a week at ${width}px`, async ({ page }) => {
    test.setTimeout(60000); await page.setViewportSize({ width, height: 900 });
    const outsideRequests: string[] = [];
    page.on('request', request => {
      if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) outsideRequests.push(request.url());
    });
    const { http, room, stock, suffix } = await setup(page);
    const before = await catalog(http); const original = await getPlan(http, room);
    const dialog = await open(page);
    await dialog.getByLabel('Theme (optional)', { exact: true }).fill('Sorting ' + suffix);
    await dialog.getByLabel('Number of ideas', { exact: true }).fill('1');
    await fits(page, dialog);
    await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
    const idea = dialog.getByRole('article', { name: 'AI idea 1', exact: true });
    await expect(idea).toContainText('Shape collage');
    for (const heading of ['Purpose:', 'Preparation:', 'How to do it:', 'Ask the children:', 'Adaptations:', 'Supervision and safety:', 'Cleanup:']) {
      await expect(idea).toContainText(heading);
    }
    for (const step of generatedGuide.steps) await expect(idea).toContainText(step);
    const videoLink = idea.getByRole('link', { name: new RegExp(tutorial.title) });
    await expect(videoLink).toHaveAttribute('href', tutorial.url);
    await expect(videoLink).toHaveAttribute('target', '_blank');
    await expect(videoLink).toHaveAttribute('rel', /noopener/);
    await expect(videoLink).toHaveAttribute('rel', /noreferrer/);
    await expect(videoLink).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(dialog.locator('iframe, video, object, embed, img[src^="https://"]')).toHaveCount(0);
    expect(outsideRequests).toEqual([]);
    await dialog.getByText('Planning sources (1)', { exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '[synthetic-turn-taking] Synthetic classroom learning reference', exact: true })).toBeVisible();
    await expect(dialog).toContainText('2026-10-synthetic'); await expect(dialog).toContainText('Turn taking and sorting');
    await fits(page, dialog);
    expect(await catalog(http)).toEqual(before); expect(await getPlan(http, room)).toEqual(original);
    const prompt = prompts.at(-1)!;
    expect(prompt).toMatchObject({ ageMinMonths: 24, ageMaxMonths: 60, activityCount: 1, durationMinutes: 20 });
    expect(JSON.stringify(prompt)).not.toContain(room.id); expect(JSON.stringify(prompt)).not.toContain(room.name);
    await dialog.getByRole('button', { name: 'Review idea 1', exact: true }).click();
    const form = dialog.getByRole('form', { name: 'New activity', exact: true });
    await expect(form.getByLabel('Minimum age (months)', { exact: true })).toHaveValue('24');
    await expect(form.getByLabel('Maximum age (months)', { exact: true })).toHaveValue('60');
    const description = form.getByLabel('Description', { exact: true });
    const initialDescription = await description.inputValue();
    expect(initialDescription.startsWith('Purpose: ' + generatedGuide.purpose)).toBe(true);
    for (const [index, step] of generatedGuide.steps.entries()) expect(initialDescription).toContain(`${index + 1}. ${step}`);
    expect(initialDescription).toContain('\n\n' + draftNotice + '\n\nPlanning references:');
    expect(initialDescription).toContain('[synthetic-turn-taking]');
    expect(initialDescription).toContain('2026-10-synthetic');
    await expect(form.getByRole('link', { name: new RegExp(tutorial.title) })).toHaveAttribute('href', tutorial.url);
    const reviewedDescription = initialDescription + '\n\nTeacher review: Use large washable shapes and supervised turns.';
    await description.fill(reviewedDescription);
    const name = 'Reviewed sorting ' + suffix;
    await form.getByLabel('Activity name', { exact: true }).fill(name);
    await form.getByLabel('Minutes', { exact: true }).fill('25');
    await fits(page, dialog);
    const saveRequest = page.waitForRequest(request => request.url() === api + '/activity' && request.method() === 'POST');
    await form.getByRole('button', { name: 'Save activity', exact: true }).click();
    expect((await saveRequest).postDataJSON()).toMatchObject({ description: reviewedDescription, tutorialLinks: [tutorial] });
    await expect(dialog).toContainText('Activity saved to your library.');
    const saved = (await catalog(http)).find(activity => activity.name === name)!;
    expect(saved).toMatchObject({ description: reviewedDescription, durationMinutes: 25, roomId: room.id, ageMinMonths: 24, ageMaxMonths: 60, tutorialLinks: [tutorial] });
    expect(await getPlan(http, room)).toEqual(original);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (await dialog.getByRole('button', { name: 'Discard AI ideas', exact: true }).isVisible()) await dialog.getByRole('button', { name: 'Discard AI ideas', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Generate week', exact: true }).click();
    const generation = page.getByRole('dialog', { name: 'Generate week', exact: true });
    for (const day of ['Tuesday', 'Wednesday', 'Thursday', 'Friday']) await generation.getByRole('checkbox', { name: 'Plan ' + day, exact: true }).uncheck();
    await generation.getByRole('button', { name: 'Preview generated week', exact: true }).click();
    await expect(generation.getByRole('combobox', { name: 'Suggested activity 1', exact: true })).toHaveValue(saved.id);
    await generation.getByRole('button', { name: 'Use generated plan', exact: true }).click();
    expect(await getPlan(http, room)).toEqual(original);
    await page.getByRole('button', { name: 'Save week', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save week', exact: true })).toBeDisabled();
    const plan = await getPlan(http, room);
    expect(plan.entries).toHaveLength(1); expect(plan.entries[0].activity).toMatchObject({ id: saved.id, name, description: reviewedDescription, durationMinutes: 25, tutorialLinks: [tutorial] });
    await page.reload();
    await page.getByRole('combobox', { name: 'Room', exact: true }).selectOption(room.id);
    await page.getByLabel('Week starting Monday', { exact: true }).fill(week);
    const savedEntry = page.getByRole('group', { name: 'Monday activity 1', exact: true });
    await savedEntry.getByText('Instructions & materials', { exact: true }).click();
    await expect(savedEntry.getByRole('link', { name: new RegExp(tutorial.title) })).toHaveAttribute('href', tutorial.url);
    expect(outsideRequests).toEqual([]);
    expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + stock.id))).quantity).toBe('10');
  });
}

test('video examples can be disabled while full activity instructions remain available', async ({ page }) => {
  test.setTimeout(60000); await page.setViewportSize({ width: 390, height: 900 });
  await setup(page);
  const dialog = await open(page);
  await dialog.getByLabel('Theme (optional)', { exact: true }).fill('Shape collages without video');
  await dialog.getByLabel('Number of ideas', { exact: true }).fill('1');
  await dialog.getByRole('checkbox', { name: 'Include related how-to videos when available', exact: true }).uncheck();
  const drafted = page.waitForResponse(response => response.url() === api + '/activity-ai/draft' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  const response = await drafted;
  expect(response.status()).toBe(200);
  expect((await response.json()).data.drafts[0].tutorialLinks).toEqual([]);
  expect(prompts.at(-1)?.videoExamples).toEqual([]);
  const idea = dialog.getByRole('article', { name: 'AI idea 1', exact: true });
  await expect(idea).toContainText(generatedGuide.steps[3]);
  await expect(idea.getByRole('link')).toHaveCount(0);
});

test('create more sends recent suggestion names and shows a different batch without reading private library titles', async ({ page }) => {
  test.setTimeout(60000); await page.setViewportSize({ width: 390, height: 900 });
  const { http, room, suffix } = await setup(page);
  const privateTitle = 'Private library title ' + suffix;
  await data<Activity>(await http.post(api + '/activity', { data: { name: privateTitle, description: 'Synthetic private catalog instructions.',
    durationMinutes: 20, ageMinMonths: 24, ageMaxMonths: 60, roomId: room.id, materials: [] } }), 201);
  const before = await catalog(http), original = await getPlan(http, room);
  const dialog = await open(page);
  await dialog.getByLabel('Theme (optional)', { exact: true }).fill('Fresh collage ' + suffix);
  const firstDraft = page.waitForResponse(response => response.url() === api + '/activity-ai/draft' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  const first = await data<{ drafts: Activity[] }>(await firstDraft);
  const firstNames = first.drafts.map(value => value.name);
  await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true })).toContainText(firstNames[0]);
  expect(prompts.at(-1)?.avoidNames).toEqual([]);
  expect(prompts.at(-1)?.videoExamples).toEqual([]);

  const requested = page.waitForRequest(request => request.url() === api + '/activity-ai/draft' && request.method() === 'POST');
  const secondDraft = page.waitForResponse(response => response.url() === api + '/activity-ai/draft' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create more AI ideas', exact: true }).click();
  expect((await requested).postDataJSON()).toMatchObject({ avoidNames: firstNames });
  const second = await data<{ drafts: Activity[] }>(await secondDraft);
  const secondNames = second.drafts.map(value => value.name);
  expect(secondNames.every(name => !firstNames.includes(name))).toBe(true);
  const idea = dialog.getByRole('article', { name: 'AI idea 1', exact: true });
  await expect(idea).toContainText(secondNames[0]);
  await expect(idea).toContainText(generatedGuide.steps[3]);
  await expect(idea.getByRole('link', { name: new RegExp(tutorial.title) })).toHaveAttribute('href', tutorial.url);
  const prompt = prompts.at(-1)!;
  expect(prompt.avoidNames).toEqual(firstNames);
  expect(JSON.stringify(prompt)).not.toContain(privateTitle);
  expect(JSON.stringify(prompt)).not.toContain(room.name);
  expect(JSON.stringify(prompt)).not.toContain(room.id);
  expect(await catalog(http)).toEqual(before);
  expect(await getPlan(http, room)).toEqual(original);
  await fits(page, dialog);
});

test('an unavailable local engine leaves the manual planner usable and a cancelled request returns no ideas', async ({ page }) => {
  test.setTimeout(60000); await page.setViewportSize({ width: 390, height: 900 });
  const { http, room } = await setup(page); const original = await getPlan(http, room);
  let dialog = await open(page);
  await dialog.getByLabel('Theme (optional)', { exact: true }).fill('Synthetic outage');
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard AI ideas', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add activity', exact: true })).toBeEnabled();
  dialog = await open(page);
  await dialog.getByLabel('Theme (optional)', { exact: true }).fill('Slow sorting');
  const previous = prompts.length; const closed = stoppedRequests;
  await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
  await expect.poll(() => prompts.length).toBe(previous + 1);
  await dialog.getByRole('button', { name: 'Stop AI generation', exact: true }).click();
  await expect.poll(() => stoppedRequests).toBe(closed + 1);
  await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create AI ideas', exact: true })).toBeEnabled();
  expect(await getPlan(http, room)).toEqual(original);
});
