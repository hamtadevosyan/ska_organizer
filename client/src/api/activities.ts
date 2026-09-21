import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { Room } from './rooms';
import type { InventoryItem, InventoryList } from './inventory';

export type Material = { itemId: string; name?: string; location?: string; quantity: string; unit: string; reusable: boolean };
export type Activity = { id: string; name: string; description: string; durationMinutes: number | null;
  ageMinMonths: number | null; ageMaxMonths: number | null; roomId: string | null; materials: Material[]; version: number };
export type ActivityDetails = Omit<Activity, 'id' | 'version'>;
export type Entry = { id: string; date: string; startTime: string | null; endTime: string | null;
  timeBlock: string | null; activityId: string; activity: Activity | null; useLatest?: boolean };
export type MaterialCheck = { itemId: string; name: string; location: string; unit: string; needed: string; available: string; shortage: string; issue: string | null };
export type ActivityPlan = { roomId: string; weekStart: string; version: number; savedAt: string | null; entries: Entry[]; materials: MaterialCheck[] };
export const activitiesUrl = API_BASE_URL + '/api/activity';
export const activityPlanUrl = API_BASE_URL + '/api/schedule/plan';
export const legacyLabel = (block: string | null) => ({ morning: 'Morning', midday: 'Midday', afternoon: 'Afternoon' } as Record<string, string>)[block || ''] || 'Earlier schedule';
export const entryPayload = (entries: Entry[]) => entries.map(({ id, date, startTime, endTime, timeBlock, activityId, useLatest, activity }) =>
  ({ id, date, startTime, endTime, timeBlock, activityId, useLatest: useLatest === true, ...(useLatest && activity ? { activityVersion: activity.version } : {}) }));
export const timeMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const clockTime = (minutes: number) => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
export const orderedEntries = (entries: Entry[]) => [...entries].sort((a, b) => a.date.localeCompare(b.date) ||
  (a.startTime || '25:' + ({ morning: '01', midday: '02', afternoon: '03' } as Record<string, string>)[a.timeBlock || '']).localeCompare(
    b.startTime || '25:' + ({ morning: '01', midday: '02', afternoon: '03' } as Record<string, string>)[b.timeBlock || '']) || a.id.localeCompare(b.id));
export function entryProblem(entry: Entry) {
  if (!entry.activity) return 'Choose an activity.';
  if (entry.timeBlock && entry.startTime === null && entry.endTime === null) return '';
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!entry.startTime || !clock.test(entry.startTime) || !entry.endTime || (!clock.test(entry.endTime) && entry.endTime !== '24:00')) return 'Enter a start and end time.';
  return entry.endTime <= entry.startTime ? 'End time must be after start time.' : '';
}
export const timeRange = (entry: Entry) => entry.startTime && entry.endTime ? entry.startTime + '–' + (entry.endTime === '24:00' ? 'midnight' : entry.endTime) : 'Time not set · ' + legacyLabel(entry.timeBlock);
export const suitable = (activity: Pick<Activity, 'roomId' | 'ageMinMonths' | 'ageMaxMonths'>, room: Room) => (!activity.roomId || activity.roomId === room.id) &&
  (activity.ageMinMonths == null || (room.ageMinMonths !== null && room.ageMaxMonths !== null && room.ageMinMonths >= activity.ageMinMonths && room.ageMaxMonths <= activity.ageMaxMonths!));
export function weekDates(start: string) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}
export const dayLabel = (date: string) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
export const materialUnitLabel = (unit: string) => ({ count: 'items', box: 'boxes', pack: 'packs' } as Record<string, string>)[unit] || unit;
export async function saveActivity(previous: Activity | null, details: ActivityDetails) {
  const values = { ...details, materials: details.materials.map(({ itemId, quantity, unit, reusable }) => ({ itemId, quantity, unit, reusable })) };
  const response = previous ? await axios.put<{ data: Activity }>(activitiesUrl + '/' + encodeURIComponent(previous.id), { ...values, version: previous.version })
    : await axios.post<{ data: Activity }>(activitiesUrl, values);
  return response.data.data;
}
export async function materialOptions(signal: AbortSignal) {
  const items: InventoryItem[] = [];
  for (let page = 1; !signal.aborted; page++) {
    const result = (await axios.get<InventoryList>(API_BASE_URL + '/api/inventory', { params: { page, pageSize: 100 }, signal })).data;
    items.push(...result.items);
    if (!result.items.length || items.length >= result.total) break;
  }
  return items;
}
