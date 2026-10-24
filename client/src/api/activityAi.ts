import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { ActivityDetails } from './activities';

export type ActivityAiFocus = 'balanced' | 'language' | 'creative' | 'physical' | 'discovery' | 'social';
export type ActivityAiSource = { id: string; title: string; publisher: string; version: string; section: string; kind: 'education' | 'policy' | 'regulation'; text: string };
export type ActivityAiDraft = ActivityDetails & { sourceIds: string[] };
export type ActivityAiResult = { model: string; generatedAt: string; drafts: ActivityAiDraft[]; sources: ActivityAiSource[]; warnings: string[] };
export type ActivityAiStatus = { enabled: boolean; available: boolean; model: string | null; sourceCount: number; message: string; code?: string };
export type ActivityAiRequest = { roomId: string; focus: ActivityAiFocus; theme: string; activityCount: number; durationMinutes: number };
export const activityAiUrl = API_BASE_URL + '/api/activity-ai';
export async function activityAiStatus(signal: AbortSignal) {
  return (await axios.get<{ data: ActivityAiStatus }>(activityAiUrl + '/status', { signal })).data.data;
}
export async function draftActivityIdeas(values: ActivityAiRequest, signal: AbortSignal) {
  return (await axios.post<{ data: ActivityAiResult }>(activityAiUrl + '/draft', values, { signal })).data.data;
}
