import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { Room } from './rooms';

export type ChildRecord = {
  id: string; firstName: string; lastName: string; preferredName: string | null;
  dateOfBirth: string | null; active: boolean; roomId: string | null; notes: string | null;
  createdAt?: string; updatedAt?: string;
};
export type ChildSettings = Pick<ChildRecord, 'firstName' | 'lastName' | 'preferredName' | 'dateOfBirth' | 'active' | 'roomId' | 'notes'>;
export type ChildMatch = Pick<ChildRecord, 'id' | 'firstName' | 'lastName' | 'dateOfBirth' | 'active' | 'roomId'>;
export type ChildProfile = {
  child: ChildRecord; room: Pick<Room, 'id' | 'name' | 'active'> | null;
  recentAttendance: { id: string; roomId: string | null; checkIn: string; checkOut: string | null }[];
};
export type RosterFilters = { q: string; roomId?: string; active: 'true' | 'false' | 'all'; page: number; pageSize: number };
const url = API_BASE_URL + '/api/children';
export const childName = (child: Pick<ChildRecord, 'firstName' | 'lastName'>) => [child.firstName, child.lastName].filter(Boolean).join(' ') || 'Unnamed child';
export async function listChildren(filters: RosterFilters, signal: AbortSignal) {
  return (await axios.get<{ items: ChildRecord[]; total: number }>(url, { params: filters, signal })).data;
}
export async function saveChild(id: string | null, values: ChildSettings & { confirmDuplicate: boolean; confirmOverCapacity: boolean }) {
  return (id ? await axios.put<ChildRecord>(url + '/' + encodeURIComponent(id), values) : await axios.post<ChildRecord>(url, values)).data;
}
export async function endEnrollment(id: string) {
  return (await axios.put<ChildRecord>(url + '/' + encodeURIComponent(id) + '/enrollment', { active: false })).data;
}
export async function getChildProfile(id: string, signal: AbortSignal) {
  return (await axios.get<ChildProfile>(url + '/' + encodeURIComponent(id) + '/profile', { signal })).data;
}
