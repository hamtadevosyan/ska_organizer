import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { AuthContext } from './context';
import type { Account } from './context';
import { authError, isServerUnavailable, onServerUnavailable, onSessionExpired, replaceSession } from './transport';

type Session = { account: Account; csrfToken: string };
const url = `${API_BASE_URL}/api/auth`;
const announce = () => { try { localStorage.setItem('skao-account-changed', `${Date.now()}-${Math.random()}`); } catch { /* Optional cross-tab notification. */ } };
export default function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [serverUnavailable, setServerUnavailable] = useState(false);
  const unavailableRef = useRef(false);
  const hadSession = useRef(false);
  const csrfRef = useRef('');
  const connection = useCallback((unavailable: boolean) => {
    unavailableRef.current = unavailable;
    setServerUnavailable(unavailable);
  }, []);
  const accept = useCallback((session: Session) => {
    replaceSession(session.csrfToken);
    csrfRef.current = session.csrfToken;
    hadSession.current = true;
    connection(false);
    setAccount(session.account); setNotice(''); setReady(true);
  }, [connection]);
  const check = useCallback(async (signal?: AbortSignal, initial = false) => {
    try {
      const { data } = await axios.get<Session>(`${url}/session`, { signal, timeout: 8000 });
      if (signal?.aborted) return;
      const recovered = unavailableRef.current && hadSession.current;
      connection(false);
      // Polling must not cancel in-flight operational requests or change the session epoch.
      if (initial || csrfRef.current !== data.csrfToken) accept(data);
      else {
        setAccount(data.account);
        if (recovered) setNotice('Connection restored. Check the latest records before retrying a failed save. Refreshing clears unsaved edits.');
      }
    } catch (error) {
      if (axios.isCancel(error) || signal?.aborted) return;
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        connection(false);
        setAccount(null);
        if (hadSession.current) setNotice('Your session has expired. Sign in again. Unsaved changes were cleared.');
      } else {
        if (isServerUnavailable(error)) connection(true);
        if (initial) setNotice(authError(error, 'Could not check your session.'));
      }
    } finally { if (!signal?.aborted) setReady(true); }
  }, [accept, connection]);
  useEffect(() => {
    const controller = new AbortController();
    const unsubscribe = onSessionExpired(() => {
      connection(false);
      setAccount(null);
      if (hadSession.current) setNotice('Your session has expired. Sign in again. Unsaved changes were cleared.');
    });
    const stopAvailability = onServerUnavailable(() => { connection(true); setNotice(''); });
    void check(controller.signal, true);
    const timer = window.setInterval(() => { if ((hadSession.current || unavailableRef.current) && document.visibilityState === 'visible') void check(); }, 30000);
    const focus = () => { if (hadSession.current || unavailableRef.current) void check(); };
    // Browser internet heuristics are only hints: an isolated LAN may still work.
    const networkHint = () => { void check(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== 'skao-account-changed') return;
      replaceSession(); setAccount(null); setReady(false);
      void check(undefined, true);
    };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    window.addEventListener('online', networkHint); window.addEventListener('offline', networkHint);
    return () => {
      controller.abort(); unsubscribe(); stopAvailability(); clearInterval(timer);
      window.removeEventListener('focus', focus); window.removeEventListener('storage', storage);
      window.removeEventListener('online', networkHint); window.removeEventListener('offline', networkHint);
    };
  }, [check, connection]);
  const signIn = async (username: string, password: string, rememberMe = false) => {
    const { data } = await axios.post<Session>(`${url}/login`, { username, password, rememberMe });
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
  return <AuthContext.Provider value={{ account, ready, notice, serverUnavailable, signIn, signOut, changePassword, retry: () => check() }}>{children}</AuthContext.Provider>;
}
