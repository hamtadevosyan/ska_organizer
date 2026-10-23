import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { LogIn, LogOut, RefreshCw } from 'lucide-react';
import { API_BASE_URL } from '../../lib/api';
import { useAuth } from '../../auth/context';
import { authError } from '../../auth/transport';
import { useUnsavedChanges } from '../UnsavedChangesContext';
import '../../pages/payroll.css';
import './staff-clock.css';

type Employee = { id: string; name: string; active: boolean; checkedIn: boolean; version: number };
type ClockData = { staff: Employee[]; timeZone: string };
const url = API_BASE_URL + '/api/work-time/clock';

export default function StaffClock() {
  const { account, serverUnavailable } = useAuth();
  if (!account || account.disabled || account.mustChangePassword || !['admin', 'editor'].includes(account.role)) return <p role="alert">Administrator or editor access is required to record staff check-in and checkout.</p>;
  if (serverUnavailable) return <p role="alert">The connection is interrupted. Reconnect before recording staff check-in or checkout.</p>;
  return <ManagerClock key={account.id + ':' + account.role} />;
}

function ManagerClock() {
  const [data, setData] = useState<ClockData | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true), [busyId, setBusyId] = useState(''), [search, setSearch] = useState('');
  const mounted = useRef(true), saving = useRef(false), request = useRef<AbortController | null>(null), clockRequest = useRef<AbortController | null>(null);
  const retries = useRef(new Map<string, string>());
  const report = useUnsavedChanges();
  useEffect(() => { report(false, !!busyId); return () => report(false, false); }, [busyId, report]);
  useEffect(() => { if (!busyId) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [busyId]);
  const refresh = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const response = await axios.get<{ data: ClockData }>(url, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return false;
      setData(response.data.data); return true;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && !axios.isCancel(failure)) { setData(null); setError(authError(failure, 'Could not load staff clock status. Refresh to try again.')); }
      return false;
    } finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const onFocus = () => { if (!saving.current && document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(onFocus, 30000); window.addEventListener('focus', onFocus);
    return () => { mounted.current = false; request.current?.abort(); clockRequest.current?.abort(); window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  async function clock(person: Employee) {
    if (saving.current || loading) return;
    saving.current = true; setBusyId(person.id); setError(''); setMessage(''); request.current?.abort();
    const action = person.checkedIn ? 'checkout' : 'checkin', key = person.id + ':' + person.version + ':' + action;
    if (!retries.current.has(key)) retries.current.set(key, globalThis.crypto.randomUUID());
    const controller = new AbortController(); clockRequest.current = controller;
    try {
      await axios.post(API_BASE_URL + '/api/work-time/staff/' + encodeURIComponent(person.id) + '/clock', { action, requestId: retries.current.get(key), version: person.version }, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      retries.current.delete(key);
      const refreshed = await refresh();
      if (!mounted.current || controller.signal.aborted) return;
      if (refreshed) setMessage(person.name + (action === 'checkin' ? ' checked in.' : ' checked out.'));
      else setError('The clock action was saved, but the latest status could not be loaded. Refresh before recording another action.');
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || axios.isCancel(failure)) return;
      const stale = axios.isAxiosError(failure) && failure.response?.status === 409;
      if (stale) retries.current.delete(key);
      await refresh();
      if (mounted.current) setError(stale ? 'Staff status changed. Review the refreshed status before choosing an action. No action was repeated.' : authError(failure, 'Could not confirm this clock action. Review the refreshed status before trying again.'));
    } finally { saving.current = false; if (mounted.current) setBusyId(''); }
  }
  const staff = (data?.staff || []).filter(person => person.active);
  const filtered = staff.filter(person => person.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="payroll-page ska-core-page staff-clock-page"><header><h1>Clock in/out</h1><p>Record staff arrivals and departures. Each button records the current time.</p></header>
    <div className="payroll-actions"><button disabled={loading || !!busyId} onClick={() => { setMessage(''); void refresh(); }}><RefreshCw size={17} aria-hidden="true" />Refresh staff clock</button></div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {loading && <p role="status">Refreshing staff clock…</p>}
    {data && <><label className="staff-clock-search">Find staff<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><p className="ska-muted">{data.timeZone}</p>
      {!staff.length ? <section><h2>No active staff</h2><p>Add an employee in Staff information to record their arrival or departure.</p></section> : !filtered.length ? <p>No staff match this search.</p> : <div className="staff-clock-list">{filtered.map(person => <article key={person.id} className="staff-clock-person" aria-label={person.name + ' work clock'}><div><h2>{person.name}</h2><span className={'payroll-status ' + (person.checkedIn ? 'is-ready' : '')}>{person.checkedIn ? 'Checked in' : 'Checked out'}</span></div>
        <button className="payroll-primary" disabled={loading || !!busyId} aria-busy={busyId === person.id} onClick={() => void clock(person)}>{person.checkedIn ? <LogOut size={19} aria-hidden="true" /> : <LogIn size={19} aria-hidden="true" />}{person.checkedIn ? 'Check out ' : 'Check in '}{person.name}</button>
      </article>)}</div>}
    </>}
  </div>;
}
