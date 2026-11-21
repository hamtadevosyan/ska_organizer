import axios from 'axios';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { activityAiUrl, draftActivityIdeas } from './activityAi';
import type { ActivityAiRequest, ActivityAiResult } from './activityAi';
import { currentSessionSignal, replaceSession } from '../auth/transport';

vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: vi.fn() } };
});
const accessEvents = vi.hoisted(() => ({ expired: new Set<() => void>(), denied: new Set<() => void>() }));
vi.mock('../auth/transport', async importOriginal => {
  const actual = await importOriginal<typeof import('../auth/transport')>();
  return {
    ...actual,
    onSessionExpired: (callback: () => void) => { accessEvents.expired.add(callback); return () => accessEvents.expired.delete(callback); },
    onWorkAccessRequired: (callback: () => void) => { accessEvents.denied.add(callback); return () => accessEvents.denied.delete(callback); },
  };
});
const values: ActivityAiRequest = { roomId: 'synthetic-room', focus: 'balanced', theme: 'Paper shapes', activityCount: 3, durationMinutes: 20 };
const result: ActivityAiResult = { model: 'synthetic-local', generatedAt: '2026-11-05T00:00:00Z', drafts: [], sources: [], warnings: [] };
function response() { return { data: { data: result } }; }
function error(status: number, code: string, retryAfter?: string | number) {
  return new axios.AxiosError('Synthetic request rejected.', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status, statusText: 'Synthetic', data: { error: { code } },
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter }, config: { headers: new axios.AxiosHeaders() },
  });
}
function observe<T>(promise: Promise<T>) { return promise.then(value => ({ value }), failure => ({ failure })); }
beforeEach(() => { vi.clearAllMocks(); replaceSession(); accessEvents.expired.clear(); accessEvents.denied.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z')); });
afterEach(() => {
  vi.useRealTimers();
  expect(accessEvents.expired.size).toBe(0); expect(accessEvents.denied.size).toBe(0);
});

test('busy admission waits and retries one request while retaining its values, signal and phase callbacks', async () => {
  const phases: string[] = [], signal = new AbortController().signal;
  let complete!: (value: ReturnType<typeof response>) => void;
  vi.mocked(axios.post).mockRejectedValueOnce(error(429, 'AI_BUSY', '2'))
    .mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const pending = draftActivityIdeas(values, signal, { onWaiting: () => phases.push('waiting'), onRunning: () => phases.push('running') });
  await vi.advanceTimersByTimeAsync(0);
  expect(phases).toEqual(['running', 'waiting']); expect(axios.post).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999); expect(axios.post).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(phases).toEqual(['running', 'waiting', 'running']); expect(axios.post).toHaveBeenCalledTimes(2);
  // Once admitted, a slow generation is never replayed by the queue timer.
  await vi.advanceTimersByTimeAsync(120000); expect(axios.post).toHaveBeenCalledTimes(2);
  complete(response()); expect(await pending).toEqual(result);
  for (const call of vi.mocked(axios.post).mock.calls) expect(call).toEqual([activityAiUrl + '/draft', values, { signal: expect.any(AbortSignal) }]);
  expect(vi.mocked(axios.post).mock.calls[0][2]!.signal).toBe(vi.mocked(axios.post).mock.calls[1][2]!.signal);
  expect(vi.getTimerCount()).toBe(0);
});

test('cancelling a busy wait immediately clears the delay and cannot send a late retry', async () => {
  const controller = new AbortController(), waiting = vi.fn(), running = vi.fn();
  vi.mocked(axios.post).mockRejectedValue(error(429, 'AI_BUSY'));
  const pending = observe(draftActivityIdeas(values, controller.signal, { onWaiting: waiting, onRunning: running }));
  await vi.advanceTimersByTimeAsync(0); expect(waiting).toHaveBeenCalledOnce();
  controller.abort(); const outcome = await pending;
  expect('failure' in outcome && axios.isCancel(outcome.failure)).toBe(true); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(120000);
  expect(axios.post).toHaveBeenCalledOnce(); expect(running).toHaveBeenCalledOnce();
});

test('pre-cancelled requests and cancellation at the retry boundary never start another POST', async () => {
  const before = new AbortController(); before.abort();
  const first = await observe(draftActivityIdeas(values, before.signal));
  expect('failure' in first && axios.isCancel(first.failure)).toBe(true); expect(axios.post).not.toHaveBeenCalled();
  const controller = new AbortController(); let starts = 0;
  vi.mocked(axios.post).mockRejectedValue(error(429, 'AI_BUSY', '1'));
  const pending = observe(draftActivityIdeas(values, controller.signal, { onRunning: () => { if (++starts === 2) controller.abort(); } }));
  await vi.advanceTimersByTimeAsync(1000);
  const outcome = await pending;
  expect('failure' in outcome && axios.isCancel(outcome.failure)).toBe(true); expect(axios.post).toHaveBeenCalledOnce();
});

test.each(['expired', 'denied'] as const)('an %s access event cancels an idle busy wait and cannot replay under changed access', async kind => {
  vi.mocked(axios.post).mockRejectedValue(error(429, 'AI_BUSY'));
  const pending = observe(draftActivityIdeas(values, new AbortController().signal));
  await vi.advanceTimersByTimeAsync(0);
  expect(accessEvents[kind].size).toBe(1);
  accessEvents[kind].forEach(callback => callback());
  const outcome = await pending;
  expect('failure' in outcome && axios.isCancel(outcome.failure)).toBe(true);
  expect(vi.mocked(axios.post).mock.calls[0][2]!.signal!.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(120000); expect(axios.post).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('replacing the real transport session cancels queued generation before a retry can adopt the new session', async () => {
  const originalSession = currentSessionSignal(), caller = new AbortController();
  vi.mocked(axios.post).mockRejectedValueOnce(error(429, 'AI_BUSY', '2'));
  const pending = observe(draftActivityIdeas(values, caller.signal));
  await vi.advanceTimersByTimeAsync(0);
  expect(axios.post).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
  replaceSession('synthetic-replacement');
  const outcome = await pending;
  expect('failure' in outcome && axios.isCancel(outcome.failure)).toBe(true);
  expect(originalSession.aborted).toBe(true); expect(currentSessionSignal().aborted).toBe(false);
  expect(caller.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(120000); expect(axios.post).toHaveBeenCalledOnce();
  vi.mocked(axios.post).mockResolvedValueOnce(response());
  expect(await draftActivityIdeas(values, caller.signal)).toEqual(result);
  expect(axios.post).toHaveBeenCalledTimes(2);
});

test.each([
  ['2', 2000], [2, 2000], ['0', 1000], ['99999999999999999999999999', 30000],
  ['-1', 5000], ['1.5', 5000], ['not a delay', 5000], ['', 5000],
  ['Thu, 05 Nov 2026 00:00:07 GMT', 7000], ['Wed, 04 Nov 2026 23:59:59 GMT', 1000],
] as const)('Retry-After %j uses a bounded delay of %dms', async (header, delay) => {
  vi.mocked(axios.post).mockRejectedValueOnce(error(429, 'AI_BUSY', header)).mockResolvedValueOnce(response());
  const pending = draftActivityIdeas(values, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(delay - 1); expect(axios.post).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual(result); expect(axios.post).toHaveBeenCalledTimes(2);
});

test('AxiosHeaders retry metadata is read without losing its receiver', async () => {
  const busy = error(429, 'AI_BUSY'); busy.response!.headers = new axios.AxiosHeaders({ 'Retry-After': '3' });
  vi.mocked(axios.post).mockRejectedValueOnce(busy).mockResolvedValueOnce(response());
  const pending = draftActivityIdeas(values, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2999); expect(axios.post).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual(result);
});

test('persistent busy responses stop at the wait deadline and preserve the server error', async () => {
  const busy = error(429, 'AI_BUSY'), waiting = vi.fn();
  vi.mocked(axios.post).mockRejectedValue(busy);
  const pending = observe(draftActivityIdeas(values, new AbortController().signal, { onWaiting: waiting }));
  await vi.advanceTimersByTimeAsync(119999);
  expect(waiting).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ failure: busy });
  expect(vi.mocked(axios.post).mock.calls.length).toBeGreaterThan(1); expect(vi.mocked(axios.post).mock.calls.length).toBeLessThanOrEqual(25);
  expect(vi.getTimerCount()).toBe(0);
});

test('a retry count bound also protects against repeated immediate-retry responses', async () => {
  const busy = error(429, 'AI_BUSY', '0'); vi.mocked(axios.post).mockRejectedValue(busy);
  const pending = observe(draftActivityIdeas(values, new AbortController().signal));
  await vi.advanceTimersByTimeAsync(120000);
  expect(await pending).toEqual({ failure: busy }); expect(vi.mocked(axios.post).mock.calls.length).toBeLessThanOrEqual(25);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  error(401, 'AI_BUSY'), error(403, 'WORK_CHECK_IN_REQUIRED'), error(424, 'AI_TIMEOUT'), error(500, 'AI_BUSY'),
  error(429, 'RATE_LIMITED'), new axios.AxiosError('Timeout', 'ECONNABORTED'), new Error('Disconnected'),
  { response: { status: 429, data: { error: { code: 'AI_BUSY' } } } },
])('does not replay a failed or uncertain POST: %#', async failure => {
  const waiting = vi.fn(); vi.mocked(axios.post).mockRejectedValueOnce(failure);
  await expect(draftActivityIdeas(values, new AbortController().signal, { onWaiting: waiting })).rejects.toBe(failure);
  await vi.runAllTimersAsync(); expect(axios.post).toHaveBeenCalledOnce(); expect(waiting).not.toHaveBeenCalled();
});

test('a late successful response after cancellation is discarded', async () => {
  const controller = new AbortController(); let finish!: (value: ReturnType<typeof response>) => void;
  vi.mocked(axios.post).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = observe(draftActivityIdeas(values, controller.signal));
  controller.abort(); finish(response()); const outcome = await pending;
  expect('failure' in outcome && axios.isCancel(outcome.failure)).toBe(true); expect(axios.post).toHaveBeenCalledOnce();
});
