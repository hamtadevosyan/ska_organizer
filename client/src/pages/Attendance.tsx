import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { ArrowRight, Check, ClipboardCheck, History, LogOut, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { childName } from '../api/children';
import { attendanceUrl, attendanceTime, getDailyAttendance, localTimeInput, newAttendanceRequestId } from '../api/attendance';
import type { DailyAttendance, AttendanceRecord, AttendanceRoom, AttendanceRow } from '../api/attendance';
import { AttendanceCorrectionForm } from '../components/attendance/AttendanceCorrectionForm';
import { ChildProfile } from '../components/children/ChildProfile';
import './attendance.css';

export default function Attendance() {
  const { account } = useAuth();
  const canWrite = account?.role === 'admin' || account?.role === 'editor';
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || undefined;
  const roomId = params.get('room') || undefined;
  const [data, setData] = useState<DailyAttendance | null>(null);
  const [rooms, setRooms] = useState<AttendanceRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [q, setQ] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<{ record: AttendanceRecord; name: string } | null>(null);
  const [profile, setProfile] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const afterRefreshFocus = useRef<string | null>(null);
  const findChild = params.get('find') === 'child';
  useEffect(() => { if (findChild) searchRef.current?.focus(); }, [findChild]);
  useEffect(() => {
    if (selected || profile) detailRef.current?.focus();
    else if (detailTrigger.current?.isConnected) detailTrigger.current.focus({ preventScroll: true });
  }, [selected, profile]);
  useEffect(() => {
    if (!data || !afterRefreshFocus.current) return;
    const target = document.getElementById('attendance-action-' + afterRefreshFocus.current);
    (target || searchRef.current)?.focus({ preventScroll: true });
    afterRefreshFocus.current = null;
  }, [data]);
  const actionPending = useRef(false);
  const requests = useRef(new Map<string, string>());
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(null);
    void getDailyAttendance(date, roomId, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setData(result); setRooms(result.rooms); }
    }).catch((failure) => { if (!controller.signal.aborted) setError(authError(failure, 'Could not load attendance. Use Refresh to try again.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, roomId, revision]);
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setSelected(null); setProfile(''); setMessage(''); setParams(next);
  }
  async function mutate(row: AttendanceRow, record?: AttendanceRecord) {
    if (!data || data.date !== data.today || actionPending.current || !canWrite) return;
    actionPending.current = true; setBusy(true); setError(''); setMessage('');
    const key = row.childId + ':' + row.checkInRoomId;
    let finishedRetry = false;
    try {
      if (record) {
        await axios.post(attendanceUrl + '/' + encodeURIComponent(record.id) + '/checkout', { date: data.today, version: record.version });
        requests.current.delete(key);
      } else {
        const requestId = requests.current.get(key) || newAttendanceRequestId();
        requests.current.set(key, requestId);
        const { data: saved } = await axios.post<AttendanceRecord>(attendanceUrl + '/checkin', { childId: row.childId, roomId: row.checkInRoomId, date: data.today, requestId });
        finishedRetry = !!saved.checkOut || saved.voided;
        requests.current.delete(key);
      }
      setMessage(finishedRetry ? 'The earlier check-in was already closed or voided. Attendance was refreshed; record a new arrival if needed.' : (row.child ? childName(row.child) : 'Child') + (record ? ' checked out.' : ' checked in.'));
      afterRefreshFocus.current = row.childId;
      setRevision((n) => n + 1);
    } catch (failure) { setError(authError(failure, 'Could not record attendance. Refresh before trying again.')); }
    finally { actionPending.current = false; setBusy(false); }
  }
  const locked = busy || loading || !!selected;
  const roomName = (id: string | null) => rooms.find((room) => room.id === id)?.name || 'Unassigned';
  const rows = data?.rows.filter((row) => !q.trim() || (row.child && (childName(row.child) + ' ' + (row.child.preferredName || '')).toLowerCase().includes(q.trim().toLowerCase()))) || [];
  return <div className="ska-page attendance-page">
    <header className="ska-page-head"><div><span className="ska-kicker">Daily check-in</span><h1>Who's here today?</h1>
      <p>Find a child, then check them in or out.</p></div>
      <button type="button" disabled={loading || locked} onClick={() => { setProfile(''); setRevision((n) => n + 1); }} className="ska-button" aria-label="Refresh attendance"><RefreshCw size={17} aria-hidden="true" />Refresh</button></header>
    {!canWrite && <p className="ska-alert">Read-only access. You can view attendance; staff record arrivals and departures.</p>}
    <section aria-label="Attendance filters" className="ska-panel attendance-filters">
      <div><label className="ska-field">Attendance date<input type="date" min="1900-01-01" max={data?.today} value={date || data?.date || ''} disabled={busy || !!selected} onChange={(event) => filter('date', event.target.value)} /></label>
        <button type="button" disabled={busy || !!selected} className="ska-link" onClick={() => filter('date', '')}>Today at the facility</button></div>
      <label className="ska-field">Attendance room<select value={roomId || ''} disabled={busy || !!selected} onChange={(event) => filter('room', event.target.value)}><option value="">All rooms</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}{room.active ? '' : ' (archived)'}</option>)}</select></label>
      <label className="ska-field attendance-search">Find a child<span><Search size={18} aria-hidden="true" /><input ref={searchRef} aria-label="Search attendance" type="search" maxLength={100} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Child or preferred name" autoComplete="off" /></span></label>
    </section>
    {error && <p role="alert" className="ska-alert is-error">{error}</p>}
    {message && <p role="status" className="ska-alert attendance-confirmation"><Check size={18} aria-hidden="true" />{message}</p>}
    {loading && <p role="status" className="ska-loading"><RefreshCw size={22} aria-hidden="true" />Loading attendance…</p>}
    {data && <>
      <div className="attendance-summary" aria-label="Attendance counts">
        {data.presentCount !== null && <div><span className="attendance-summary-icon"><ClipboardCheck size={21} aria-hidden="true" /></span><strong>{data.presentCount}</strong><span>Here now{data.room ? ' in ' + data.room.name : ''}</span></div>}
        <div><span className="attendance-summary-icon"><History size={21} aria-hidden="true" /></span><strong>{data.attendedCount}</strong><span>Children recorded for this date</span></div>
        <p>Facility time: <strong>{data.timeZone}</strong><span>Counts cover {data.room?.name || 'all rooms'}. Search only filters the list below.</span></p>
      </div>
      {data.date !== data.today && <p className="ska-alert">Historical dates show recorded visits, including children whose room or enrollment later changed. Use Today for arrivals and departures.</p>}
      {(selected || profile) && <div ref={detailRef} tabIndex={-1} className="attendance-detail-panel">
        {selected && <AttendanceCorrectionForm key={selected.record.id} {...selected} rooms={rooms} zone={data.timeZone} canWrite={canWrite}
          onClose={() => setSelected(null)} onSaved={() => { afterRefreshFocus.current = selected.record.childId; setSelected(null); setMessage('Attendance correction saved with its history.'); setRevision((n) => n + 1); }} />}
        {profile && <ChildProfile id={profile} rooms={rooms} onClose={() => setProfile('')} />}
      </div>}
      <div className="attendance-list-heading"><h2>{data.room?.name || 'All children'}</h2><span>{rows.length} of {data.rows.length} children</span></div>
      {!rows.length ? <div className="ska-panel attendance-empty"><Search size={28} aria-hidden="true" /><p>No children or recorded visits match these filters.</p>{q && <button type="button" className="ska-button" onClick={() => { setQ(''); searchRef.current?.focus(); }}>Clear search</button>}</div> :
        <div className="attendance-list">{rows.map((row) => {
          const name = row.child ? childName(row.child) : 'Child record unavailable';
          const visits = [...new Map([...row.records, ...row.openVisits].map((record) => [record.id, record])).values()];
          const latest = row.records.filter((record) => !record.voided).at(-1);
          const review = visits.some((record) => !record.voided && (record.needsReview || (!record.checkOut && (!record.checkIn || Date.parse(record.checkIn) > Date.parse(data.serverNow) || localTimeInput(record.checkIn, data.timeZone).slice(0, 10) !== data.today))));
          const status = review ? 'Needs review' : row.openVisits.length ? 'Present' : latest?.checkOut ? 'Checked out' : latest ? 'Open visit' : 'Not checked in';
          const open = visits.filter((record) => !record.checkOut && !record.voided);
          const nextCheckout = !review && open.length === 1 && open[0].checkIn ? open[0] : null;
          return <article key={row.childId} aria-label={name} className="attendance-child">
            <div className="attendance-child-main">
              <div className="attendance-child-info"><span className="child-initials" aria-hidden="true">{row.child ? [row.child.firstName, row.child.lastName].map((part) => part[0]).join('') : '?'}</span><div><h3>{name}</h3>{row.child?.preferredName && <p>Goes by {row.child.preferredName}</p>}
                <p>{roomName(row.child?.roomId || null)}{row.child && !row.child.active ? ' · Inactive enrollment' : ''}</p></div></div>
              <span className={'attendance-status ' + (review ? 'needs-review' : status === 'Present' ? 'is-present' : status === 'Checked out' ? 'is-out' : 'not-in')}><span aria-hidden="true" />{status}</span>
              <div className="attendance-next-action">
                {canWrite && data.date === data.today && (nextCheckout ? <button type="button" id={'attendance-action-' + row.childId} disabled={locked} onClick={() => void mutate(row, nextCheckout)} aria-label={'Check out ' + name} className="ska-button">Check out <LogOut size={16} aria-hidden="true" /></button> :
                  row.canCheckIn && <button type="button" id={'attendance-action-' + row.childId} disabled={locked} onClick={() => void mutate(row)} aria-label={'Check in ' + name} className="ska-button is-primary">Check in <ArrowRight size={16} aria-hidden="true" /></button>)}
                {!canWrite && <span className="ska-muted">Read only</span>}
                {canWrite && row.child?.active && !row.checkInRoomId && <p className="ska-muted">Assign a room in Children before checking in.</p>}
              </div>
            </div>
            <div className="attendance-child-footer">
              {row.child && <button type="button" disabled={locked} onClick={(event) => { detailTrigger.current = event.currentTarget; setSelected(null); setProfile(row.childId); }} className="ska-link">View profile</button>}
              {!visits.length && <p className="ska-muted">No visit recorded.</p>}
              {!!visits.length && <details className="attendance-visits" open={review || open.length > 1 || undefined}>
                <summary><History size={16} aria-hidden="true" />Visit details <span>({visits.length})</span></summary>
                <div className="attendance-visit-list">{visits.map((record) => <div key={record.id} className="attendance-visit">
                  <p className="attendance-visit-room">{roomName(record.roomId)}{record.voided ? ' · Voided' : ''}</p>
                  <p>In: {attendanceTime(record.checkIn, data.timeZone)}</p><p>Out: {record.checkOut ? attendanceTime(record.checkOut, data.timeZone) : record.voided ? 'Voided visit' : 'Open'}</p>
                  <div className="attendance-visit-actions"><button type="button" disabled={locked} onClick={(event) => { detailTrigger.current = event.currentTarget; setSelected({ record, name }); setProfile(''); }} className="ska-link">{canWrite ? 'Correct / history' : 'View history'}</button>
                    {canWrite && data.date === data.today && !nextCheckout && !record.checkOut && !record.voided && <button type="button" disabled={locked || !record.checkIn} onClick={() => void mutate(row, record)} aria-label={'Check out ' + name} className="ska-button">Check out</button>}</div>
                </div>)}</div>
              </details>}
            </div>
          </article>;
        })}</div>}
      <p className="attendance-footnote">Refresh to see changes recorded on another device. Corrections retain the original values and the reason for each change.</p>
    </>}
  </div>;
}
