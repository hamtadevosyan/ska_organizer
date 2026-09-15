import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Plus, Users } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { getStaff, saveStaff } from '../api/staff';
import type { StaffDetails, StaffFilters, StaffMember } from '../api/staff';
import { useRooms } from '../components/rooms/useRooms';
import { RoomSelect } from '../components/rooms/RoomSelect';
import { useStaff } from '../components/staff/useStaff';

const empty: StaffDetails = { name: '', role: '', active: true, roomId: null };
const initialFilters: StaffFilters = { q: '', active: 'true', roomId: '', page: 1 };
const inputClass = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2.5';
const buttonClass = 'rounded-lg border bg-white px-4 py-2 disabled:opacity-50';

export default function Staff() {
  const { account } = useAuth();
  const admin = account?.role === 'admin';
  const roomState = useRooms();
  const [filters, setFilters] = useState(initialFilters);
  const [search, setSearch] = useState('');
  const { data, loading, error: loadError, refresh } = useStaff(filters);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  useEffect(() => {
    if (!loading && data && data.page === filters.page && filters.page > pages) {
      setFilters((current) => ({ ...current, page: pages }));
    }
  }, [loading, data, filters.page, pages]);

  function close() { setFormOpen(false); setEditing(null); setError(''); setFields({}); setConflict(false); }
  function open(person: StaffMember | null) {
    setEditing(person);
    setForm(person ? { name: person.name, role: person.role, active: person.active, roomId: person.roomId } : empty);
    setFormOpen(true); setFields({}); setError(''); setMessage(''); setConflict(false);
  }
  function failureMessage(failure: unknown) {
    if (axios.isCancel(failure)) return;
    setError(authError(failure, 'Could not save staff details. Your changes have been kept in the form.'));
    if (axios.isAxiosError(failure)) {
      setFields(failure.response?.data?.error?.fields || {});
      setConflict(failure.response?.data?.error?.code === 'STAFF_CONFLICT');
    }
  }
  function startSaving() { if (saving.current) return false; saving.current = true; setBusy(true); return true; }
  function endSaving() { saving.current = false; setBusy(false); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    const invalid: Record<string, string> = {};
    for (const key of ['name', 'role'] as const) {
      if (!form[key].trim() || form[key].trim().length > 100) invalid[key] = 'Enter ' + (key === 'name' ? 'a name' : 'a job role') + ' between 1 and 100 characters.';
    }
    const room = roomState.rooms.find((item) => item.id === form.roomId);
    const newAssignment = form.roomId && (form.roomId !== editing?.roomId || form.active && !editing?.active);
    if (newAssignment && (!room?.active || room.needsConfiguration)) invalid.roomId = 'Choose an active, configured room or leave this person unassigned.';
    setFields(invalid);
    if (Object.keys(invalid).length) { setError('Correct the highlighted staff details.'); return; }
    if (editing?.active && !form.active && !window.confirm('Deactivate ' + editing.name + '? Their record and room assignment will remain available.')) return;
    if (!startSaving()) return;
    setError(''); setMessage('');
    try {
      await saveStaff(editing, { ...form, name: form.name.trim(), role: form.role.trim() });
      close(); setMessage(editing ? 'Staff record updated. Check the status and room filters if it is no longer shown.' : 'Staff record created.');
      await refresh();
    } catch (failure) { failureMessage(failure); }
    finally { endSaving(); }
  }
  async function deactivate(person: StaffMember) {
    if (saving.current || !window.confirm('Deactivate ' + person.name + '? Their record and room assignment will remain available.')) return;
    if (!startSaving()) return;
    setError(''); setMessage('');
    try {
      await saveStaff(person, { active: false });
      setMessage(person.name + ' deactivated. Select Inactive or All statuses to view the preserved record.');
      await refresh();
    } catch (failure) {
      // A stale row opens its existing details; the user explicitly chooses when to reload.
      open(person); failureMessage(failure);
    } finally { endSaving(); }
  }
  async function reloadRecord() {
    if (!editing || saving.current || !window.confirm('Replace your unsaved edits with the latest staff details?')) return;
    if (!startSaving()) return;
    try {
      open(await getStaff(editing.id));
      setMessage('Latest staff details loaded. Review them before saving.');
      await Promise.all([refresh(), roomState.refresh()]);
    } catch (failure) { failureMessage(failure); }
    finally { endSaving(); }
  }
  function applyFilters(next: Partial<StaffFilters>) { setFilters((current) => ({ ...current, ...next, page: 1 })); }
  const fieldError = (name: string) => fields[name] && <p id={'staff-error-' + name} className="mt-1 text-sm text-red-700">{fields[name]}</p>;
  const assignedRoom = roomState.rooms.find((room) => room.id === form.roomId);

  return <div className="mx-auto max-w-6xl space-y-6 p-2 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-3xl font-bold text-slate-900">Staff</h1><p className="mt-2 text-slate-600">Keep staff details and room assignments up to date.</p></div>
      <div className="flex gap-3">
        <button disabled={busy || loading || roomState.loading} onClick={() => void Promise.all([refresh(), roomState.refresh()])} className={buttonClass}>Refresh staff</button>
        {admin && <button disabled={busy || formOpen} onClick={() => open(null)} className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50"><Plus size={18} />Add staff</button>}
      </div>
    </header>
    <p className="text-sm text-slate-600">Staff records do not provide app access. An administrator manages sign-in accounts separately in Accounts.</p>
    {loadError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{loadError}</p>}
    {roomState.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{roomState.error} Use Refresh staff to reload room choices.</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{message}</p>}

    {admin && formOpen && <form aria-label="Staff details" onSubmit={(event) => void submit(event)} noValidate className="rounded-2xl border bg-white p-6 shadow-sm">
      <fieldset disabled={busy} className="space-y-4"><h2 className="text-xl font-bold">{editing ? 'Edit staff' : 'Create staff record'}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {([['name', 'Full name'], ['role', 'Job role']] as const).map(([key, label]) => <label key={key} className="block">{label}
            <input required maxLength={100} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              aria-invalid={!!fields[key]} aria-describedby={fields[key] ? 'staff-error-' + key : undefined} className={inputClass} />{fieldError(key)}
          </label>)}
        </div>
        <label className="block">Assigned room (optional)
          <RoomSelect rooms={roomState.rooms} value={form.roomId || ''} onChange={(roomId) => setForm({ ...form, roomId: roomId || null })}
            emptyLabel="Unassigned" disabled={roomState.loading || !!roomState.error} aria-invalid={!!fields.roomId}
            aria-describedby={fields.roomId ? 'staff-error-roomId' : undefined} className={inputClass} />{fieldError('roomId')}
        </label>
        {assignedRoom && !assignedRoom.active && <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">This room is archived. Its existing assignment is preserved. To reactivate an inactive staff member, select an active room or Unassigned.</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />Active staff member</label>
        {!form.active && <p className="text-sm text-slate-600">Inactive staff remain in the directory and are excluded from the active-staff total.</p>}
        <div className="flex flex-wrap gap-3">
          <button disabled={roomState.loading || !!roomState.error || conflict} className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Save staff</button>
          <button type="button" onClick={close} className={buttonClass}>Cancel</button>
          {conflict && editing && <button type="button" onClick={() => void reloadRecord()} className={buttonClass}>Reload staff record</button>}
        </div>
      </fieldset>
    </form>}

    <form role="search" aria-label="Filter staff" onSubmit={(event) => { event.preventDefault(); applyFilters({ q: search.trim() }); }} className="rounded-2xl border bg-white p-4">
      <fieldset disabled={busy} className="flex flex-wrap items-end gap-4">
        <label className="min-w-48 flex-1">Search staff<input type="search" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name" className={inputClass} /></label>
        <button className={buttonClass}>Search</button>
        <label>Status<select value={filters.active} onChange={(event) => applyFilters({ active: event.target.value as StaffFilters['active'] })} className={inputClass}>
          <option value="true">Active</option><option value="false">Inactive</option><option value="all">All statuses</option>
        </select></label>
        <label>Filter by room<select value={filters.roomId} onChange={(event) => applyFilters({ roomId: event.target.value })} disabled={roomState.loading || !!roomState.error} className={inputClass}>
          <option value="">All rooms</option><option value="unassigned">Unassigned</option>
          {roomState.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}{room.active ? '' : ' (archived)'}</option>)}
        </select></label>
        <button type="button" onClick={() => { setFilters(initialFilters); setSearch(''); }} className={buttonClass}>Reset filters</button>
      </fieldset>
    </form>
    {loading && <p role="status">Loading staff…</p>}
    {!loading && data && <>
      <p role="status" className="text-sm text-slate-600">{data.activeTotal} active staff across all rooms · {data.total} matching {data.total === 1 ? 'record' : 'records'}</p>
      {!data.items.length ? <div className="rounded-2xl border border-dashed bg-white p-10 text-center">
        <Users className="mx-auto mb-3 text-emerald-700" size={32} /><p className="font-semibold">No staff match these filters.</p>
        <p className="mt-2 text-slate-600">Try All statuses or reset the filters.{admin ? ' Use Add staff to create a record.' : ''}</p>
      </div> : <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-left"><caption className="sr-only">Staff directory</caption>
          <thead className="bg-slate-50 text-sm text-slate-600"><tr><th scope="col" className="p-4">Name</th><th scope="col" className="p-4">Job role</th><th scope="col" className="p-4">Room</th><th scope="col" className="p-4">Status</th>{admin && <th scope="col" className="p-4">Actions</th>}</tr></thead>
          <tbody>{data.items.map((person) => <tr key={person.id} className="border-t">
            <th scope="row" className="p-4 font-semibold">{person.name}</th><td className="p-4">{person.role}</td>
            <td className="p-4">{person.room ? person.room.name + (person.room.active ? '' : ' (archived)') : person.roomId ? 'Room unavailable' : 'Unassigned'}</td>
            <td className="p-4"><span className={'rounded-full px-3 py-1 text-xs font-semibold ' + (person.active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600')}>{person.active ? 'Active' : 'Inactive'}</span></td>
            {admin && <td className="p-4"><div className="flex gap-4"><button disabled={busy || formOpen} aria-label={'Edit ' + person.name} onClick={() => open(person)} className="font-semibold text-emerald-800 disabled:opacity-50">Edit</button>
              {person.active && <button disabled={busy || formOpen} aria-label={'Deactivate ' + person.name} onClick={() => void deactivate(person)} className="text-slate-600 disabled:opacity-50">Deactivate</button>}</div></td>}
          </tr>)}</tbody>
        </table>
      </div>}
      {pages > 1 && <nav aria-label="Staff pages" className="flex items-center justify-between gap-3">
        <button disabled={busy || filters.page === 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })} className={buttonClass}>Previous page</button>
        <span>Page {filters.page} of {pages}</span>
        <button disabled={busy || filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })} className={buttonClass}>Next page</button>
      </nav>}
    </>}
  </div>;
}
