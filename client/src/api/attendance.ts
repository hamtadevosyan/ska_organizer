import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { ChildRecord } from './children';
export const attendanceUrl = API_BASE_URL + '/api/attendance';
export type AttendanceRecord = { id: string; childId: string; roomId: string | null; checkIn: string | null;
  checkOut: string | null; recordedBy: string | null; version: number; voided: boolean; needsReview: boolean };
export type AttendanceCorrection = { id: string; attendanceId: string; before: AttendanceRecord; after: AttendanceRecord;
  reason: string; actorId: string; actorUsername: string; occurredAt: string };
export type AttendanceRoom = { id: string; name: string; active: boolean };
export type AttendanceRow = { childId: string; child: Pick<ChildRecord, 'id' | 'firstName' | 'lastName' | 'preferredName' | 'roomId' | 'active'> | null;
  records: AttendanceRecord[]; openVisits: AttendanceRecord[]; canCheckIn: boolean; checkInRoomId: string | null };
export type DailyAttendance = { date: string; today: string; serverNow: string; timeZone: string; room: AttendanceRoom | null;
  rooms: AttendanceRoom[]; rows: AttendanceRow[]; presentCount: number | null; attendedCount: number };
export type TodayHeadcount = { date: string; timeZone: string; takenAt: string; childrenCount: number };
export const getDailyAttendance = async (date?: string, roomId?: string, signal?: AbortSignal) =>
  (await axios.get<DailyAttendance>(attendanceUrl + '/daily', { params: { date, roomId }, signal })).data;
export const getTodayHeadcount = async (signal?: AbortSignal) =>
  (await axios.get<TodayHeadcount>(attendanceUrl + '/today-headcount', { signal })).data;
export function attendanceTime(value: string | null, zone: string) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Not recorded';
  return new Date(value).toLocaleString(undefined, { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
}
export function localTimeInput(value: string | null, zone: string) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
export const newAttendanceRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');
