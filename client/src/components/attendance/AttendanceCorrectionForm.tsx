import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { attendanceUrl, attendanceTime, localTimeInput } from '../../api/attendance';
import type { AttendanceRecord, AttendanceCorrection, AttendanceRoom } from '../../api/attendance';
import { authError } from '../../auth/transport';

export function AttendanceCorrectionForm({ record: initial, name, rooms, zone, canWrite, onSaved, onClose }: {
  record: AttendanceRecord; name: string; rooms: AttendanceRoom[]; zone: string; canWrite: boolean; onSaved: () => void; onClose: () => void;
}) {
  const [record, setRecord] = useState(initial);
  const [history, setHistory] = useState<AttendanceCorrection[]>([]);
  const [roomId, setRoomId] = useState(initial.roomId || '');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [voided, setVoided] = useState(initial.voided);
  const [reason, setReason] = useState('');
  const [firstOccurrence, setFirstOccurrence] = useState('');
  const [lastOccurrence, setLastOccurrence] = useState('');
  const [loading, setLoading] = useState(true);
  const [recordReady, setRecordReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setRecordReady(false); setError('');
    void Promise.all([
      axios.get<AttendanceRecord>(attendanceUrl + '/' + encodeURIComponent(initial.id), { signal: controller.signal }),
      axios.get<AttendanceCorrection[]>(attendanceUrl + '/' + encodeURIComponent(initial.id) + '/corrections', { signal: controller.signal }),
    ]).then(([current, changes]) => {
      if (controller.signal.aborted) return;
      setRecord(current.data); setHistory(changes.data); setRoomId(current.data.roomId || '');
      setCheckIn(localTimeInput(current.data.checkIn, zone)); setCheckOut(localTimeInput(current.data.checkOut, zone));
      setVoided(current.data.voided); setReason(''); setFirstOccurrence(''); setLastOccurrence('');
      setRecordReady(true);
    }).catch((failure) => { if (!controller.signal.aborted) setError(authError(failure, 'Could not load the attendance record.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [initial.id, zone, revision]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || loading || !recordReady || !canWrite) return;
    if (!reason.trim()) { setError('Explain why this record is being corrected.'); return; }
    if (!voided && (!roomId || !checkIn)) { setError('Choose a room and enter a check-in time.'); return; }
    if (!window.confirm(voided ? 'Void this mistaken visit? Its original values and correction history will remain.' : 'Save this attendance correction and its reason?')) return;
    setSaving(true); setError('');
    try {
      // Preserve unchanged instants exactly, including their daylight-saving offset.
      await axios.put(attendanceUrl + '/' + encodeURIComponent(record.id) + '/correction', {
        version: record.version, reason: reason.trim(), voided,
        ...(!voided ? { roomId,
          checkIn: checkIn === localTimeInput(record.checkIn, zone) && !firstOccurrence ? record.checkIn : checkIn,
          checkOut: checkOut === localTimeInput(record.checkOut, zone) && !lastOccurrence ? record.checkOut : checkOut || null,
          checkInOccurrence: firstOccurrence, checkOutOccurrence: lastOccurrence } : {}),
      });
      onSaved();
    } catch (failure) { setError(authError(failure, 'Could not save the correction.')); }
    finally { setSaving(false); }
  }
  return <section aria-label="Attendance record" className="space-y-4 rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-bold">Attendance for {name}</h2><p className="text-sm text-slate-600">All times use {zone}.</p></div>
      <button disabled={saving} onClick={onClose} className="rounded-lg border px-3 py-2">Close record</button></div>
    {loading && <p role="status">Loading record…</p>}
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-800"><p>{error}</p><button disabled={saving} className="mt-2 underline" onClick={() => { if (window.confirm('Reload the current record and discard unsaved correction edits?')) setRevision((n) => n + 1); }}>Reload current record</button></div>}
    {canWrite && <form onSubmit={(event) => void save(event)} noValidate><fieldset disabled={!recordReady || loading || saving} className="space-y-4">
      <label className="flex items-center gap-2"><input type="checkbox" checked={voided} onChange={(event) => setVoided(event.target.checked)} />Void mistaken or duplicate visit</label>
      {!voided && <div className="grid gap-4 md:grid-cols-3">
        <label>Attendance room<select value={roomId} onChange={(event) => setRoomId(event.target.value)} className="mt-1 block w-full rounded-lg border p-2"><option value="">Choose room</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}{room.active ? '' : ' (archived)'}</option>)}</select></label>
        <label>Check-in time<input type="datetime-local" step="1" value={checkIn} onChange={(event) => { setCheckIn(event.target.value); setFirstOccurrence(''); }} className="mt-1 block w-full rounded-lg border p-2" /></label>
        <label>Check-out time<input type="datetime-local" step="1" value={checkOut} onChange={(event) => { setCheckOut(event.target.value); setLastOccurrence(''); }} className="mt-1 block w-full rounded-lg border p-2" /><span className="text-xs text-slate-500">Leave blank for an open visit.</span></label>
      </div>}
      {!voided && <details className="text-sm text-slate-600"><summary className="cursor-pointer">Times repeated when clocks move back</summary><p className="my-2">If the server reports a repeated local time, choose its occurrence.</p>
        <div className="flex flex-wrap gap-4">{[
          { label: 'Check-in occurrence', value: firstOccurrence, change: setFirstOccurrence },
          { label: 'Check-out occurrence', value: lastOccurrence, change: setLastOccurrence },
        ].map((field) => <label key={field.label}>{field.label}<select value={field.value} onChange={(event) => field.change(event.target.value)} className="ml-2 rounded border p-2"><option value="">Ask if ambiguous</option><option value="earlier">First occurrence</option><option value="later">Second occurrence</option></select></label>)}</div>
      </details>}
      <label className="block">Correction reason<textarea value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
      <button type="submit" className="ska-button is-primary">{saving ? 'Saving…' : 'Save correction'}</button>
    </fieldset></form>}
    {!loading && recordReady && <div><h3 className="font-semibold">Correction history</h3>{!history.length ? <p className="mt-2 text-sm text-slate-600">No corrections recorded.</p> : <ol className="mt-3 space-y-3">{history.map((entry) => <li key={entry.id} className="rounded-lg bg-slate-50 p-3 text-sm">
      <p className="font-semibold">{attendanceTime(entry.occurredAt, zone)} · {entry.actorUsername}</p><p className="my-2 whitespace-pre-wrap">{entry.reason}</p>
      <p>Before: {attendanceTime(entry.before.checkIn, zone)} → {entry.before.checkOut ? attendanceTime(entry.before.checkOut, zone) : 'Open'} · {rooms.find((room) => room.id === entry.before.roomId)?.name || 'Unknown room'}{entry.before.voided ? ' · Voided' : ''}</p>
      <p>After: {attendanceTime(entry.after.checkIn, zone)} → {entry.after.checkOut ? attendanceTime(entry.after.checkOut, zone) : 'Open'} · {rooms.find((room) => room.id === entry.after.roomId)?.name || 'Unknown room'}{entry.after.voided ? ' · Voided' : ''}</p>
    </li>)}</ol>}</div>}
  </section>;
}
