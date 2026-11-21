import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';
let runtime: Server;
let outage = false;
const prompts: unknown[] = [];
test.beforeAll(async () => {
  runtime = createServer(async (req, res) => {
    const send = (body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/status') return send({ cloud: { disabled: true } });
    if (req.url === '/api/tags') return send({ models: [{ name: 'browser-local:latest', size: 1024, digest: 'a'.repeat(64) }] });
    if (req.url === '/api/show') return send({ model_info: { architecture: 'synthetic' } });
    if (req.url !== '/api/generate') return send({}, 404);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); prompts.push(JSON.parse(request.prompt));
    if (outage) return send({}, 503);
    send({ done: true, response: JSON.stringify({ summary: 'This synthetic room has space for twelve children. Check current records before acting.', sourceIds: ['room'] }) });
  });
  await new Promise<void>(resolve => runtime.listen(11439, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>(resolve => runtime.close(() => resolve())); });
for (const width of [320, 390, 1280]) test(`read-only assistant and clear summary fit ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 });
  const http = await authenticatedApi(page);
  const created = await http.post(api + '/rooms', { data: { name: 'Private synthetic class ' + width, ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 } });
  expect(created.status()).toBe(201); const room = (await created.json()).data;
  await page.goto('/assistant');
  await page.getByLabel('Room', { exact: true }).selectOption(room.id);
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI summary' })).toContainText('synthetic room');
  if (width === 390) await page.screenshot({ path: test.info().outputPath('assistant.png'), fullPage: true });
  const sent = JSON.stringify(prompts.at(-1)); expect(sent).not.toContain(room.name); expect(sent).not.toContain(room.id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const element of await page.locator('main button:visible, main select:visible').all()) {
    const box = await element.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: 'Clear summary' }).click();
  await expect(page.getByRole('region', { name: 'AI summary' })).toHaveCount(0);
  outage = true;
  try {
    await page.getByRole('button', { name: 'Summarize', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('link', { name: 'Back to Organizer' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  } finally { outage = false; }
});
