import { API_BASE_URL } from '../lib/api';
import type { Role } from '../auth/context';
export const staffAccountOptionsUrl = API_BASE_URL + '/api/admin/staff-options';
export type StaffAccountOption = { id: string; name: string; jobRole: string; active: boolean; roomId: string | null; roomName: string | null;
  account: { id: string; username: string; role: Role; disabled: boolean } | null };
