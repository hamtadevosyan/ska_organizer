import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { KeyRound, Tablet } from 'lucide-react';
import { API_BASE_URL } from '../../lib/api';
import { useAuth } from '../../auth/context';
import { authError } from '../../auth/transport';
import { useUnsavedChanges } from '../UnsavedChangesContext';
import '../../pages/payroll.css';
import './staff-clock.css';

type Station = { id: string; name: string; createdAt: string; lastUsedAt: string | null; expiresAt: string; revokedAt: string | null };
type Person = { id: string; name: string; active: boolean; pinConfigured: boolean };
type SetupData = { stations: Station[]; staff: Person[] };
type Pairing = { code: string; expiresAt: string };
const url = API_BASE_URL + '/api/clock-stations';
const when = (value: string) => new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export default function ClockStationSetup() {
  const { account, serverUnavailable } = useAuth();
  if (!account || account.disabled || account.mustChangePassword || account.role !== 'admin') return <p role="alert">Administrator access is required to manage clock stations and staff PINs.</p>;
  if (serverUnavailable) return <p role="alert">The connection is interrupted. Reconnect before setting up a clock station.</p>;
  return <StationSetup key={account.id} />;
}

function StationSetup() {
  const [data, setData] = useState<SetupData | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [name, setName] = useState(''), [pins, setPins] = useState<Record<string, string>>({}), [pairing, setPairing] = useState<Pairing | null>(null);
  const mounted = useRef(true), saving = useRef(false), request = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null);
  const report = useUnsavedChanges(); const dirty = !!name || Object.values(pins).some(Boolean);
  useEffect(() => { report(dirty, busy); return () => report(false, false); }, [dirty, busy, report]);
  useEffect(() => { if (!dirty && !busy) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, busy]);
  const refresh = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await axios.get<{ data: SetupData }>(url, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return false;
      setData(response.data.data); return true;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && !axios.isCancel(failure)) { setData(null); setError(authError(failure, 'Could not load clock station setup.')); }
      return false;
    } finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; request.current?.abort(); mutation.current?.abort(); }; }, [refresh]);
  async function save(path: string, body: unknown, done: (result: unknown) => void, success: string, pinId?: string) {
    if (saving.current || loading) return;
    saving.current = true; setBusy(true); setError(''); setMessage('');
    const controller = new AbortController(); mutation.current = controller;
    try {
      const response = await axios.post<{ data: unknown }>(url + path, body, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      done(response.data.data);
      const refreshed = await refresh();
      if (!mounted.current || controller.signal.aborted) return;
      if (refreshed) setMessage(success);
      else setError('The change was saved, but the latest setup could not be loaded. Refresh before making another change.');
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not save this clock station change. Try again.'));
    } finally {
      saving.current = false;
      if (mounted.current) { setBusy(false); if (pinId) setPins(previous => ({ ...previous, [pinId]: '' })); }
    }
  }
  function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!event.currentTarget.reportValidity()) return;
    if (!name.trim()) { setError('Enter a clock station name.'); return; }
    setPairing(null);
    void save('/pairing', { name: name.trim() }, result => { setPairing(result as Pairing); setName(''); }, 'Pairing code created. Enter it on the academy tablet.');
  }
  function setPin(event: FormEvent<HTMLFormElement>, person: Person) {
    event.preventDefault(); if (!event.currentTarget.reportValidity() || !/^\d{6}$/.test(pins[person.id] || '')) return;
    void save('/staff/' + encodeURIComponent(person.id) + '/pin', { pin: pins[person.id] }, () => {}, 'PIN saved for ' + person.name + '.', person.id);
  }
  return <div className="payroll-page ska-core-page staff-clock-page"><header><h1>Clock station setup</h1><p>Give each employee a PIN and connect the academy tablet. Staff do not need a sign-in account to use the clock station.</p></header>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="payroll-actions"><button disabled={busy || loading} onClick={() => { setError(''); setMessage(''); void refresh(); }}>Refresh clock station setup</button></div>
    {loading && <p role="status">Loading clock station setup…</p>}
    {data && <>
      <section><h2><Tablet size={22} aria-hidden="true" />Connect a tablet</h2><p>Open <Link to="/time-clock" target="_blank" rel="noopener noreferrer">the staff clock station</Link> on the academy tablet, then enter the pairing code below. A connected tablet stays authorized for up to 90 days.</p>
        <form onSubmit={pair}><fieldset disabled={busy || loading}><label>Clock station name<input value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="For example: Front desk tablet" required /></label><button className="payroll-primary">Create pairing code</button></fieldset></form>
        {pairing && <aside className="clock-pairing-code" aria-label="New pairing code"><h3>Enter this code on the tablet</h3><output aria-label="Pairing code">{pairing.code}</output><p>Expires {when(pairing.expiresAt)}. Keep this page open until the tablet is connected.</p><button onClick={() => setPairing(null)}>Hide pairing code</button></aside>}
      </section>
      <section><h2><KeyRound size={22} aria-hidden="true" />Staff PINs</h2><p>Set a separate 6-digit PIN for each employee. A reset replaces the previous PIN.</p>
        {!data.staff.some(person => person.active) ? <p>No active staff to set up. Add an employee in Staff information.</p> : <div className="staff-clock-list">{data.staff.filter(person => person.active).map(person => <article className="staff-clock-person" key={person.id} aria-label={person.name + ' clock PIN'}><h3>{person.name}</h3><p>{person.pinConfigured ? 'PIN is set' : 'PIN not set'}</p>
          <form onSubmit={event => setPin(event, person)}><fieldset disabled={busy || loading}><label>New 6-digit PIN for {person.name}<input type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="off" value={pins[person.id] || ''} onChange={event => setPins(previous => ({ ...previous, [person.id]: event.target.value }))} required /></label><button>{person.pinConfigured ? 'Reset PIN for ' : 'Set PIN for '}{person.name}</button></fieldset></form>
          {person.pinConfigured && <button disabled={busy || loading} onClick={() => void save('/staff/' + encodeURIComponent(person.id) + '/pin', { pin: null }, () => {}, 'PIN disabled for ' + person.name + '.', person.id)}>Disable PIN for {person.name}</button>}
        </article>)}</div>}
      </section>
      <section><h2>Connected tablets</h2>{!data.stations.length ? <p>No clock stations connected yet.</p> : <div className="staff-clock-list">{data.stations.map(station => {
        const expired = Date.parse(station.expiresAt) <= Date.now();
        return <article key={station.id} className="staff-clock-person" aria-label={station.name + ' clock station'}><h3>{station.name}</h3><p>{station.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Connected'}</p><dl><div><dt>Access expires</dt><dd>{when(station.expiresAt)}</dd></div><div><dt>Last used</dt><dd>{station.lastUsedAt ? when(station.lastUsedAt) : 'Not used yet'}</dd></div></dl>
          {!station.revokedAt && <button disabled={busy || loading} onClick={() => void save('/' + encodeURIComponent(station.id) + '/revoke', {}, () => {}, 'Clock station disconnected: ' + station.name + '.')}>Revoke {station.name}</button>}
        </article>;
      })}</div>}</section>
    </>}
  </div>;
}
