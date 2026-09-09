import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { AuthContext } from './context';
import type { Account } from './context';
import { authError, onSessionExpired, replaceSession } from './transport';

type Session = { account: Account; csrfToken: string };
const url = `${API_BASE_URL}/api/auth`;
const announce = () => { try { localStorage.setItem('skao-account-changed', `${Date.now()}-${Math.random()}`); } catch { /* Optional cross-tab notification. */ } };
export default function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const hadSession = useRef(false);
  const csrfRef = useRef('');
  const accept = useCallback((session: Session) => {
    replaceSession(session.csrfToken);
    csrfRef.current = session.csrfToken;
    hadSession.current = true;
    setAccount(session.account); setNotice(''); setReady(true);
  }, []);
  const check = useCallback(async (signal?: AbortSignal, initial = false) => {
    try {
      const { data } = await axios.get<Session>(`${url}/session`, { signal });
      if (signal?.aborted) return;
      // Polling must not cancel in-flight operational requests or change the session epoch.
      if (initial || csrfRef.current !== data.csrfToken) accept(data);
      else setAccount(data.account);
    } catch (error) {
      if (axios.isCancel(error) || signal?.aborted) return;
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        setAccount(null);
        if (hadSession.current) setNotice('Your session has expired. Sign in again. Unsaved changes were cleared.');
      } else if (initial) setNotice(authError(error, 'Could not check your session.'));
    } finally { if (!signal?.aborted) setReady(true); }
  }, [accept]);
  useEffect(() => {
    const controller = new AbortController();
    const unsubscribe = onSessionExpired(() => {
      setAccount(null);
      if (hadSession.current) setNotice('Your session has expired. Sign in again. Unsaved changes were cleared.');
    });
    void check(controller.signal, true);
    const timer = window.setInterval(() => { if (hadSession.current && document.visibilityState === 'visible') void check(); }, 30000);
    const focus = () => { if (hadSession.current) void check(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== 'skao-account-changed') return;
      replaceSession(); setAccount(null); setReady(false);
      void check(undefined, true);
    };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => { controller.abort(); unsubscribe(); clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); };
  }, [check]);
  const signIn = async (username: string, password: string) => {
    const { data } = await axios.post<Session>(`${url}/login`, { username, password });
    accept(data); announce();
  };
  const signOut = async () => {
    try { await axios.post(`${url}/logout`, {}); }
    catch (error) { if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error; }
    replaceSession(); hadSession.current = false; setAccount(null); setNotice('You have signed out.'); announce();
  };
  const changePassword = async (currentPassword: string, password: string) => {
    const { data } = await axios.post<Session>(`${url}/password`, { currentPassword, password });
    accept(data); announce();
  };
  return <AuthContext.Provider value={{ account, ready, notice, signIn, signOut, changePassword, retry: () => check(undefined, true) }}>{children}</AuthContext.Provider>;
}
