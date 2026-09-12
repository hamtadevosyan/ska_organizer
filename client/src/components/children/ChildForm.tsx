import { useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { authError } from '../../auth/transport';
import { childName, saveChild } from '../../api/children';
import type { ChildMatch, ChildRecord, ChildSettings } from '../../api/children';
import type { Room } from '../../api/rooms';
import { RoomSelect } from '../rooms/RoomSelect';

const inputClass = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2.5';
export function ChildForm({ child, rooms, loadingRooms, onSaved, onCancel }: {
  child: ChildRecord | null; rooms: Room[]; loadingRooms: boolean;
  onSaved: (child: ChildRecord) => void; onCancel: () => void;
}) {
  const [form, setForm] = useState({ firstName: child?.firstName || '', lastName: child?.lastName || '',
    preferredName: child?.preferredName || '', dateOfBirth: child?.dateOfBirth || '', notes: child?.notes || '',
    roomId: child?.roomId || '', active: child?.active ?? true });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [duplicates, setDuplicates] = useState<ChildMatch[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [confirmCapacity, setConfirmCapacity] = useState(false);
  const [serverCapacityWarning, setServerCapacityWarning] = useState(false);
  const selectedRoom = rooms.find((room) => room.id === form.roomId);
  const newPlace = form.active && (!child?.active || child.roomId !== form.roomId);
  const proposedCount = (selectedRoom?.assignedChildCount || 0) + (newPlace ? 1 : 0);
  const capacityWarning = serverCapacityWarning || !!(selectedRoom && newPlace && selectedRoom.capacity !== null && proposedCount > selectedRoom.capacity);
  const invalidRoom = !!form.roomId && (!selectedRoom || newPlace && !selectedRoom.active);
  const today = new Date().toISOString().slice(0, 10);
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setFields({}); setError(''); setConfirmDuplicate(false); setConfirmCapacity(false);
    if (key === 'firstName' || key === 'lastName') setDuplicates([]);
    if (key === 'roomId' || key === 'active') setServerCapacityWarning(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const invalid: Record<string, string> = {};
    for (const key of ['firstName', 'lastName'] as const) {
      if (!form[key].trim() || form[key].trim().length > 100) invalid[key] = 'Enter a name between 1 and 100 characters.';
    }
    const dob = new Date(form.dateOfBirth + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dateOfBirth) || !Number.isFinite(dob.getTime()) || dob.toISOString().slice(0, 10) !== form.dateOfBirth || form.dateOfBirth < '1900-01-01' || form.dateOfBirth > today) {
      invalid.dateOfBirth = 'Enter a real date of birth from 1900 through today.';
    }
    if (form.preferredName.trim().length > 100) invalid.preferredName = 'Use at most 100 characters.';
    if (form.notes.trim().length > 2000) invalid.notes = 'Use at most 2000 characters.';
    if (invalidRoom) invalid.roomId = 'Choose an active room or leave this child unassigned.';
    setFields(invalid);
    if (Object.keys(invalid).length) { setError('Correct the highlighted child details.'); return; }
    if (loadingRooms || duplicates.length && !confirmDuplicate || capacityWarning && !confirmCapacity) return;
    setBusy(true); setError('');
    const values: ChildSettings = { ...form, firstName: form.firstName.trim(), lastName: form.lastName.trim(),
      preferredName: form.preferredName.trim(), notes: form.notes.trim(), roomId: form.roomId || null };
    try { onSaved(await saveChild(child?.id || null, { ...values, confirmDuplicate, confirmOverCapacity: confirmCapacity })); }
    catch (failure) {
      if (!axios.isCancel(failure)) {
        setError(authError(failure, 'Could not save this child.'));
        if (axios.isAxiosError(failure)) {
          const details = failure.response?.data?.error;
          setFields(details?.fields || {});
          if (details?.code === 'CHILD_DUPLICATE_WARNING') { setDuplicates(details.duplicates || []); setConfirmDuplicate(false); }
          if (details?.code === 'ROOM_CAPACITY_WARNING') { setServerCapacityWarning(true); setConfirmCapacity(false); }
        }
      }
    } finally { setBusy(false); }
  }
  const fieldError = (key: string) => fields[key] && <p id={'child-error-' + key} className="mt-1 text-sm text-red-700">{fields[key]}</p>;
  return <form onSubmit={(event) => void submit(event)} noValidate className="rounded-2xl border bg-white p-6 shadow-sm" aria-label={child ? 'Edit child' : 'Add child'}>
    <fieldset disabled={busy} className="space-y-4">
      <h2 className="text-xl font-bold">{child ? 'Edit ' + childName(child) : 'Add child'}</h2>
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {([['firstName', 'First name'], ['lastName', 'Last name'], ['preferredName', 'Preferred name (optional)']] as const).map(([key, label]) =>
          <label key={key}>{label}<input required={key !== 'preferredName'} maxLength={100} value={form[key]} onChange={(event) => change(key, event.target.value)}
            aria-invalid={!!fields[key]} aria-describedby={fields[key] ? 'child-error-' + key : undefined} className={inputClass} />{fieldError(key)}</label>)}
        <label>Date of birth<input required type="date" min="1900-01-01" max={today} value={form.dateOfBirth} onChange={(event) => change('dateOfBirth', event.target.value)}
          aria-invalid={!!fields.dateOfBirth} aria-describedby={fields.dateOfBirth ? 'child-error-dateOfBirth' : undefined} className={inputClass} />{fieldError('dateOfBirth')}</label>
      </div>
      <label className="block">Room<RoomSelect rooms={rooms} value={form.roomId} emptyLabel="Unassigned" disabled={loadingRooms}
        onChange={(id) => change('roomId', id)} aria-invalid={!!fields.roomId} className={inputClass} />{fieldError('roomId')}</label>
      {loadingRooms && <p>Loading rooms…</p>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={form.active} onChange={(event) => change('active', event.target.checked)} />Active enrollment</label>
      {child?.active && !form.active && <p className="rounded bg-amber-50 p-3">Saving ends enrollment. The child leaves active rosters; their profile and attendance history remain.</p>}
      {!child?.active && child && form.active && <p className="text-sm text-slate-600">Reactivation checks the room's current availability and capacity.</p>}
      <label className="block">Operational notes (optional)<textarea rows={3} maxLength={2000} value={form.notes} onChange={(event) => change('notes', event.target.value)}
        aria-invalid={!!fields.notes} className={inputClass} />{fieldError('notes')}</label>
      {duplicates.length > 0 && <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="font-semibold">Review possible duplicate records</p>
        <ul className="list-disc pl-5">{duplicates.map((match) => <li key={match.id}>{childName(match)} · Born {match.dateOfBirth || 'not recorded'} · {match.active ? 'Active' : 'Inactive'}</li>)}</ul>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmDuplicate} onChange={(event) => setConfirmDuplicate(event.target.checked)} className="mt-1" />I reviewed the matching records and want to save this child.</label>
      </div>}
      {capacityWarning && <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="font-semibold">This enrollment exceeds the room capacity.</p>
        {selectedRoom && <p>Current displayed count: {selectedRoom.assignedChildCount}. Proposed count: {proposedCount}. Capacity: {selectedRoom.capacity}.</p>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmCapacity} onChange={(event) => setConfirmCapacity(event.target.checked)} className="mt-1" />I acknowledge the capacity warning and want to continue.</label>
      </div>}
      <div className="flex gap-3"><button disabled={loadingRooms || !!duplicates.length && !confirmDuplicate || capacityWarning && !confirmCapacity} className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save child'}</button>
        <button type="button" onClick={onCancel} className="rounded-lg border px-4 py-2">Cancel</button></div>
    </fieldset>
  </form>;
}
