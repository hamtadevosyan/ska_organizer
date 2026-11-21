import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { ActivityAiStatus } from './activityAi';
export type SummaryTask = 'room' | 'attendance' | 'inventory' | 'week';
export type AssistantOptions = { tasks: SummaryTask[]; rooms: { id: string; name: string }[]; status: ActivityAiStatus; today: string; weekStart: string };
export type AssistantSummary = { summary: string; sources: { id: string; title: string }[]; task: SummaryTask; takenAt: string; warning: string };
export const assistantUrl = API_BASE_URL + '/api/assistant';
export async function assistantOptions(signal: AbortSignal) {
  return (await axios.get<{ data: AssistantOptions }>(assistantUrl + '/options', { signal })).data.data;
}
export async function assistantSummary(input: { task: SummaryTask; roomId?: string; weekStart?: string }, signal: AbortSignal) {
  return (await axios.post<{ data: AssistantSummary }>(assistantUrl + '/summary', input, { signal })).data.data;
}
