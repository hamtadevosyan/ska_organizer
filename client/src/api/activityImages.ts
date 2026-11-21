import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { Illustration } from './activities';

export type ActivityImageStatus = { enabled: boolean; available: boolean; busy: boolean; model: string | null; message: string };
export type ActivityImageJob = { id: string; status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  completed: number; total: number; images: Illustration[]; message?: string };
const base = API_BASE_URL + '/api/activity-ai/images';
export async function activityImageStatus(signal: AbortSignal) {
  return (await axios.get<{ data: ActivityImageStatus }>(base + '/status', { signal })).data.data;
}
export async function createActivityImageJob(values: { name: string; description: string; steps: string[] }, signal: AbortSignal) {
  return (await axios.post<{ data: ActivityImageJob }>(base + '/jobs', values, { signal })).data.data;
}
export async function readActivityImageJob(id: string, signal: AbortSignal) {
  return (await axios.get<{ data: ActivityImageJob }>(base + '/jobs/' + encodeURIComponent(id), { signal })).data.data;
}
export async function cancelActivityImageJob(id: string) {
  return (await axios.delete<{ data: ActivityImageJob }>(base + '/jobs/' + encodeURIComponent(id))).data.data;
}
export async function readActivityImage(id: string, classroom: boolean, signal: AbortSignal) {
  const path = classroom ? '/api/classroom/activity-images/' : '/api/activity-ai/images/';
  const result = await axios.get<Blob>(API_BASE_URL + path + encodeURIComponent(id), { signal, responseType: 'blob' });
  if (!(result.data instanceof Blob) || result.data.type !== 'image/png' || result.data.size < 1 || result.data.size > 8 * 1024 * 1024) {
    throw new Error('The server did not return a usable step picture.');
  }
  return result.data;
}
