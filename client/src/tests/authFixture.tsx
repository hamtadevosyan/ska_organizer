import type { ReactNode } from 'react';
import { AuthContext } from '../auth/context';
import type { Account } from '../auth/context';
import { testAccount } from './authAccount';
export function SignedIn({ children, account = testAccount }: { children: ReactNode; account?: Account }) {
  return <AuthContext.Provider value={{ account, ready: true, notice: '', signIn: async () => {}, signOut: async () => {}, changePassword: async () => {}, retry: async () => {} }}>{children}</AuthContext.Provider>;
}
