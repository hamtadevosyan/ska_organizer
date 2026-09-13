import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { ClipboardCheck } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { childName } from '../api/children';
import { attendanceUrl, attendanceTime, getDailyAttendance, localTimeInput, newAttendanceRequestId } from '../api/attendance';
import type { DailyAttendance, AttendanceRecord, AttendanceRoom, AttendanceRow } from '../api/attendance';
import { AttendanceCorrectionForm } from '../components/attendance/AttendanceCorrectionForm';
import { ChildProfile } from '../components/children/ChildProfile';

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
    if (!data || actionPending.current || !canWrite) return;
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
      setRevision((n) => n + 1);
    } catch (failure) { setError(authError(failure, 'Could not record attendance. Refresh before trying again.')); }
    finally { actionPending.current = false; setBusy(false); }
  }
  const locked = busy || !!selected;
  const roomName = (id: string | null) => rooms.find((room) => room.id === id)?.name || 'Unassigned';
  const rows = data?.rows.filter((row) => !q.trim() || (row.child && (childName(row.child) + ' ' + (row.child.preferredName || '')).toLowerCase().includes(q.trim().toLowerCase()))) || [];
  return <div className="mx-auto max-w-7xl space-y-6 p-2 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="flex items-center gap-3 text-3xl font-bold text-slate-900"><ClipboardCheck className="text-emerald-700" />Attendance</h1>
      <p className="mt-2 text-slate-600">Record arrivals, departures and corrections by room.</p></div>
      <button disabled={loading || locked} onClick={() => { setProfile(''); setRevision((n) => n + 1); }} className="rounded-lg border bg-white px-4 py-2 disabled:opacity-50">Refresh attendance</button></header>
    <section aria-label="Attendance filters" className="grid gap-4 rounded-2xl border bg-white p-5 md:grid-cols-3">
      <label>Attendance date<input type="date" min="1900-01-01" max={data?.today} value={date || data?.date || ''} disabled={locked} onChange={(event) => filter('date', event.target.value)} className="mt-1 block w-full rounded-lg border p-2.5" />
        <button disabled={locked} className="mt-2 text-sm font-semibold text-emerald-800" onClick={() => filter('date', '')}>Today at the facility</button></label>
      <label>Attendance room<select value={roomId || ''} disabled={locked} onChange={(event) => filter('room', event.target.value)} className="mt-1 block w-full rounded-lg border p-2.5"><option value="">All rooms</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}{room.active ? '' : ' (archived)'}</option>)}</select></label>
      <label>Search attendance<input type="search" maxLength={100} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Child or preferred name" className="mt-1 block w-full rounded-lg border p-2.5" /></label>
    </section>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    {loading && <p role="status">Loading attendance…</p>}
    {data && <>
      <div className="flex flex-wrap gap-5 text-sm text-slate-600"><p>Facility time: <strong>{data.timeZone}</strong></p><p>Recorded for this date: <strong>{data.attendedCount}</strong></p>
        {data.presentCount !== null && <p>Present now{data.room ? ' in ' + data.room.name : ''}: <strong>{data.presentCount}</strong></p>}</div>
      {data.date !== data.today && <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">Historical dates show recorded visits, including children whose room or enrollment later changed. Use Today for arrivals and departures.</p>}
      {selected && <AttendanceCorrectionForm key={selected.record.id} {...selected} rooms={rooms} zone={data.timeZone} canWrite={canWrite}
        onClose={() => setSelected(null)} onSaved={() => { setSelected(null); setMessage('Attendance correction saved with its history.'); setRevision((n) => n + 1); }} />}
      {profile && <ChildProfile id={profile} rooms={rooms} onClose={() => setProfile('')} />}
      {!rows.length ? <p className="rounded-2xl border bg-white p-8 text-center text-slate-600">No children or recorded visits match these filters.</p> : <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full text-left text-sm">
        <thead className="bg-slate-50"><tr><th className="p-4">Child</th><th className="p-4">Status</th><th className="p-4">Visits</th><th className="p-4">Actions</th></tr></thead>
        <tbody>{rows.map((row) => {
          const name = row.child ? childName(row.child) : 'Child record unavailable';
          const visits = [...new Map([...row.records, ...row.openVisits].map((record) => [record.id, record])).values()];
          const latest = row.records.filter((record) => !record.voided).at(-1);
          const review = visits.some((record) => !record.voided && (record.needsReview || (!record.checkOut && (!record.checkIn || Date.parse(record.checkIn) > Date.parse(data.serverNow) || localTimeInput(record.checkIn, data.timeZone).slice(0, 10) !== data.today))));
          const status = review ? 'Needs review' : row.openVisits.length ? 'Present' : latest?.checkOut ? 'Checked out' : latest ? 'Open visit' : 'Not checked in';
          return <tr key={row.childId} aria-label={name} className="border-t align-top">
            <td className="p-4"><p className="font-semibold">{name}</p>{row.child?.preferredName && <p className="mt-1 text-slate-500">Goes by {row.child.preferredName}</p>}
              <p className="mt-1 text-slate-500">{roomName(row.child?.roomId || null)}{row.child && !row.child.active ? ' · Inactive enrollment' : ''}</p></td>
            <td className="p-4"><span className={'inline-block rounded-full px-3 py-1 ' + (review ? 'bg-amber-100 text-amber-900' : status === 'Present' ? 'bg-emerald-50 text-emerald-900' : 'bg-slate-100 text-slate-700')}>{status}</span></td>
            <td className="space-y-3 p-4">{!visits.length ? <p className="text-slate-500">No visit recorded.</p> : visits.map((record) => <div key={record.id} className="rounded-lg bg-slate-50 p-3">
              <p className="font-medium">{roomName(record.roomId)}{record.voided ? ' · Voided' : ''}</p>
              <p>In: {attendanceTime(record.checkIn, data.timeZone)}</p><p>Out: {record.checkOut ? attendanceTime(record.checkOut, data.timeZone) : record.voided ? 'Voided visit' : 'Open'}</p>
              <div className="mt-2 flex flex-wrap gap-4"><button disabled={locked} onClick={() => { setSelected({ record, name }); setProfile(''); }} className="font-semibold text-emerald-800 disabled:opacity-50">{canWrite ? 'Correct / history' : 'View history'}</button>
                {canWrite && data.date === data.today && !record.checkOut && !record.voided && <button disabled={locked || !record.checkIn} onClick={() => void mutate(row, record)} aria-label={'Check out ' + name} className="rounded border border-emerald-700 px-3 py-1 font-semibold text-emerald-800 disabled:opacity-50">Check out</button>}</div>
            </div>)}</td>
            <td className="p-4"><div className="flex flex-col items-start gap-3">{canWrite && row.canCheckIn && <button disabled={locked} onClick={() => void mutate(row)} aria-label={'Check in ' + name} className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Check in</button>}
              {row.child && <button disabled={locked} onClick={() => setProfile(row.childId)} className="text-emerald-800 disabled:opacity-50">View profile</button>}
              {canWrite && row.child?.active && !row.checkInRoomId && <p className="max-w-40 text-xs text-slate-500">Assign a room in Children before checking in.</p>}</div></td>
          </tr>;
        })}</tbody></table></div>}
      <p className="text-xs text-slate-500">Refresh to see changes recorded on another device. Corrections retain the original values and the reason for each change.</p>
    </>}
  </div>;
}
