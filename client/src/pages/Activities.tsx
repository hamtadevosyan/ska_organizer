import { useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays, CheckCircle2, Library, Plus, Printer, Undo2 } from 'lucide-react';
import { useAuth } from '../auth/context';
import { RoomSelect } from '../components/rooms/RoomSelect';
import { useRooms } from '../components/rooms/useRooms';
import { useActivityPlanner } from '../components/activities/useActivityPlanner';
import { ActivityForm } from '../components/activities/ActivityForm';
import { ActivityComposer } from '../components/activities/ActivityComposer';
import { ActivityDay } from '../components/activities/ActivityDay';
import { ActivityPrint } from '../components/activities/ActivityPrint';
import { dayLabel, entryProblem, suitable, weekDates, materialUnitLabel } from '../api/activities';
import type { Activity, Entry } from '../api/activities';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import './activities.css';

export default function Activities() {
  const { account } = useAuth();
  const editable = account?.role === 'admin' || account?.role === 'editor';
  const rooms = useRooms();
  const planner = useActivityPlanner();
  const [catalogForm, setCatalogForm] = useState<{ activity: Activity | null } | null>(null);
  const [composer, setComposer] = useState<{ entry?: Entry } | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [composerDirty, setComposerDirty] = useState(false);
  const [activitySaving, setActivitySaving] = useState(false);
  const [dayIndex, setDayIndex] = useState(0);
  const [view, setView] = useState<'day' | 'week'>('day');
  const [search, setSearch] = useState('');
  const addRef = useRef<HTMLButtonElement>(null);
  const composerTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (composer || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = composerTrigger.current;
    (target?.isConnected && !target.disabled ? target : addRef.current)?.focus({ preventScroll: true });
  }, [composer]);
  const reportUnsaved = useUnsavedChanges();
  useLayoutEffect(() => {
    reportUnsaved(editable && (planner.dirty || formDirty || composerDirty), planner.saving || activitySaving);
    return () => reportUnsaved(false, false);
  }, [reportUnsaved, editable, planner.dirty, formDirty, composerDirty, planner.saving, activitySaving]);
  const room = rooms.rooms.find(value => value.id === planner.roomId);
  const ready = !!planner.plan && planner.plan.roomId === planner.roomId && planner.plan.weekStart === planner.weekStart;
  const allDates = ready ? weekDates(planner.weekStart) : [];
  const selectedDate = allDates[dayIndex];
  const incomplete = planner.entries.some(entryProblem);
  const choices = room ? planner.catalog.filter(activity => suitable(activity, room)) : [];
  const disabledReason = !editable ? 'Your account can view and print schedules.'
    : !room ? 'Choose a room before adding activities.'
    : !room.active ? 'This room is archived. Its saved week is available to view and print.'
    : room.needsConfiguration ? 'Finish this room’s setup in Rooms & Classes before adding activities.'
    : planner.saving ? 'Saving the week. Please wait.'
    : activitySaving ? 'Saving the activity. Please wait.'
    : planner.catalogBusy ? 'Loading activities. Please wait.'
    : planner.catalogError ? 'Activities could not load. Use Refresh activities to retry.' : '';
  const locked = !!disabledReason;
  const focusedForm = !!composer || !!catalogForm;
  function closeComposer() { restoreFocus.current = true; setComposer(null); setComposerDirty(false); }
  function closeCatalogForm() { setCatalogForm(null); setFormDirty(false); }
  function chooseDay(index: number) { if (!planner.saving && !activitySaving) setDayIndex(index); }
  function openEntry(entry: Entry, trigger: HTMLButtonElement) { if (!locked && !focusedForm) { composerTrigger.current = trigger; setComposer({ entry }); } }
  return <div className="activity-planner ska-page ska-core-page">
    <div className="activity-screen print:hidden">
      <header className="ska-page-head planner-page-head"><div><span className="ska-kicker"><span className="kicker-dot" />A little planning, a wonderful day</span>
        <h1><span className="ska-heading-icon is-purple"><CalendarDays size={24} aria-hidden="true" /></span>Activity Planner</h1><p>Choose a room and week. Build a day everyone can follow.</p></div></header>
      <section aria-label="Planner settings" className="planner-settings">
        <label className="ska-field">Room<RoomSelect rooms={rooms.rooms} value={planner.roomId} onChange={planner.chooseRoom} allowArchived disabled={rooms.loading || planner.saving || focusedForm} /></label>
        <label className="ska-field">Week starting Monday<input type="date" value={planner.weekStart} min="1970-01-05" step="7" disabled={planner.saving || focusedForm} onChange={event => planner.chooseWeek(event.target.value)} /></label>
        <div className="planner-save-actions">{editable && <button disabled={!ready || locked || focusedForm || incomplete || (!planner.dirty && !!planner.plan?.savedAt)} onClick={() => void planner.save()} className="ska-button is-primary"><CheckCircle2 size={18} aria-hidden="true" />{planner.saving ? 'Saving…' : 'Save week'}</button>}
          <button disabled={!ready || planner.saving || focusedForm || !planner.entries.length || incomplete} onClick={() => window.print()} className="ska-button"><Printer size={18} aria-hidden="true" />Print</button></div>
      </section>
      {(rooms.error || planner.catalogError || planner.error) && <div className="planner-errors">
        {rooms.error && <p role="alert" className="ska-alert is-error">{rooms.error} <button className="ska-button" onClick={() => void rooms.refresh()}>Retry rooms</button></p>}
        {planner.catalogError && <p role="alert" className="ska-alert is-error">{planner.catalogError} <button className="ska-button" onClick={planner.refreshCatalog}>Refresh activities</button></p>}
        {planner.error && <p role="alert" className="ska-alert is-error">{planner.error} <button className="ska-button" disabled={planner.saving || focusedForm} onClick={() => { planner.reloadWeek(); void rooms.refresh(); }}>Reload week</button></p>}
      </div>}
      {planner.notice && <p role="status" className="planner-notice">{planner.notice}</p>}
      {rooms.loading ? <p role="status" className="ska-loading">Loading rooms…</p> : !planner.roomId && <p className="planner-welcome">{rooms.rooms.length ? 'Choose a room to begin.' : 'No rooms yet. Add a room in Rooms & Classes first.'}</p>}
      {planner.busy && <p role="status" className="ska-loading">Loading week…</p>}
      {ready && <>
        <div className="planner-status-row"><p className={'planner-save-state ' + (planner.dirty ? 'is-draft' : 'is-saved')}><CheckCircle2 size={16} aria-hidden="true" />{planner.dirty ? 'Unsaved changes' : planner.plan?.savedAt ? 'Saved week' : 'No schedule saved yet'}</p>
          <button className="ska-link" disabled={planner.saving || focusedForm} onClick={() => { planner.reloadWeek(); void rooms.refresh(); }}>Reload week</button></div>
        {disabledReason && <p id="planner-disabled-reason" className="planner-help">{disabledReason}</p>}
        {focusedForm && <p className="planner-help">Room and calendar week stay fixed while this form is open. Day and week views keep your entered work.</p>}
        <div className="planner-browse"><div className="planner-view-switch" role="group" aria-label="Schedule view">
          <button aria-pressed={view === 'day'} disabled={planner.saving || activitySaving} onClick={() => setView('day')}>Day view</button>
          <button aria-pressed={view === 'week'} disabled={planner.saving || activitySaving} onClick={() => setView('week')}>Week view</button></div>
          {editable && <button ref={addRef} aria-describedby={disabledReason ? 'planner-disabled-reason' : undefined} disabled={locked || focusedForm} onClick={() => { composerTrigger.current = addRef.current; setComposer({}); }} className="ska-button is-primary"><Plus size={19} aria-hidden="true" />Add activity</button>}</div>
        <nav aria-label="Schedule day" className="planner-days">{allDates.map((date, index) => <button key={date} aria-label={dayLabel(date)} aria-pressed={dayIndex === index} disabled={planner.saving || activitySaving} onClick={() => chooseDay(index)}>
          <span>{dayLabel(date).slice(0, 3)}</span><strong>{new Date(date + 'T00:00:00Z').getUTCDate()}</strong><span className="planner-day-count">{planner.entries.filter(entry => entry.date === date).length} planned</span>
        </button>)}</nav>
        {composer && <ActivityComposer entry={composer.entry} date={composer.entry?.date || selectedDate} choices={choices} catalogCount={planner.catalog.length} suggestedStart={planner.suggestedTimes(composer.entry?.date || selectedDate).startTime!}
          room={room} disabled={planner.saving || activitySaving} onBusyChange={setActivitySaving} onDirtyChange={setComposerDirty} onCancel={closeComposer} onCatalogSaved={planner.activitySaved}
          onApply={values => { if (composer.entry) planner.updateEntry(composer.entry.id, values); else planner.addEntry(selectedDate, values.activity, values); closeComposer(); }} />}
        {incomplete && <p className="planner-help is-warning">Finish the activity and times on {allDates.filter(date => planner.entries.some(entry => entry.date === date && entryProblem(entry))).map(date => <button key={date} aria-label={'Finish ' + dayLabel(date)} disabled={activitySaving || planner.saving} onClick={() => { chooseDay(allDates.indexOf(date)); setView('day'); }} className="ska-link">{dayLabel(date)}</button>)} before saving.</p>}
        {planner.removedCount > 0 && <div className="planner-undo" role="status"><p>{planner.removedCount} {planner.removedCount === 1 ? 'entry removed' : 'entries removed'} from this draft. Library activities are kept.</p>
          <button disabled={locked || focusedForm} onClick={planner.undoRemoval} className="ska-button"><Undo2 size={17} aria-hidden="true" />Undo removal</button></div>}
        <div className={'planner-calendar is-' + view}>{(view === 'day' ? [selectedDate] : allDates).map(date => <div key={date} className="planner-calendar-day">
          {view === 'week' && <button className="ska-link planner-open-day" aria-label={'Open ' + dayLabel(date)} disabled={activitySaving || planner.saving} onClick={() => { chooseDay(allDates.indexOf(date)); setView('day'); }}>Open {dayLabel(date)}</button>}
          <ActivityDay date={date} entries={planner.entries.filter(entry => entry.date === date)} catalog={planner.catalog} room={room} disabledReason={focusedForm ? 'Finish or cancel the open form before editing another entry.' : disabledReason}
            editable={editable} editEntry={openEntry} removeEntry={planner.removeEntry} chooseActivity={planner.chooseActivity} />
        </div>)}</div>
        <details className="planner-materials" open={planner.materials.some(item => item.shortage !== '0') || !!planner.previewError}>
          <summary>Materials check{planner.previewBusy ? ' — checking…' : planner.materials.some(item => item.shortage !== '0') ? ' — some items needed' : ''}</summary>
          <p>For this room and week. Uses current stock; planning, saving and printing do not use or reserve anything. Reusable items can be used again; activities at the same time need enough for both.</p>
          <button onClick={planner.checkMaterials} disabled={planner.previewBusy || planner.saving} className="ska-button">Check materials again</button>
          {incomplete ? <p>Finish choosing activities and times to check materials.</p> : planner.previewError ? <p role="alert" className="ska-alert is-error">{planner.previewError}</p> : planner.previewBusy ? <p role="status">Checking current stock…</p> : !planner.materials.length ? <p>No materials listed for these activities.</p> :
            <div className="overflow-x-auto"><table role="table" className="ska-record-table w-full text-left text-sm"><caption className="sr-only">Activity material availability</caption>
              <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" className="p-2">Item</th><th role="columnheader" scope="col" className="p-2">Needed</th><th role="columnheader" scope="col" className="p-2">Available</th><th role="columnheader" scope="col" className="p-2">To get</th></tr></thead>
              <tbody role="rowgroup">{planner.materials.map(item => <tr role="row" key={item.itemId + materialUnitLabel(item.unit)} className="border-t"><th role="rowheader" scope="row" className="p-2">{item.name}<span className="block font-normal text-slate-500">{item.location}</span>{item.issue && <span className="block text-red-700">{item.issue}</span>}</th>
                <td role="cell" data-label="Needed" className="p-2">{item.needed} {materialUnitLabel(item.unit)}</td><td role="cell" data-label="Available" className="p-2">{item.issue ? 'Check item' : item.available + ' ' + materialUnitLabel(item.unit)}</td><td role="cell" data-label="To get" className="p-2 font-semibold">{item.shortage === '0' ? 'Ready' : item.shortage + ' ' + materialUnitLabel(item.unit)}</td></tr>)}</tbody>
            </table></div>}
        </details>
      </>}
      <details className="planner-library">
        <summary><Library size={18} aria-hidden="true" />Saved activities ({planner.catalog.length})<span>Library tools</span></summary>
        <p>Library changes save immediately. Adding an activity to a day changes the draft; Save week keeps that schedule.</p>
        <div className="planner-library-tools"><label className="ska-field">Find an activity<input type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} /></label>
          <button className="ska-button" disabled={planner.catalogBusy || focusedForm || planner.saving} onClick={planner.refreshCatalog}>Refresh library</button>
          {editable && <button className="ska-button" disabled={focusedForm || planner.saving} onClick={() => setCatalogForm({ activity: null })}>Create library activity</button>}</div>
        {catalogForm && <ActivityForm activity={catalogForm.activity} room={room} onDirtyChange={setFormDirty} onBusyChange={setActivitySaving} onClose={closeCatalogForm} onSaved={activity => { planner.activitySaved(activity); closeCatalogForm(); }} />}
        {planner.catalogBusy ? <p>Loading activities…</p> : !planner.catalog.length ? <p>No activities yet.</p> : <ul className="planner-library-list">{planner.catalog.filter(activity => activity.name.toLowerCase().includes(search.toLowerCase())).map(activity => <li key={activity.id}>
          <div><strong>{activity.name}</strong><p>{activity.durationMinutes ? activity.durationMinutes + ' min · ' : ''}{activity.ageMinMonths === null ? 'All ages' : activity.ageMinMonths + '–' + activity.ageMaxMonths + ' months'}</p></div>
          {editable && <button className="ska-button" disabled={focusedForm || planner.saving} aria-label={'Edit ' + activity.name} onClick={() => setCatalogForm({ activity })}>Edit</button>}
        </li>)}</ul>}
      </details>
    </div>
    {ready && <ActivityPrint roomName={room?.name || 'Room'} weekStart={planner.weekStart} dates={allDates} entries={planner.entries} draft={planner.dirty || !planner.plan?.savedAt} />}
  </div>;
}
