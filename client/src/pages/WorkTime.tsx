import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { CalendarClock, ClipboardCheck } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthContext, useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { API_BASE_URL } from '../lib/api';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import ClockSessions from '../components/payroll/ClockSessions';
import type { RecordedSession } from '../components/payroll/types';
import './payroll.css';

type ScheduleEntry = { effectiveOn: string; minutes: number; reason: string; startTime?: string; endTime?: string; timeZone?: string };
type Employee = { id: string; name: string; active: boolean; scheduleVersion: number; defaultMinutes: number; entries: ScheduleEntry[] };
type WorkDay = { staffId: string; name: string; date: string; version: number; plannedMinutes: number; paidMillis: number; extraMillis: number;
  incomplete: boolean; status: string; reason: string; checkout: string | null; canCorrect: boolean; checkin?: string | null;
  sessions?: RecordedSession[]; timeZone?: string; plannedStart?: string | null; plannedEnd?: string | null; scheduleTimeZone?: string; earlyMillis?: number; lateMillis?: number; outsideMillis?: number; scheduleIssue?: string | null };
type ShortDayWarning = { staffId: string; name: string; weekStart: string; weekEnd: string; count: number; dates: string[] };
export type WorkData = { today: string; timeZone: string; staff: Employee[]; items: WorkDay[]; shortDayWarnings?: ShortDayWarning[]; overtimeReviewCount?: number };
const url = API_BASE_URL + '/api/work-time';
const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const clockLabel = (value: string) => {
  if (!validTime(value)) return value;
  const [hour, minute] = value.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};
const duration = (millis: number) => {
  if (millis > 0 && millis < 1000) return 'Less than 1 sec';
  const seconds = Math.max(0, Math.floor(millis / 1000));
  const parts = [Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)} hr` : '', Math.floor(seconds % 3600 / 60) ? `${Math.floor(seconds % 3600 / 60)} min` : '', seconds % 60 ? `${seconds % 60} sec` : ''].filter(Boolean);
  return parts.join(' ') || '0 min';
};
const approvedWindow = (row: WorkDay) => row.plannedStart && row.plannedEnd ? `${clockLabel(row.plannedStart)}–${clockLabel(row.plannedEnd)}` : `Earlier daily-hours schedule · ${duration(row.plannedMinutes * 60000)}`;
function statusLabel(row: WorkDay) {
  if (row.incomplete) return 'Checkout missing';
  if (row.status === 'pending') return 'Needs manager review';
  if (row.status === 'confirmed') return 'Outside time confirmed';
  if (row.status === 'corrected') return 'Clock time corrected';
  return row.plannedStart ? 'Within approved schedule' : 'Within earlier daily-hours limit';
}

export default function WorkTime() {
  const { account, serverUnavailable } = useAuth();
  const [search] = useSearchParams();
  const date = search.get('date') || '';
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date ? date : '';
  if (serverUnavailable) return <p role="alert">The connection is interrupted. Reconnect before reviewing work time.</p>;
  if (!account || account.disabled || account.mustChangePassword || !['admin', 'editor'].includes(account.role)) return <p role="alert">Manager work-time access is required.</p>;
  return <ManagerWorkTime key={account.id + ':' + account.role + ':' + search.toString()} admin={account.role === 'admin'} targetStaff={search.get('staff') || ''} targetDate={targetDate} />;
}

function ScheduleForm({ person, today, timeZone, disabled, onDirty, onSave }: {
  person: Employee; today: string; timeZone: string; disabled: boolean; onDirty: () => void;
  onSave: (body: unknown) => void;
}) {
  const current = person.entries.filter(entry => entry.effectiveOn <= today).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn)).at(-1);
  const [startTime, setStartTime] = useState(current?.startTime || '');
  const [endTime, setEndTime] = useState(current?.endTime || '');
  const [invalid, setInvalid] = useState(false);
  const valid = validTime(startTime) && validTime(endTime) && endTime > startTime;
  const minutes = valid ? Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3)) - Number(startTime.slice(0, 2)) * 60 - Number(startTime.slice(3)) : 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) { setInvalid(true); return; }
    const fields = new FormData(event.currentTarget);
    onSave({ version: person.scheduleVersion, startTime, endTime, effectiveOn: fields.get('effectiveOn'), reason: fields.get('reason') });
  }
  return <form className="work-time-schedule-form" onChange={onDirty} onSubmit={submit}><fieldset disabled={disabled}>
    <div className="work-time-current"><strong>Current approved schedule</strong>
      <p>{current?.startTime && current?.endTime ? `${clockLabel(current.startTime)}–${clockLabel(current.endTime)} · ${current.timeZone || timeZone}` : 'Start and end times have not been set.'}</p>
    </div>
    <div className="payroll-grid">
      <label>Approved start time<input type="time" name="startTime" step="60" value={startTime} onChange={event => { setStartTime(event.target.value); setInvalid(false); }} required aria-invalid={invalid} aria-describedby="approved-shift-help" /></label>
      <label>Approved end time<input type="time" name="endTime" step="60" value={endTime} onChange={event => { setEndTime(event.target.value); setInvalid(false); }} required aria-invalid={invalid} aria-describedby="approved-shift-help" /></label>
    </div>
    <p id="approved-shift-help" className="ska-muted">Use the facility time zone: {timeZone}. Choose an end time after the start on the same day.</p>
    {valid && <p role="status" className="work-time-window-preview">{clockLabel(startTime)}–{clockLabel(endTime)} · {duration(minutes * 60000)} scheduled. No automatic deductions.</p>}
    {invalid && <p role="alert">Choose an approved end time after the start time on the same day.</p>}
    <div className="payroll-grid"><label>Effective date<input name="effectiveOn" type="date" min={today} defaultValue={today} required /></label><label>Reason for schedule change<input name="reason" maxLength={1000} required /></label></div>
    <p>Applies to new workdays from this date. A day already started keeps its saved schedule. Actual recorded time is never capped by the schedule.</p>
    <button className="payroll-primary">Save approved schedule</button>
    {!!person.entries.length && <details><summary>Schedule history</summary><ul>{person.entries.map((entry, index) => <li key={index}><strong>From {entry.effectiveOn}</strong> · {entry.startTime && entry.endTime ? `${clockLabel(entry.startTime)}–${clockLabel(entry.endTime)}` : `Earlier daily-hours schedule · ${duration(entry.minutes * 60000)}`}<br /><span>{entry.reason}</span></li>)}</ul></details>}
  </fieldset></form>;
}

function ClockComparison({ row, zone }: { row: WorkDay; zone: string }) {
  const recordedZone = row.timeZone || zone;
  const scheduledZone = row.scheduleTimeZone || recordedZone;
  return <><dl className="work-time-comparison">
    <div><dt>Approved schedule</dt><dd>{approvedWindow(row)}</dd>{row.plannedStart && <small>{scheduledZone}</small>}</div>
    <div><dt>Recorded paid time</dt><dd>{duration(row.paidMillis)}</dd></div>
    <div><dt>{row.plannedStart ? 'Time outside approved schedule' : 'Time over earlier daily-hours limit'}</dt><dd>{duration(row.plannedStart ? (row.outsideMillis ?? row.extraMillis) : row.extraMillis)}</dd></div>
  </dl>
  <ClockSessions sessions={row.sessions} date={row.date} timeZone={recordedZone} earlier={row} />
  {recordedZone !== zone && <p>Recorded time zone: {recordedZone}</p>}
  {(row.earlyMillis || 0) > 0 && <p className="work-time-attention">Before approved start: {duration(row.earlyMillis || 0)}</p>}
  {(row.lateMillis || 0) > 0 && <p className="work-time-attention">After approved end: {duration(row.lateMillis || 0)}</p>}
  {row.scheduleIssue && <p role="alert">{row.scheduleIssue}</p>}
  </>;
}

function ShortDayWarnings({ warnings }: { warnings: ShortDayWarning[] }) {
  if (!warnings.length) return null;
  return <section aria-label="Short workday warnings" className="payroll-note"><h2>Short workday warnings</h2>
    <p>Two or more completed short days in one workweek need your attention. Paid credits do not change the actual time used for this warning.</p>
    <ul>{warnings.map(warning => <li key={warning.staffId + ':' + warning.weekStart}><strong>{warning.name}: {warning.count} short days</strong><p>Week of {warning.weekStart} · {warning.dates.join(', ')}</p><Link className="ska-link" to={'/staff/work-time?staff=' + encodeURIComponent(warning.staffId)}>Review short workdays for {warning.name}</Link></li>)}</ul>
  </section>;
}

function ManagerWorkTime({ admin, targetStaff, targetDate }: { admin: boolean; targetStaff: string; targetDate: string }) {
  const report = useUnsavedChanges(); const [dirty, setDirty] = useState(false); const [draft, setDraft] = useState(''); const [formTurn, setFormTurn] = useState(0);
  const [data, setData] = useState<WorkData | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState(targetStaff), [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0); const mounted = useRef(true); const saving = useRef(false);
  const reviewPanel = useRef<HTMLElement | null>(null);
  useEffect(() => { if (data && targetDate) reviewPanel.current?.scrollIntoView?.({ block: 'start' }); }, [data, targetDate]);
  useEffect(() => { report(dirty, busy); return () => report(false, false); }, [dirty, busy, report]);
  useEffect(() => { if (!dirty && !busy) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, busy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const c = new AbortController(); const requestUrl = targetDate ? url + '?start=' + targetDate + '&end=' + targetDate : url; void axios.get<{ data: WorkData }>(requestUrl, { signal: c.signal }).then(response => { if (!c.signal.aborted) { setData(response.data.data); setError(''); } }).catch(failure => { if (!c.signal.aborted && !axios.isCancel(failure)) { setData(null); setError(authError(failure, 'Could not load employee work time.')); } }); return () => c.abort(); }, [revision, targetDate]);
  function discard() { if (dirty && !window.confirm('Discard unsaved work-time form changes?')) return false; setDirty(false); setDraft(''); setFormTurn(n => n + 1); return true; }
  function mark(id: string) { setDirty(true); setDraft(id); }
  const locked = (id: string) => busy || dirty && draft !== id;
  async function save(path: string, body: unknown) {
    if (saving.current) return; saving.current = true; setBusy(true); setError(''); setMessage('');
    try { await axios.post(url + path, body); if (mounted.current) { setDirty(false); setDraft(''); setData(null); setRevision(n => n + 1); setMessage('Saved.'); } }
    catch (failure) { if (mounted.current) setError(authError(failure, 'Could not save this review. Refresh and review the latest record.')); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, run: (fields: FormData) => void) { event.preventDefault(); run(new FormData(event.currentTarget)); }
  const person = data?.staff.find(employee => employee.id === selected);
  const pending = data?.items.filter(row => row.status === 'pending' && (!selected || row.staffId === selected)) || [];
  const recorded = data?.items.filter(row => row.staffId === selected) || [];
  return <div className="payroll-page ska-core-page work-time-page"><header><h1>Work time</h1><p>Set when each employee is approved to work, compare their actual clock times, then review any time outside that schedule.</p><p>Schedule approval and paid-hour approval are separate. Private pay rates and tax records are administrator-only.</p></header>
    {targetDate && <p className="payroll-note">Showing {targetDate}. <Link to={'/staff/work-time' + (selected ? '?staff=' + encodeURIComponent(selected) : '')}>Show recent workdays</Link></p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="payroll-actions"><button disabled={busy} onClick={() => { if (discard()) setRevision(n => n + 1); }}>Refresh work time</button>{dirty && <button disabled={busy} onClick={discard}>Discard unsaved changes</button>}</div>
    {dirty && <p className="payroll-note">Save or discard this form before editing another one.</p>}
    {!data ? !error && <p role="status">Loading work time…</p> : <>
      {admin && <ShortDayWarnings warnings={(data.shortDayWarnings || []).filter(warning => !selected || warning.staffId === selected)} />}
      <section><h2><CalendarClock size={23} aria-hidden="true" />1. Set approved schedule</h2><label>Employee<select aria-label="Work-time employee" value={selected} disabled={busy} onChange={event => { if (discard()) setSelected(event.target.value); }}><option value="">Choose an employee</option>{data.staff.map(employee => <option key={employee.id} value={employee.id}>{employee.name}{employee.active ? '' : ' · Inactive'}</option>)}</select></label>
        {person ? <ScheduleForm key={person.id + ':' + person.scheduleVersion + ':' + formTurn} person={person} today={data.today} timeZone={data.timeZone} disabled={locked('schedule')} onDirty={() => mark('schedule')} onSave={body => void save('/staff/' + encodeURIComponent(person.id) + '/schedule', body)} /> : <p>Choose an employee to set an approved start and end time.</p>}
      </section>
      <section><h2><ClipboardCheck size={23} aria-hidden="true" />2. Review clocked time</h2><p>{data.timeZone} · {targetDate || 'Last 60 days'}. These are actual clock records, not a pay calculation.</p>
        {!person ? <p>Choose an employee above to see their approved schedule beside every recorded day.</p> : !recorded.length ? <p>No clocked workdays for {person.name} in this period.</p> : <div className="work-time-day-list">{recorded.map(row => <article key={row.staffId + ':' + row.date} className="work-time-day" aria-label={person.name + ' time on ' + row.date}><div className="work-time-day-head"><h3>{row.date}</h3><span className={'payroll-status ' + (row.status === 'within-schedule' || row.status === 'confirmed' || row.status === 'corrected' ? 'is-ready' : '')}>{statusLabel(row)}</span></div><ClockComparison row={row} zone={data.timeZone} /></article>)}</div>}
      </section>
      <section ref={reviewPanel}><h2>3. Review time outside schedule ({pending.length})</h2><p>Confirm actual work, or correct a verified late clock-out mistake. Recorded time is kept until an explicit reviewed correction; it is never silently removed.</p>
        {!pending.length && <p>No extra time is waiting for review.</p>}
        {pending.map(row => { const id = row.staffId + ':' + row.date; return <article className="payroll-calculation-day" key={id + ':' + formTurn}><h3>{row.name} · {row.date}</h3><ClockComparison row={row} zone={data.timeZone} />
          <form onChange={() => mark('review:' + id)} onSubmit={event => submit(event, fields => void save('/staff/' + encodeURIComponent(row.staffId) + '/review', { version: row.version, date: row.date, decision: 'worked', reason: fields.get('reason') }))}><fieldset disabled={locked('review:' + id)}><label>Extra-work review note<input name="reason" required maxLength={1000} /></label><button>Confirm extra time was worked</button></fieldset></form>
          {row.canCorrect && (!row.plannedStart || ((row.lateMillis || 0) > 0 && !row.earlyMillis && !row.scheduleIssue)) && <details><summary>Correct a late clock-out mistake</summary><form onChange={() => mark('correction:' + id)} onSubmit={event => submit(event, fields => void save('/staff/' + encodeURIComponent(row.staffId) + '/review', { version: row.version, date: row.date, decision: 'clock-error', workEndedAt: row.date + 'T' + String(fields.get('end')), occurrence: fields.get('occurrence') || undefined, noWorkAfterEnd: fields.has('confirmed'), reason: fields.get('reason') }))}><fieldset disabled={locked('correction:' + id)}><label>Actual work ended at ({data.timeZone})<input name="end" type="time" step="1" required /></label><label>Repeated daylight-saving time<select name="occurrence"><option value="">Not applicable</option><option value="earlier">First occurrence</option><option value="later">Second occurrence</option></select></label><label>Clock correction reason<input name="reason" required maxLength={1000} /></label><label className="payroll-check"><input name="confirmed" type="checkbox" required />I verified no work was performed after this time.</label><button>Save verified clock correction</button></fieldset></form></details>}
        </article>; })}
      </section>
      <section><h2>Recent work-time decisions</h2><ul>{data.items.filter(row => ['confirmed', 'corrected'].includes(row.status) && (!selected || row.staffId === selected)).map(row => <li key={row.staffId + ':' + row.date}>{row.name} · {row.date} · {row.status === 'confirmed' ? 'Outside time confirmed' : 'Clock time corrected'} · {row.reason}</li>)}</ul><p>{admin ? <Link to="/staff/payroll">Continue to pay calculation</Link> : 'An administrator approves paid hours and calculates pay after this review.'}</p><Link to="/staff">Staff directory</Link></section>
    </>}
  </div>;
}
export function ExtraTimeAlerts() {
  const auth=useContext(AuthContext); const account=auth?.account, serverUnavailable=auth?.serverUnavailable;
  if(!account||account.disabled||account.mustChangePassword||serverUnavailable||!['admin','editor'].includes(account.role))return null;
  return <ManagerExtraTimeAlerts key={account.id+':'+account.role} admin={account.role === 'admin'}/>;
}
function ManagerExtraTimeAlerts({ admin }: { admin: boolean }){
  const [data,setData]=useState<WorkData|null>(null),[error,setError]=useState(false);const pending=useRef<AbortController|null>(null);
  const refresh=useCallback(()=>{pending.current?.abort();const c=new AbortController();pending.current=c;void axios.get<{data:WorkData}>(url,{signal:c.signal}).then(r=>{if(!c.signal.aborted){setData(r.data.data);setError(false);}}).catch(()=>{if(!c.signal.aborted){setData(null);setError(true);}});},[]);
  useEffect(()=>{refresh();const visible=()=>{if(document.visibilityState!=='hidden')refresh();};const timer=window.setInterval(visible,60000);window.addEventListener('focus',visible);window.addEventListener('online',visible);return()=>{pending.current?.abort();window.clearInterval(timer);window.removeEventListener('focus',visible);window.removeEventListener('online',visible);};},[refresh]);
  const count = data?.items.filter(item => item.status === 'pending').length || 0;
  return <section className="ska-panel" aria-label="Extra employee time reminders"><div className="ska-panel-body"><h2>Extra employee time</h2>{error?<p>Could not check extra time. <button className="ska-button" onClick={refresh}>Retry time reminders</button></p>:!data?<p>Checking work-time reviews…</p>:<><p>{count?`${count} workday${count===1?' needs':'s need'} extra-time review.`:'No extra time waiting for review.'} <Link className="ska-link" to="/staff/work-time">Review work time</Link></p>
    {admin && (data.overtimeReviewCount || 0) > 0 && <div className="payroll-note"><h3>Overtime needs your review</h3><p>{data.overtimeReviewCount} workday{data.overtimeReviewCount === 1 ? '' : 's'} waiting for an administrator's pay decision.</p><Link className="ska-link" to="/staff/payroll">Review pay decisions</Link></div>}
    {admin && <ShortDayWarnings warnings={(data.shortDayWarnings || []).filter(warning => warning.weekStart <= data.today && warning.weekEnd >= data.today)} />}
  </>}</div></section>;
}
