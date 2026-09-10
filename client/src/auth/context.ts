import { createContext, useContext } from 'react';
export type Role = 'admin' | 'editor' | 'viewer';
export type Account = { id: string; username: string; displayName: string; role: Role; disabled: boolean; mustChangePassword: boolean };
export type AuthState = {
  account: Account | null; ready: boolean; notice: string;
  signIn: (username: string, password: string) => Promise<void>;
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
export const roleLabels: Record<Role, string> = { admin: 'Administrator', editor: 'Editor', viewer: 'Read only' };
