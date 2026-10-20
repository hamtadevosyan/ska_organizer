import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

export type ClassroomRoom = { id: string; name: string; ageMinMonths: number | null; ageMaxMonths: number | null; capacity: number | null };
export type ClassroomScope = { state: 'assigned' | 'unassigned' | 'unavailable'; room: ClassroomRoom | null };
export type ClassroomOverview = ClassroomScope & { today: string; timeZone: string; activeChildCount: number };
export type ClassroomChildren = ClassroomScope & { items: { id: string; firstName: string; lastName: string; preferredName: string | null }[]; total: number };
export type ClassroomActivities = ClassroomScope & { weekStart: string; hasPlan: boolean; version: number; savedAt: string | null; entries: {
  id: string; date: string; startTime: string | null; endTime: string | null; timeBlock: string | null;
  activity: { name: string; description: string; durationMinutes: number | null };
}[] };
export type ClassroomMeals = ClassroomScope & { weekStart: string; hasPlan: boolean; version: number; savedAt: string | null; scope: 'facility';
  week: { day: string; meals: { slot: string; name: string; type: string }[] }[] };
const base = API_BASE_URL + '/api/classroom';
async function read<T>(path: string, signal?: AbortSignal) {
  return (await axios.get<{ data: T }>(base + path, { signal })).data.data;
}
export const getClassroomOverview = (signal?: AbortSignal) => read<ClassroomOverview>('', signal);
export const getClassroomChildren = (signal?: AbortSignal) => read<ClassroomChildren>('/children', signal);
export const getClassroomActivities = (weekStart: string, signal?: AbortSignal) => read<ClassroomActivities>('/activities?weekStart=' + encodeURIComponent(weekStart), signal);
export const getClassroomMeals = (weekStart: string, signal?: AbortSignal) => read<ClassroomMeals>('/meals?weekStart=' + encodeURIComponent(weekStart), signal);
