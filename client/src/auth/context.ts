import { createContext, useContext } from 'react';
export type Role = 'admin' | 'editor' | 'viewer' | 'teacher';
export type DocumentAccess = 'none' | 'view' | 'edit';
export type WorkAccess = { required: boolean; checkedIn: boolean; available: boolean };
export type Account = { id: string; username: string; displayName: string; role: Role; disabled: boolean; mustChangePassword: boolean; documentAccess?: DocumentAccess; roomId?: string | null; staffMemberId?: string | null; linkedStaff?: { id: string; name: string; active: boolean; roomId: string | null } | null; workAccess?: WorkAccess };
export type AuthState = {
  account: Account | null; ready: boolean; notice: string; serverUnavailable: boolean; workVerifying?: boolean;
  signIn: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (currentPassword: string, password: string) => Promise<void>;
  retry: () => Promise<void>;
};
export const AuthContext = createContext<AuthState | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Authentication provider is missing.');
  return value;
}
export const roleLabels: Record<Role, string> = { admin: 'Administrator', editor: 'Editor', viewer: 'Class viewer', teacher: 'Teacher' };

export const isClassAccount = (role?: Role) => role === 'viewer' || role === 'teacher';
export const requiresWorkCheck = (account: Account | null) => !!account && account.role !== 'admin' && (account.workAccess?.required === true || !!account.staffMemberId || !!account.linkedStaff);
export const verifiedWorkAccess = (account: Account | null) => !requiresWorkCheck(account) || account?.workAccess?.required === true && account.workAccess.available === true && account.workAccess.checkedIn === true;
