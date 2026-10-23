import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { ArrowLeft, Check, Delete, Fingerprint, LockKeyhole } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';
import './time-clock-station.css';

type Session = { station: { name: string; expiresAt: string }; csrfToken: string };
type Identity = { staff: { id: string; name: string }; checkedIn: boolean; version: number; clockToken: string };
type Screen = 'checking' | 'pair' | 'pin' | 'confirm' | 'success' | 'connection';
// This client deliberately has no personal-account transport or CSRF interceptors.
const http = axios.create({ baseURL: `${API_BASE_URL}/api/station-clock`, withCredentials: true, timeout: 10_000 });
const errorCode = (error: unknown) => axios.isAxiosError(error) ? error.response?.data?.error?.code : undefined;

export default function TimeClockStation() {
  const [screen, setScreen] = useState<Screen>('checking');
  const [session, setSession] = useState<Session | null>(null);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [success, setSuccess] = useState<{ name: string; action: 'checkin' | 'checkout' } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ id: number; controller: AbortController } | null>(null);
  const serial = useRef(0);
  const busyRef = useRef(false);
  const lastActivity = useRef(Date.now());
  const sessionRef = useRef<Session | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const acceptSession = useCallback((value: Session | null) => { sessionRef.current = value; setSession(value); }, []);
  const clearSensitive = useCallback(() => { setPin(''); setCode(''); setIdentity(null); setSuccess(null); }, []);
  const cancelRequest = useCallback(() => {
    serial.current += 1; pending.current?.controller.abort(); pending.current = null; busyRef.current = false; setBusy(false);
  }, []);
  const reset = useCallback(() => {
    cancelRequest(); clearSensitive(); setNotice(''); setScreen(sessionRef.current ? 'pin' : 'pair'); lastActivity.current = Date.now();
  }, [cancelRequest, clearSensitive]);
  const begin = useCallback(() => {
    if (busyRef.current) return null;
    const operation = { id: ++serial.current, controller: new AbortController() };
    pending.current = operation; busyRef.current = true; setBusy(true); setNotice(''); return operation;
  }, []);
  const current = useCallback((operation: { id: number; controller: AbortController }) => operation.id === serial.current && !operation.controller.signal.aborted, []);
  const finish = useCallback((operation: { id: number; controller: AbortController }) => {
    if (current(operation)) { pending.current = null; busyRef.current = false; setBusy(false); }
  }, [current]);
  const failed = useCallback((error: unknown) => {
    clearSensitive();
    const reason = errorCode(error);
    if (reason === 'STATION_EXPIRED') {
      acceptSession(null); setScreen('pair'); setNotice('This clock station needs to be paired again. Ask your administrator.');
    } else if (reason === 'STATION_PIN_INVALID') {
      setScreen('pin'); setNotice('PIN not recognized. Try again.');
    } else if (reason === 'CLOCK_GRANT_STALE') {
      setScreen('pin'); setNotice('Please enter your PIN again to check your current status.');
    } else if (reason === 'STATION_RATE_LIMITED') {
      setScreen(sessionRef.current ? 'pin' : 'pair'); setNotice('Too many attempts. Please wait a moment before trying again.');
    } else if (reason === 'STATION_CSRF_INVALID') {
      setScreen('connection'); setNotice('Refresh this clock station, then enter your PIN again.');
    } else if (axios.isAxiosError(error) && error.response && screen === 'pair') {
      setScreen('pair'); setNotice('That pairing code could not be used. Ask your administrator for a new code.');
    } else {
      setScreen('connection'); setNotice('Reconnect, then enter your PIN again to check your status.');
    }
  }, [acceptSession, clearSensitive, screen]);
  const loadSession = useCallback(async (quiet = false) => {
    const operation = begin(); if (!operation) return;
    if (!quiet) { clearSensitive(); setScreen('checking'); }
    try {
      const response = await http.get<{ data: Session }>('/session', { signal: operation.controller.signal });
      if (!current(operation)) return;
      acceptSession(response.data.data); if (!quiet) setScreen('pin');
    } catch (error) {
      if (!current(operation)) return;
      clearSensitive();
      if (axios.isAxiosError(error) && error.response?.status === 401) { acceptSession(null); setScreen('pair'); }
      else { setScreen('connection'); setNotice('Reconnect, then enter your PIN again to check your status.'); }
    } finally { finish(operation); }
  }, [acceptSession, begin, clearSensitive, current, finish]);

  useEffect(() => {
    void loadSession();
    const visibility = () => {
      reset();
      if (document.visibilityState === 'visible') void loadSession();
    };
    const focus = () => { if (!busyRef.current && document.visibilityState === 'visible') void loadSession(true); };
    const idle = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= 30_000) reset();
    }, 1000);
    const refresh = window.setInterval(() => { if (!busyRef.current && document.visibilityState === 'visible') void loadSession(true); }, 30_000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus);
    return () => {
      serial.current += 1; pending.current?.controller.abort(); pending.current = null; busyRef.current = false;
      clearInterval(idle); clearInterval(refresh); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus);
    };
  }, [loadSession, reset]);
  useEffect(() => { heading.current?.focus(); }, [screen]);
  useEffect(() => {
    if (screen !== 'success') return;
    const timer = window.setTimeout(reset, 4000); return () => clearTimeout(timer);
  }, [screen, reset]);

  async function pair(event: FormEvent) {
    event.preventDefault(); const entered = code.trim(); if (!entered) return;
    const operation = begin(); if (!operation) return; clearSensitive();
    try {
      const response = await http.post<{ data: Session }>('/pair', { code: entered }, { signal: operation.controller.signal });
      if (!current(operation)) return;
      acceptSession(response.data.data); setScreen('pin');
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          const peers = new BroadcastChannel('skao-account-changed');
          try { peers.postMessage('station-paired'); } finally { peers.close(); }
        }
      } catch { /* Optional peer notification cannot undo a completed pairing. */ }
    } catch (error) { if (current(operation)) failed(error); }
    finally { finish(operation); }
  }
  async function identify(event: FormEvent) {
    event.preventDefault(); if (!session || pin.length !== 6) return;
    const entered = pin; const operation = begin(); if (!operation) return; clearSensitive();
    try {
      const response = await http.post<{ data: Identity }>('/identify', { pin: entered }, { signal: operation.controller.signal, headers: { 'X-CSRF-Token': session.csrfToken } });
      if (!current(operation)) return;
      setIdentity(response.data.data); setScreen('confirm'); lastActivity.current = Date.now();
    } catch (error) { if (current(operation)) failed(error); }
    finally { finish(operation); }
  }
  async function clock() {
    if (!session || !identity) return;
    const chosen = identity; const action = chosen.checkedIn ? 'checkout' : 'checkin';
    const operation = begin(); if (!operation) return; clearSensitive();
    try {
      await http.post('/clock', { clockToken: chosen.clockToken, action, requestId: crypto.randomUUID(), version: chosen.version }, { signal: operation.controller.signal, headers: { 'X-CSRF-Token': session.csrfToken } });
      if (!current(operation)) return;
      setSuccess({ name: chosen.staff.name, action }); setScreen('success');
    } catch (error) { if (current(operation)) failed(error); }
    finally { finish(operation); }
  }
  const touch = () => { lastActivity.current = Date.now(); };
  return <main className="clock-station" onPointerDown={touch} onKeyDown={touch}>
    <header className="clock-station-brand"><img src="/assets/icons/academy-192.png" alt="" /><span>Smart Kids<br />Academy</span><span className="clock-station-badge"><LockKeyhole size={16} /> Staff clock</span></header>
    <section className={'clock-station-card is-' + screen} aria-busy={busy}>
      <h1>Staff check-in</h1>
      {session && <p className="clock-station-name">{session.station.name}</p>}
      {screen === 'checking' && <h2 ref={heading} tabIndex={-1} role="status">Connecting to your clock station…</h2>}
      {screen === 'pair' && <form onSubmit={pair}>
        <div className="clock-station-symbol"><LockKeyhole /></div><h2 ref={heading} tabIndex={-1}>Pair this clock station</h2>
        <p>Ask your administrator for a pairing code.</p>
        <label htmlFor="station-pairing-code">Pairing code</label><input id="station-pairing-code" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} value={code} disabled={busy} onChange={event => setCode(event.target.value)} />
        <button className="clock-station-primary" disabled={busy || !code.trim()}>{busy ? 'Pairing…' : 'Pair this device'}</button>
      </form>}
      {screen === 'pin' && <form onSubmit={identify}>
        <div className="clock-station-symbol"><Fingerprint /></div><h2 ref={heading} tabIndex={-1}>Enter your PIN</h2><p>Six digits, and you’re ready for the day.</p>
        <label className="sr-only" htmlFor="station-staff-pin">6-digit staff PIN</label><input id="station-staff-pin" className="clock-station-pin" type="password" inputMode="numeric" pattern="[0-9]{6}" autoComplete="off" aria-label="6-digit staff PIN" maxLength={6} value={pin} disabled={busy} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} />
        <div className="clock-station-keypad" aria-label="PIN keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', 'Backspace'].map(key => <button key={key} type="button" disabled={busy} aria-label={key === 'Backspace' ? 'Delete last PIN digit' : key} onClick={() => setPin(value => key === 'Clear' ? '' : key === 'Backspace' ? value.slice(0, -1) : (value + key).slice(0, 6))}>{key === 'Backspace' ? <Delete aria-hidden="true" /> : key}</button>)}</div>
        <button className="clock-station-primary" disabled={busy || pin.length !== 6}>{busy ? 'Checking…' : 'Continue'}</button>
      </form>}
      {screen === 'confirm' && identity && <div>
        <div className="clock-station-symbol"><Fingerprint /></div><p className="clock-station-eyebrow">Hello,</p><h2 ref={heading} tabIndex={-1}>{identity.staff.name}</h2>
        <p>{identity.checkedIn ? 'Ready to finish your day?' : 'Ready to start your day?'}</p><button className="clock-station-primary" disabled={busy} onClick={() => { void clock(); }}>{identity.checkedIn ? 'Check out' : 'Check in'}</button>
        <button className="clock-station-cancel" disabled={busy} onClick={reset}><ArrowLeft size={19} /> Not you? Cancel</button>
      </div>}
      {screen === 'success' && success && <div role="status">
        <div className="clock-station-symbol is-success"><Check /></div><h2 ref={heading} tabIndex={-1}>{success.action === 'checkin' ? 'You’re checked in' : 'You’re checked out'}</h2><p>Thank you, {success.name}!</p><button className="clock-station-cancel" onClick={reset}>Done</button>
      </div>}
      {screen === 'connection' && <div><div className="clock-station-symbol"><LockKeyhole /></div><h2 ref={heading} tabIndex={-1}>Connection interrupted</h2><p>No need to leave this page.</p><button className="clock-station-primary" disabled={busy} onClick={() => { void loadSession(); }}>Try again</button></div>}
      {notice && <p role="alert" className="clock-station-notice">{notice}</p>}
      {busy && screen === 'confirm' && <p role="status">Saving…</p>}
    </section>
    <footer>One person at a time. Your PIN stays private.</footer>
  </main>;
}
