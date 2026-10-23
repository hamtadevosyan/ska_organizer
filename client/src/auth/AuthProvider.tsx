import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { AuthContext, requiresWorkCheck, verifiedWorkAccess } from './context';
import type { Account } from './context';
import { authError, isServerUnavailable, onServerUnavailable, onSessionExpired, onWorkAccessRequired, replaceSession } from './transport';

type Session = { account: Account; csrfToken: string };
const accountScope = (account: Account) => JSON.stringify([account.id, account.role, account.roomId ?? null, account.staffMemberId ?? null, account.workAccess ?? null]);
const redactedWorkAccount = (account: Account, available: boolean): Account => ({ ...account, roomId: null, staffMemberId: null, linkedStaff: null, documentAccess: 'none', workAccess: { required: true, checkedIn: false, available } });
function safeAccount(account: Account, previous: Account | null) {
  const missingEarlierWorkAccess = account.role !== 'admin' && !account.workAccess && previous?.id === account.id && requiresWorkCheck(previous);
  return missingEarlierWorkAccess || requiresWorkCheck(account) && !verifiedWorkAccess(account) ? redactedWorkAccount(account, account.workAccess?.required === true && account.workAccess.available === true) : account;
}
const url = `${API_BASE_URL}/api/auth`;
const announce = () => { try { localStorage.setItem('skao-account-changed', `${Date.now()}-${Math.random()}`); } catch { /* Optional cross-tab notification. */ } };
export default function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [serverUnavailable, setServerUnavailable] = useState(false);
  const [workVerifying, setWorkVerifying] = useState(false); const workVerifyingRef = useRef(false);
  const verification = useCallback((pending: boolean) => { workVerifyingRef.current = pending; setWorkVerifying(pending); }, []);
  const accountRef = useRef<Account | null>(null), checking = useRef<AbortController | null>(null), checkTurn = useRef(0), authBusy = useRef(false), lastCheck = useRef(0);
  const unavailableRef = useRef(false);
  const hadSession = useRef(false);
  const csrfRef = useRef('');
  const scopeRef = useRef('');
  const connection = useCallback((unavailable: boolean) => { unavailableRef.current = unavailable; setServerUnavailable(unavailable); }, []);
  const invalidateCheck = useCallback(() => { checkTurn.current++; checking.current?.abort(); }, []);
  const hideEmployeeWork = useCallback((available = false, rotate = true) => {
    const current = accountRef.current;
    if (!current || !requiresWorkCheck(current)) return;
    invalidateCheck();
    if (rotate) replaceSession(csrfRef.current);
    const blocked = redactedWorkAccount(current, available);
    scopeRef.current = accountScope(blocked); accountRef.current = blocked;
    verification(false); setAccount(blocked); setNotice(''); setReady(true);
  }, [invalidateCheck, verification]);
  const pauseEmployeeWork = useCallback(() => {
    const current = accountRef.current;
    if (!current || !requiresWorkCheck(current) || !verifiedWorkAccess(current)) return;
    invalidateCheck();
    if (!workVerifyingRef.current) replaceSession(csrfRef.current);
    verification(true);
  }, [invalidateCheck, verification]);
  const accept = useCallback((session: Session) => {
    const next = safeAccount(session.account, accountRef.current);
    replaceSession(session.csrfToken); csrfRef.current = session.csrfToken;
    scopeRef.current = accountScope(next); accountRef.current = next;
    hadSession.current = true; connection(false);
    verification(requiresWorkCheck(next) && verifiedWorkAccess(next) && document.visibilityState === 'hidden');
    setAccount(next); setNotice(''); setReady(true);
  }, [connection, verification]);
  const check = useCallback(async (signal?: AbortSignal, initial = false) => {
    if (authBusy.current) return;
    checking.current?.abort(); const controller = new AbortController(); checking.current = controller;
    const turn = ++checkTurn.current; lastCheck.current = Date.now();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const { data } = await axios.get<Session>(`${url}/session`, { signal: requestSignal, timeout: 8000 });
      if (requestSignal.aborted || turn !== checkTurn.current) return;
      const next = safeAccount(data.account, accountRef.current);
      const recovered = unavailableRef.current && hadSession.current;
      connection(false);
      // A changed work-access decision invalidates drafts and requests just like a changed account or class.
      if (initial || csrfRef.current !== data.csrfToken || scopeRef.current !== accountScope(next)) accept({ ...data, account: next });
      else {
        accountRef.current = next; verification(requiresWorkCheck(next) && verifiedWorkAccess(next) && document.visibilityState === 'hidden'); setAccount(next);
        if (recovered) setNotice('Connection restored. Check the latest records before retrying a failed save. Refreshing clears unsaved edits.');
      }
    } catch (error) {
      if (axios.isCancel(error) || requestSignal.aborted || turn !== checkTurn.current) return;
      if (axios.isAxiosError(error) && error.response?.data?.error?.code === 'STATION_MODE') {
        replaceSession(); accountRef.current = null; verification(false); setAccount(null); window.location.replace('/time-clock'); return;
      }
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        replaceSession(); csrfRef.current = ''; scopeRef.current = ''; accountRef.current = null;
        connection(false); verification(false); setAccount(null);
        if (hadSession.current) setNotice('Your session has expired. Sign in again. Unsaved changes were cleared.');
      } else {
        if (isServerUnavailable(error)) connection(true);
        hideEmployeeWork(false);
        if (initial) setNotice(authError(error, 'Could not check your session.'));
      }
    } finally { if (turn === checkTurn.current) { checking.current = null; if (!requestSignal.aborted) setReady(true); } }
  }, [accept, connection, hideEmployeeWork, verification]);
  useEffect(() => {
    const controller = new AbortController();
    const unsubscribe = onSessionExpired(() => {
      invalidateCheck(); csrfRef.current = ''; scopeRef.current = ''; accountRef.current = null;
      connection(false); verification(false); setAccount(null); setReady(true);
      if (hadSession.current) setNotice('Your session has expired. Sign in again. Unsaved changes were cleared.');
    });
    const stopAvailability = onServerUnavailable(() => { connection(true); setNotice(''); hideEmployeeWork(false); });
    const stopWorkAccess = onWorkAccessRequired(() => { connection(false); hideEmployeeWork(true, false); });
    void check(controller.signal, true);
    const timer = window.setInterval(() => {
      if ((hadSession.current || unavailableRef.current) && document.visibilityState === 'visible' && (!checking.current || checking.current.signal.aborted) && (requiresWorkCheck(accountRef.current) || Date.now() - lastCheck.current >= 30000)) void check();
    }, 5000);
    const focus = () => { if (hadSession.current || unavailableRef.current) { pauseEmployeeWork(); void check(); } };
    const visibility = () => { if (document.visibilityState === 'hidden') pauseEmployeeWork(); else focus(); };
    // Browser internet heuristics are only hints: an isolated LAN may still work after live verification.
    const networkHint = () => { pauseEmployeeWork(); void check(); };
    const clearPeerSession = () => {
      invalidateCheck(); replaceSession(); accountRef.current = null; verification(false); setAccount(null); setReady(false);
      void check(undefined, true);
    };
    const storage = (event: StorageEvent) => { if (event.key === 'skao-account-changed') clearPeerSession(); };
    let peers: BroadcastChannel | null = null;
    try { if (typeof BroadcastChannel !== 'undefined') { peers = new BroadcastChannel('skao-account-changed'); peers.onmessage = clearPeerSession; } }
    catch { /* Focus and periodic checks still verify the server session. */ }
    window.addEventListener('focus', focus); window.addEventListener('storage', storage); document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', networkHint); window.addEventListener('offline', networkHint);
    return () => {
      controller.abort(); invalidateCheck(); unsubscribe(); stopAvailability(); stopWorkAccess(); clearInterval(timer);
      try { peers?.close(); } catch { /* Optional peer notification. */ }
      window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', networkHint); window.removeEventListener('offline', networkHint);
    };
  }, [check, connection, hideEmployeeWork, invalidateCheck, pauseEmployeeWork, verification]);
  const signIn = async (username: string, password: string, rememberMe = false) => {
    invalidateCheck(); authBusy.current = true;
    try { const { data } = await axios.post<Session>(`${url}/login`, { username, password, rememberMe }); accept(data); announce(); }
    finally { authBusy.current = false; }
  };
  const signOut = async () => {
    invalidateCheck(); authBusy.current = true;
    try {
      try { await axios.post(`${url}/logout`, {}); }
      catch (error) { if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error; }
      replaceSession(); csrfRef.current = ''; scopeRef.current = ''; hadSession.current = false; accountRef.current = null;
      connection(false); verification(false); setAccount(null); setNotice('You have signed out.'); announce();
    } finally { authBusy.current = false; }
  };
  const changePassword = async (currentPassword: string, password: string) => {
    invalidateCheck(); authBusy.current = true;
    try { const { data } = await axios.post<Session>(`${url}/password`, { currentPassword, password }); accept(data); announce(); }
    finally { authBusy.current = false; }
  };
  return <AuthContext.Provider value={{ account, ready, notice, serverUnavailable, workVerifying, signIn, signOut, changePassword, retry: () => check() }}>{children}</AuthContext.Provider>;
}
