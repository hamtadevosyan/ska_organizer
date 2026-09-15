import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

export type StaffMember = {
  id: string; name: string; role: string; active: boolean; roomId: string | null;
  version: number; createdAt: string; updatedAt: string;
  room: { id: string; name: string; active: boolean } | null;
};
export type StaffDetails = Pick<StaffMember, 'name' | 'role' | 'active' | 'roomId'>;
export type StaffFilters = { q: string; active: 'true' | 'false' | 'all'; roomId: string; page: number };
export type StaffDirectory = { items: StaffMember[]; total: number; activeTotal: number; page: number; pageSize: number };
export const staffUrl = API_BASE_URL + '/api/staff';
export async function listStaff(filters: StaffFilters, signal: AbortSignal) {
  const response = await axios.get<StaffDirectory>(staffUrl, {
    params: { ...filters, q: filters.q || undefined, roomId: filters.roomId || undefined, pageSize: 25 }, signal,
  });
  return response.data;
}
export async function getStaff(id: string) {
  return (await axios.get<{ data: StaffMember }>(staffUrl + '/' + encodeURIComponent(id))).data.data;
}
export async function saveStaff(previous: StaffMember | null, details: Partial<StaffDetails>) {
  const response = previous
    ? await axios.put<{ data: StaffMember }>(staffUrl + '/' + encodeURIComponent(previous.id), { ...details, version: previous.version })
    : await axios.post<{ data: StaffMember }>(staffUrl, details);
  return response.data.data;
}
