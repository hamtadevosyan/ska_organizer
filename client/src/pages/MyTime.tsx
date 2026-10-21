import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { hours, localTime, payrollRequestId } from '../components/payroll/types';
import type { ClockSession } from '../components/payroll/types';
import './payroll.css';
type Own = { staff: { id: string; name: string }; version: number; timeZone: string; sessions: ClockSession[]; days: { date: string; rawMillis: number; paidMillis: number; incomplete: boolean }[] };
const url = API_BASE_URL + '/api/time-clock';
export default function MyTime() {
  const { account, serverUnavailable } = useAuth();
  const scope = JSON.stringify([account?.id, account?.staffMemberId]);
  const [loaded, setLoaded] = useState<{ scope: string; data: Own } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0);
  const currentScope = useRef(scope); currentScope.current = scope; const mounted = useRef(true); const replay = useRef(new Map<string, string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { replay.current.clear(); setLoaded(null); setError(''); }, [scope]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    if (!account?.staffMemberId || serverUnavailable) return () => controller.abort();
    void axios.get<{ data: Own }>(url, { signal: controller.signal }).then(response => { if (active) { setLoaded({ scope, data: response.data.data }); setError(''); } })
      .catch(failure => { if (active && !axios.isCancel(failure)) { setLoaded(null); setError(authError(failure, 'Could not load your time clock.')); } });
    return () => { active = false; controller.abort(); };
  }, [scope, revision, account?.staffMemberId, serverUnavailable]);
  useEffect(() => {
    const refresh = () => { if (!busy && document.visibilityState === 'visible') setRevision(n => n + 1); };
    const timer = window.setInterval(refresh, 30000); window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [busy]);
  const data = loaded?.scope === scope && !serverUnavailable ? loaded.data : null;
  const open = data?.sessions.find(s => !s.voided && !s.end); const rest = open?.breaks.find(b => !b.end);
  async function clock(action: string) {
    if (!data || busy) return; const identity = scope; setBusy(true); setError('');
    if (!replay.current.has(action)) replay.current.set(action, payrollRequestId());
    try {
      await axios.post(url, { action, version: data.version, requestId: replay.current.get(action) });
      if (mounted.current && currentScope.current === identity) { replay.current.delete(action); setLoaded(null); setRevision(n => n + 1); }
    } catch (failure) { if (mounted.current && currentScope.current === identity) setError(authError(failure, 'Could not confirm the clock action. Refresh or retry the same action.')); }
    finally { if (mounted.current && currentScope.current === identity) setBusy(false); }
  }
  return <div className="payroll-page ska-core-page"><header><h1>My time</h1><p>Your own work attendance. Times are recorded by the academy computer.</p></header>
    {!account?.staffMemberId ? <p role="alert">Ask an administrator to link your account to your active staff record in Accounts.</p> : serverUnavailable ? <p role="alert">The connection is interrupted. Clock actions are unavailable; report your actual times to an administrator.</p> : <>
      {error && <p role="alert">{error}</p>}<button disabled={busy} onClick={() => setRevision(n => n + 1)}>Refresh my time</button>
      {!data ? !error && <p role="status">Loading your clock…</p> : <><section><h2>{data.staff.name}</h2><p>{data.timeZone}</p><strong>{rest ? 'On break' : open ? 'Checked in' : 'Checked out'}</strong>
        {open && <p>Arrived: {localTime(open.start, data.timeZone)}</p>}
        <div className="payroll-actions">{!open ? <button disabled={busy} onClick={() => void clock('checkin')}>Check in to work</button> : rest ? <button disabled={busy} onClick={() => void clock('end-break')}>End my break</button> : <>
          <button disabled={busy} onClick={() => void clock('checkout')}>Check out of work</button><button disabled={busy} onClick={() => void clock('paid-break')}>Start paid rest break</button><button disabled={busy} onClick={() => void clock('unpaid-break')}>Start unpaid meal break</button></>}</div>
        <p>Only use an unpaid meal break when relieved of duty. Paid rest breaks remain part of paid time. Ask an administrator to correct a missed clock action.</p></section>
        <section><h2>Recent workdays</h2><ul>{[...data.days].reverse().map(day => <li key={day.date}><strong>{day.date}</strong> · {hours(day.rawMillis)} clocked hours · {hours(day.paidMillis)} hours after recorded unpaid breaks{day.incomplete && ' · Checkout or break needs attention'}</li>)}</ul></section></>}
    </>}
  </div>;
}
