import { useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Building2, Plus } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { saveRoom } from '../api/rooms';
import type { Room, RoomSettings } from '../api/rooms';
import { useRooms } from '../components/rooms/useRooms';
import { RoomAssignments } from '../components/rooms/RoomAssignments';

const empty = { name: '', ageMinMonths: '', ageMaxMonths: '', capacity: '', active: true };
const inputClass = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2.5';
export default function Rooms() {
  const { account } = useAuth();
  const admin = account?.role === 'admin';
  const canAssign = account?.role === 'admin' || account?.role === 'editor';
  const { rooms, loading, error: loadError, refresh } = useRooms();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const visible = rooms.filter((room) => showArchived || room.active);
  function open(room: Room | null) {
    setEditing(room);
    setForm(room ? { name: room.name, ageMinMonths: room.ageMinMonths?.toString() ?? '', ageMaxMonths: room.ageMaxMonths?.toString() ?? '', capacity: room.capacity?.toString() ?? '', active: room.active } : empty);
    setFields({}); setError(''); setMessage(''); setFormOpen(true);
  }
  function failureMessage(failure: unknown) {
    if (axios.isCancel(failure)) return;
    setError(authError(failure, 'Could not save this room.'));
    if (axios.isAxiosError(failure)) setFields(failure.response?.data?.error?.fields || {});
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const settings: RoomSettings = { name: form.name.trim(), ageMinMonths: Number(form.ageMinMonths), ageMaxMonths: Number(form.ageMaxMonths), capacity: Number(form.capacity), active: form.active };
    const invalid: Record<string, string> = {};
    if (!settings.name || settings.name.length > 100) invalid.name = 'Enter a name between 1 and 100 characters.';
    for (const key of ['ageMinMonths', 'ageMaxMonths'] as const) {
      const value = settings[key];
      if (!form[key].trim() || value === null || !Number.isInteger(value) || value < 0 || value > 216) invalid[key] = 'Enter a whole number of months from 0 to 216.';
    }
    if (settings.ageMaxMonths! < settings.ageMinMonths!) invalid.ageMaxMonths = 'Maximum age must be at least the minimum age.';
    if (!form.capacity.trim() || !Number.isInteger(settings.capacity) || settings.capacity! <= 0 || settings.capacity! > 2147483647) invalid.capacity = 'Enter a positive whole-number capacity.';
    setFields(invalid);
    if (Object.keys(invalid).length) { setError('Correct the highlighted room settings.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      await saveRoom(editing?.id || null, settings);
      setFormOpen(false); setEditing(null); setForm(empty);
      setMessage(editing ? 'Room updated.' : 'Room created.');
      await refresh();
    } catch (failure) { failureMessage(failure); }
    finally { setBusy(false); }
  }
  async function archive(room: Room) {
    if (!window.confirm('Archive ' + room.name + '? Existing assignments and history will remain. New assignments and check-ins will be blocked.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await saveRoom(room.id, { active: false });
      setMessage('Room archived. Existing assignments and history were preserved.');
      if (editing?.id === room.id) { setEditing(null); setFormOpen(false); }
      await refresh();
    } catch (failure) { failureMessage(failure); }
    finally { setBusy(false); }
  }
  const fieldError = (name: string) => fields[name] && <p id={'room-error-' + name} className="mt-1 text-sm text-red-700">{fields[name]}</p>;
  return <div className="mx-auto max-w-6xl space-y-6 p-2 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-3xl font-bold text-slate-900">Rooms &amp; Classes</h1><p className="mt-2 text-slate-600">Manage room settings and see where actively enrolled children are assigned.</p></div>
      <div className="flex gap-3"><button disabled={busy || loading} onClick={() => void refresh()} className="rounded-lg border bg-white px-4 py-2 disabled:opacity-50">Refresh rooms</button>
        {admin && <button disabled={busy} onClick={() => open(null)} className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white"><Plus size={18} />Add room</button>}</div>
    </header>
    {(loadError || error) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error || loadError}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    {admin && formOpen && <form onSubmit={(event) => void submit(event)} noValidate className="rounded-2xl border bg-white p-6 shadow-sm">
      <fieldset disabled={busy} className="space-y-4"><h2 className="text-xl font-bold">{editing ? 'Edit room' : 'Create room'}</h2>
        <label className="block">Room name<input required maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}
          aria-invalid={!!fields.name} aria-describedby={fields.name ? 'room-error-name' : undefined} className={inputClass} />{fieldError('name')}</label>
        <div className="grid gap-4 sm:grid-cols-3">
          {([['ageMinMonths', 'Minimum age (months)'], ['ageMaxMonths', 'Maximum age (months)'], ['capacity', 'Configured capacity']] as const).map(([key, label]) =>
            <label key={key} className="block">{label}<input required type="number" min={key === 'capacity' ? 1 : 0} max={key === 'capacity' ? 2147483647 : 216} step="1" value={form[key]}
              onChange={(event) => setForm({ ...form, [key]: event.target.value })} aria-invalid={!!fields[key]} aria-describedby={fields[key] ? 'room-error-' + key : undefined} className={inputClass} />{fieldError(key)}</label>)}
        </div>
        <p className="text-sm text-slate-600">Enter ages in months. For example, 2–5 years is 24–60 months.</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />Active — available for new assignments</label>
        {editing && !form.active && editing.active && <p className="rounded bg-amber-50 p-3">Saving archives this room. Existing assignments and history stay available.</p>}
        {editing && form.capacity && Number(form.capacity) < editing.assignedChildCount && <p role="alert" className="rounded bg-amber-50 p-3">{editing.assignedChildCount} children are assigned. The proposed capacity is lower than this count.</p>}
        <div className="flex gap-3"><button className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white">Save room</button>
          <button type="button" onClick={() => { setFormOpen(false); setEditing(null); setError(''); }} className="rounded-lg border px-4 py-2">Cancel</button></div>
      </fieldset>
    </form>}
    <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
      <p>{rooms.filter((room) => room.active).length} active rooms · {rooms.reduce((sum, room) => sum + room.assignedChildCount, 0)} assigned children</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Show archived rooms</label>
    </div>
    {loading && <p role="status">Loading rooms…</p>}
    {!loading && !visible.length && !loadError && <div className="rounded-2xl border border-dashed bg-white p-10 text-center">
      <Building2 className="mx-auto mb-3 text-emerald-700" size={32} /><p className="font-semibold">No {showArchived ? '' : 'active '}rooms yet.</p>
      <p className="mt-2 text-slate-600">{admin ? 'Add a room to start organizing classes.' : 'An administrator can add rooms.'}</p>
    </div>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {visible.map((room) => <article key={room.id} aria-label={room.name} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3"><h2 className="text-xl font-bold">{room.name}</h2><span className={'rounded-full px-3 py-1 text-xs font-semibold ' + (room.active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600')}>{room.active ? 'Active' : 'Archived'}</span></div>
        {room.needsConfiguration ? <p className="mt-4 text-amber-800">Needs setup: enter the age range and capacity before activating.</p> :
          <p className="mt-4 text-slate-600">{room.ageMinMonths}–{room.ageMaxMonths} months</p>}
        <p className="mt-3 text-2xl font-bold">{room.assignedChildCount}<span className="text-base font-normal text-slate-500"> / {room.capacity ?? '—'} children assigned</span></p>
        {room.overCapacity && <p role="alert" className="mt-2 rounded bg-amber-50 p-2 text-amber-900">Assigned count exceeds configured capacity.</p>}
        {admin && <div className="mt-5 flex gap-4 text-sm"><button disabled={busy || loading} onClick={() => open(room)} aria-label={'Edit ' + room.name} className="font-semibold text-emerald-800">Edit room</button>
          {room.active && <button disabled={busy || loading} onClick={() => void archive(room)} aria-label={'Archive ' + room.name} className="text-slate-600">Archive</button>}</div>}
      </article>)}
    </div>
    {canAssign && <RoomAssignments rooms={rooms} onChanged={refresh} />}
  </div>;
}
