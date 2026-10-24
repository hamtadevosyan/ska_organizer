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
    const drafts = Array.from({ length: Number(prompt.activityCount) }, (_, index) => ({
      name: 'Color turn taking ' + prompt.theme + ' ' + (index + 1),
      description: 'Invite children to sort large colored shapes. Take turns describing the choices. Adapt the grouping and language to the children; supervise the materials.',
      durationMinutes: prompt.durationMinutes,
      materialsNotes: 'Large colored shapes; review quantities and link available Inventory materials before planning.',
      sourceIds: ['synthetic-turn-taking'],
    }));
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
    const { http, room, stock, suffix } = await setup(page);
    const before = await catalog(http); const original = await getPlan(http, room);
    const dialog = await open(page);
    await dialog.getByLabel('Theme (optional)', { exact: true }).fill('Sorting ' + suffix);
    await dialog.getByLabel('Number of ideas', { exact: true }).fill('1');
    await fits(page, dialog);
    await dialog.getByRole('button', { name: 'Create AI ideas', exact: true }).click();
    await expect(dialog.getByRole('article', { name: 'AI idea 1', exact: true })).toContainText('Color turn taking');
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
    const name = 'Reviewed sorting ' + suffix;
    await form.getByLabel('Activity name', { exact: true }).fill(name);
    await form.getByLabel('Minutes', { exact: true }).fill('25');
    await fits(page, dialog);
    await form.getByRole('button', { name: 'Save activity', exact: true }).click();
    await expect(dialog).toContainText('Activity saved to your library.');
    const saved = (await catalog(http)).find(activity => activity.name === name)!;
    expect(saved).toMatchObject({ durationMinutes: 25, roomId: room.id, ageMinMonths: 24, ageMaxMonths: 60 });
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
    expect(plan.entries).toHaveLength(1); expect(plan.entries[0].activity).toMatchObject({ id: saved.id, name, durationMinutes: 25 });
    expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + stock.id))).quantity).toBe('10');
  });
}

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
