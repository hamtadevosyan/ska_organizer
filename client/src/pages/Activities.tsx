import { useRef, useState } from 'react';
import { useAuth } from '../auth/context';
import { RoomSelect } from '../components/rooms/RoomSelect';
import { useRooms } from '../components/rooms/useRooms';
import { useActivityPlanner } from '../components/activities/useActivityPlanner';
import { ActivityForm } from '../components/activities/ActivityForm';
import { ActivityDay } from '../components/activities/ActivityDay';
import { ActivityPrint } from '../components/activities/ActivityPrint';
import { dayLabel, entryProblem, suitable, weekDates, materialUnitLabel } from '../api/activities';
import type { Activity } from '../api/activities';
import './activities.css';

const button = 'rounded-lg border bg-white px-4 py-2.5 font-semibold disabled:opacity-50';
export default function Activities() {
  const { account } = useAuth();
  const editable = account?.role === 'admin' || account?.role === 'editor';
  const rooms = useRooms();
  const planner = useActivityPlanner();
  const [form, setForm] = useState<{ activity: Activity | null; scheduleDate?: string } | null>(null);
  const [activitySaving, setActivitySaving] = useState(false);
  const activityNameRef = useRef<HTMLInputElement>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [search, setSearch] = useState('');
  const room = rooms.rooms.find((value) => value.id === planner.roomId);
  const ready = planner.plan && planner.plan.roomId === planner.roomId && planner.plan.weekStart === planner.weekStart;
  const allDates = ready ? weekDates(planner.weekStart) : [];
  const selectedDate = allDates[dayIndex];
  const incomplete = planner.entries.some(entryProblem);
  const choices = room ? planner.catalog.filter((activity) => suitable(activity, room)) : [];
  const disabledReason = !editable ? 'Your account can view and print schedules.'
    : !room ? 'Choose an available room before adding activities.'
    : !room.active ? 'This room is archived. Choose an active room to add activities.'
    : room.needsConfiguration ? 'Finish this room’s setup in Rooms & Classes before adding activities.'
    : planner.saving ? 'Saving the week. Please wait.'
    : activitySaving ? 'Saving the activity. Please wait.'
    : form?.activity ? 'Finish or cancel editing the activity above to continue.'
    : planner.catalogBusy ? 'Loading activities. Please wait.'
    : planner.catalogError ? 'Activities could not load. Select Refresh activities above.' : '';
  const locked = !!disabledReason;
  function addToDay(date: string) {
    if (locked) return;
    if (form) {
      setForm({ ...form, scheduleDate: date });
      activityNameRef.current?.focus();
      return;
    }
    if (choices.length) planner.addEntry(date);
    else setForm({ activity: null, scheduleDate: date });
  }
  function chooseDay(index: number) {
    if (planner.saving || activitySaving) return;
    setDayIndex(index);
    setForm((current) => current?.scheduleDate ? { ...current, scheduleDate: allDates[index] } : current);
  }
  return <div className="activity-planner mx-auto max-w-7xl space-y-5 p-3 sm:p-6">
    <div className="activity-screen space-y-5 print:hidden">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-3xl font-bold">Activity Planner</h1><p className="mt-1 text-slate-600">Plan the whole day, one activity at a time.</p></div>
        {editable && <button className={button} disabled={!!form || planner.saving} onClick={() => setForm({ activity: null })}>Add activity</button>}
      </header>
      {form && <ActivityForm activity={form.activity} room={room} scheduleDate={form.scheduleDate} nameInputRef={activityNameRef} onBusyChange={setActivitySaving} onClose={() => setForm(null)} onSaved={(activity) => { planner.activitySaved(activity); if (form.scheduleDate) planner.addEntry(form.scheduleDate, activity); setForm(null); }} />}
      <div className="flex flex-wrap items-end gap-4 rounded-2xl bg-white p-4 shadow-sm">
        <label className="min-w-48 flex-1">Room<RoomSelect rooms={rooms.rooms} value={planner.roomId} onChange={planner.chooseRoom} allowArchived disabled={rooms.loading || planner.saving || !!form} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <label>Week starting Monday<input type="date" value={planner.weekStart} min="1970-01-05" step="7" disabled={planner.saving || !!form} onChange={(e) => planner.chooseWeek(e.target.value)} className="mt-1 block rounded-lg border p-2.5" /></label>
        {editable && <button disabled={!ready || locked || !!form || incomplete || (!planner.dirty && !!planner.plan?.savedAt)} onClick={() => void planner.save()} className="rounded-lg bg-emerald-700 px-5 py-2.5 font-semibold text-white disabled:opacity-50">{planner.saving ? 'Saving…' : 'Save week'}</button>}
        <button className={button} disabled={!ready || planner.saving || !!form || !planner.entries.length || incomplete} onClick={() => window.print()}>Print</button>
      </div>
      {rooms.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{rooms.error} <button onClick={() => void rooms.refresh()} className="underline">Retry rooms</button></p>}
      {planner.catalogError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{planner.catalogError} <button onClick={planner.refreshCatalog} className="underline">Refresh activities</button></p>}
      {planner.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{planner.error} <button disabled={planner.saving || !!form} onClick={() => { planner.reloadWeek(); void rooms.refresh(); }} className="underline">Reload week</button></p>}
      {planner.notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-900">{planner.notice}</p>}
      {rooms.loading ? <p>Loading rooms…</p> : !planner.roomId && <p className="rounded-xl bg-white p-5">{rooms.rooms.length ? 'Choose a room to begin.' : 'No rooms yet. Add a room in Rooms & Classes first.'}</p>}
      {planner.busy && <p>Loading week…</p>}
      {ready && <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-semibold">{planner.dirty ? 'Unsaved changes' : planner.plan?.savedAt ? 'Saved week' : 'No schedule saved yet. Choose activities below.'}</p>
          <button className="text-sm underline" disabled={planner.saving || !!form} onClick={() => { planner.reloadWeek(); void rooms.refresh(); }}>Reload week</button>
        </div>
        {!room?.active && <p>This room is archived. Its saved activities are available to view and print.</p>}
        {room?.active && room.needsConfiguration && <p>Finish this room’s setup in Rooms & Classes before planning activities.</p>}
        {!locked && !form && !choices.length && <div className="rounded-xl bg-emerald-50 p-4">
          <p>{planner.catalog.length ? 'No saved activities match this room. Use Add to day to create one for this room.' : 'No activities yet. Use Add to day to create your first one.'}</p>
        </div>}
        {incomplete && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Finish the activity and times on {allDates.filter((date) => planner.entries.some((entry) => entry.date === date && entryProblem(entry))).map((date) => <button key={date} aria-label={"Finish " + dayLabel(date)} disabled={activitySaving || planner.saving} onClick={() => chooseDay(allDates.indexOf(date))} className="mx-1 font-semibold underline">{dayLabel(date)}</button>)} to save the week.</p>}
        <nav aria-label="Schedule day" className="flex flex-wrap gap-2">{allDates.map((date, index) => <button key={date} aria-label={dayLabel(date)} aria-pressed={dayIndex === index} disabled={activitySaving || planner.saving} onClick={() => chooseDay(index)} className={'rounded-lg border px-4 py-2.5 font-semibold ' + (dayIndex === index ? 'border-emerald-700 bg-emerald-700 text-white' : 'bg-white text-slate-700')}>
          {dayLabel(date)} <span className="ml-1 text-xs font-normal">{planner.entries.filter((entry) => entry.date === date).length}</span>
        </button>)}</nav>
        <ActivityDay key={selectedDate} date={selectedDate} entries={planner.entries.filter((entry) => entry.date === selectedDate)} choices={choices} catalog={planner.catalog} room={room} disabledReason={disabledReason} editable={editable} addingActivity={!!form && !form.activity}
          addEntry={addToDay} removeEntry={planner.removeEntry} chooseActivity={planner.chooseActivity} changeTime={planner.changeTime} />
        <details className="rounded-2xl border bg-white p-4" open={planner.materials.some((item) => item.shortage !== '0') || !!planner.previewError}>
          <summary className="cursor-pointer font-bold">Materials{planner.previewBusy ? ' — checking…' : planner.materials.some((item) => item.shortage !== '0') ? ' — some items needed' : ''}</summary>
          <p className="mt-3 text-sm text-slate-600">For this room and week. Uses current stock; planning does not use or reserve anything. Reusable items can be used again; activities at the same time need enough for both.</p>
          <button onClick={planner.checkMaterials} disabled={planner.previewBusy || planner.saving} className="my-3 text-sm underline">Check materials again</button>
          {incomplete ? <p>Finish choosing activities and times to check materials.</p> : planner.previewError ? <p role="alert" className="text-red-800">{planner.previewError}</p> : planner.previewBusy ? <p>Checking current stock…</p> : !planner.materials.length ? <p>No materials listed for these activities.</p> :
            <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Activity material availability</caption>
              <thead><tr><th className="p-2">Item</th><th className="p-2">Needed</th><th className="p-2">Available</th><th className="p-2">To get</th></tr></thead>
              <tbody>{planner.materials.map((item) => <tr key={item.itemId + materialUnitLabel(item.unit)} className="border-t"><th scope="row" className="p-2">{item.name}<span className="block font-normal text-slate-500">{item.location}</span>{item.issue && <span className="block text-red-700">{item.issue}</span>}</th>
                <td className="p-2">{item.needed} {materialUnitLabel(item.unit)}</td><td className="p-2">{item.issue ? 'Check item' : item.available + ' ' + materialUnitLabel(item.unit)}</td><td className="p-2 font-semibold">{item.shortage === '0' ? 'Ready' : item.shortage + ' ' + materialUnitLabel(item.unit)}</td></tr>)}</tbody>
            </table></div>}
        </details>
      </>}
      <details className="rounded-2xl border bg-white p-4">
        <summary className="cursor-pointer font-bold">Saved activities ({planner.catalog.length})</summary>
        <div className="mt-4 flex flex-wrap items-end gap-3"><label className="flex-1">Find an activity<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
          <button className={button} disabled={planner.catalogBusy || !!form || planner.saving} onClick={planner.refreshCatalog}>Refresh activities</button></div>
        {planner.catalogBusy ? <p className="mt-3">Loading activities…</p> : !planner.catalog.length ? <p className="mt-3">No activities yet.</p> :
          <ul className="mt-4 divide-y">{planner.catalog.filter((activity) => activity.name.toLowerCase().includes(search.toLowerCase())).map((activity) => <li key={activity.id} className="flex items-center justify-between gap-4 py-3">
            <div><p className="font-semibold">{activity.name}</p><p className="text-sm text-slate-600">{activity.durationMinutes ? activity.durationMinutes + ' min · ' : ''}{activity.ageMinMonths === null ? 'All ages' : activity.ageMinMonths + '–' + activity.ageMaxMonths + ' months'}</p></div>
            {editable && <button className="font-semibold text-emerald-800" disabled={!!form || planner.saving} aria-label={'Edit ' + activity.name} onClick={() => setForm({ activity })}>Edit</button>}
          </li>)}</ul>}
      </details>
    </div>
    {ready && <ActivityPrint roomName={room?.name || 'Room'} weekStart={planner.weekStart} dates={allDates} entries={planner.entries} draft={planner.dirty || !planner.plan?.savedAt} />}
  </div>;
}
