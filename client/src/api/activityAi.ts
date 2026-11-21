import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { currentSessionSignal, onSessionExpired, onWorkAccessRequired } from '../auth/transport';
import type { ActivityDetails } from './activities';

export type ActivityAiFocus = 'balanced' | 'language' | 'creative' | 'physical' | 'discovery' | 'social';
export type ActivityAiSource = { id: string; title: string; publisher: string; version: string; section: string; kind: 'education' | 'policy' | 'regulation'; text: string };
export type ActivityAiDraft = ActivityDetails & { sourceIds: string[]; visualSteps?: string[] };
export type ActivityAiResult = { model: string; generatedAt: string; drafts: ActivityAiDraft[]; sources: ActivityAiSource[]; warnings: string[] };
export type ActivityAiStatus = { enabled: boolean; available: boolean; model: string | null; sourceCount: number; message: string; code?: string };
export type ActivityAiRequest = { roomId: string; focus: ActivityAiFocus; theme: string; activityCount: number; durationMinutes: number; includeVideos?: boolean; avoidNames?: string[] };
export const activityAiUrl = API_BASE_URL + '/api/activity-ai';
export async function activityAiStatus(signal: AbortSignal) {
  return (await axios.get<{ data: ActivityAiStatus }>(activityAiUrl + '/status', { signal })).data.data;
}
type DraftCallbacks = { onWaiting?: () => void; onRunning?: () => void };
const busyWaitLimit = 120000;
const busyAttemptLimit = 25;
function cancelled() { return new axios.CanceledError('Activity generation stopped.'); }
function checkCancelled(signal: AbortSignal) { if (signal.aborted) throw cancelled(); }
function waitForAi(milliseconds: number, signal: AbortSignal) {
  checkCancelled(signal);
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function retryDelay(headers: unknown) {
  const fields = headers as { get?: (name: string) => unknown; [name: string]: unknown } | undefined;
  const value = typeof fields?.get === 'function' ? fields.get('retry-after') : fields?.['retry-after'] ?? fields?.['Retry-After'];
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  let milliseconds = 5000;
  if (/^\d+$/.test(raw)) milliseconds = Number(raw) * 1000;
  else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(raw) && raw.length <= 128) {
    const date = Date.parse(raw);
    if (Number.isFinite(date)) milliseconds = date - Date.now();
  }
  return Math.max(1000, Math.min(30000, milliseconds));
}
export async function draftActivityIdeas(values: ActivityAiRequest, signal: AbortSignal, callbacks: DraftCallbacks = {}) {
  // A session can change while no HTTP request is active during backoff.
  // Capture its signal once so a queued request cannot adopt different access.
  const access = new AbortController();
  const expired = onSessionExpired(() => access.abort());
  const denied = onWorkAccessRequired(() => access.abort());
  const requestSignal = AbortSignal.any([signal, currentSessionSignal(), access.signal]);
  try {
    let deadline = 0, waited = 0;
    for (let attempt = 1; ; attempt++) {
      checkCancelled(requestSignal); callbacks.onRunning?.(); checkCancelled(requestSignal);
      try {
        const response = await axios.post<{ data: ActivityAiResult }>(activityAiUrl + '/draft', values, { signal: requestSignal });
        checkCancelled(requestSignal);
        return response.data.data;
      } catch (error) {
        checkCancelled(requestSignal);
        // Only an explicit admission rejection is safe to replay. A disconnected,
        // timed-out or failed POST might already be generating on the laptop.
        if (!axios.isAxiosError(error) || error.response?.status !== 429 || error.response.data?.error?.code !== 'AI_BUSY') throw error;
        if (!deadline) deadline = Date.now() + busyWaitLimit;
        const remaining = Math.min(deadline - Date.now(), busyWaitLimit - waited);
        if (remaining <= 0 || attempt >= busyAttemptLimit) throw error;
        const delay = Math.min(retryDelay(error.response.headers), remaining);
        callbacks.onWaiting?.();
        await waitForAi(delay, requestSignal); waited += delay;
        if (Date.now() >= deadline || waited >= busyWaitLimit) throw error;
      }
    }
  } finally { expired(); denied(); }
}
