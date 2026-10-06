import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { clockTime, dayLabel, legacyLabel, timeMinutes } from '../../api/activities';
import type { Activity, Entry } from '../../api/activities';
import type { Room } from '../../api/rooms';
import { ActivityForm } from './ActivityForm';

export type ActivityComposerValues = { activity: Activity; startTime: string | null; endTime: string | null; timeBlock: string | null };
type Props = { date: string; choices: Activity[]; catalogCount: number; entry?: Entry; suggestedStart: string; room?: Room; disabled: boolean;
  onApply: (values: ActivityComposerValues) => void; onCancel: () => void; onCatalogSaved: (activity: Activity) => void;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void };
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
const input = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2.5';

export function ActivityComposer({ date, choices, catalogCount, entry, suggestedStart, room, disabled, onApply, onCancel, onCatalogSaved, onDirtyChange, onBusyChange }: Props) {
  const formId = useId();
  // A saved entry owns its snapshot. Refreshing the library must not replace it.
  const [initial] = useState(() => ({ activity: entry?.activity || null, startTime: entry ? entry.startTime || '' : suggestedStart,
    endTime: entry?.endTime || '', timeBlock: entry?.timeBlock || null }));
  const [selected, setSelected] = useState<Activity | null>(initial.activity);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [timeBlock, setTimeBlock] = useState(initial.timeBlock);
  const [query, setQuery] = useState('');
  const [choosing, setChoosing] = useState(!initial.activity);
  const [creating, setCreating] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const dirty = createDirty || !!query || selected !== initial.activity || startTime !== initial.startTime || endTime !== initial.endTime || timeBlock !== initial.timeBlock;
  const blocked = disabled || catalogBusy;
  const matches = choices.filter((activity) => activity.name.toLowerCase().includes(query.trim().toLowerCase()));
  useLayoutEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => {
    if (!creating) (choosing ? searchRef : startRef).current?.focus();
  }, [choosing, creating]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const fieldProps = (key: string) => ({ id: formId + '-' + key, 'aria-invalid': !!fields[key],
    'aria-describedby': fields[key] ? formId + '-error-' + key : undefined });
  const fieldError = (key: string) => fields[key] && <p id={formId + '-error-' + key} className="mt-1 text-sm text-red-700">{fields[key]}</p>;
  function choose(activity: Activity, fromCatalog = false) {
    if (blocked && !fromCatalog) return;
    const snapshot = initial.activity?.id === activity.id ? initial.activity : activity;
    setSelected(snapshot); setChoosing(false); setFields({}); setConfirmCancel(false);
    if (snapshot !== selected && startTime && clock.test(startTime)) setEndTime(clockTime(Math.min(timeMinutes(startTime) + (snapshot.durationMinutes || 20), 1440)));
  }
  function changeStart(value: string) {
    if (blocked) return;
    const duration = startTime && endTime && endTime > startTime ? timeMinutes(endTime) - timeMinutes(startTime) : selected?.durationMinutes || 20;
    setStartTime(value); setTimeBlock(null); setConfirmCancel(false);
    if (value && clock.test(value)) setEndTime(clockTime(Math.min(timeMinutes(value) + duration, 1440)));
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (blocked || !selected) return;
    const invalid: Record<string, string> = {};
    if (!(timeBlock && !startTime && !endTime)) {
      if (!clock.test(startTime)) invalid.start = 'Enter a start time.';
      if (!clock.test(endTime) && endTime !== '24:00') invalid.end = 'Enter an end time.';
      else if (clock.test(startTime) && endTime <= startTime) invalid.end = 'End time must be after start time.';
    }
    setFields(invalid);
    if (Object.keys(invalid).length) return;
    onApply({ activity: selected, startTime: startTime || null, endTime: endTime || null, timeBlock });
  }
  function cancel() {
    if (blocked) return;
    if (dirty) setConfirmCancel(true); else onCancel();
  }
  function catalogSaving(busy: boolean) { setCatalogBusy(busy); onBusyChange(busy); }
  function catalogSaved(activity: Activity) {
    onCatalogSaved(activity);
    setCreating(false); setCreateDirty(false); choose(activity, true);
  }
  return <section className="ska-activity-composer rounded-2xl border border-violet-200 bg-white p-5 shadow-sm print:hidden" aria-label={entry ? 'Edit scheduled activity' : 'Add scheduled activity'}>
    {!creating ? <form noValidate aria-label={entry ? 'Edit scheduled activity' : 'Schedule activity'} onSubmit={submit}>
      <h2 className="text-xl font-bold text-slate-900">{entry ? 'Edit activity on ' : 'Add activity to '}{dayLabel(date)}</h2>
      <p className="mt-1 text-sm text-slate-600">{entry ? 'Apply your changes, then save the week.' : 'Choose an activity, check its time, and add it to the day. Save the week when you are ready.'}</p>
      <fieldset disabled={blocked} className="mt-4 space-y-4">
        {choosing ? <>
          <label className="block" htmlFor={formId + '-search'}>Search saved activities</label>
          <input ref={searchRef} id={formId + '-search'} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setConfirmCancel(false); }} className={input} />
          {matches.length ? <div className="grid gap-2 sm:grid-cols-2">{matches.map((activity) => <button type="button" key={activity.id} aria-label={'Choose ' + activity.name}
            onClick={() => choose(activity)} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-left hover:border-violet-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600">
            <span className="block font-semibold text-slate-900">{activity.name}</span><span className="mt-1 block text-sm text-slate-600">{activity.durationMinutes || 20} minutes</span>
          </button>)}</div> : <p className="rounded-xl bg-slate-50 p-3 text-slate-600">{query.trim() ? 'No saved activities match your search. Try another name or create an activity.' : catalogCount ? 'No saved activities fit this room’s ages or room assignment. Create an activity for this room.' : 'No saved activities yet. Create your first activity below.'}</p>}
          <button type="button" onClick={() => { setCreating(true); setConfirmCancel(false); }} className="rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 font-semibold text-violet-900">Create an activity</button>
        </> : selected && <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-violet-50 p-3">
            <p className="font-semibold text-violet-950">{selected.name}</p><button type="button" onClick={() => { setChoosing(true); setConfirmCancel(false); }} className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold">Change activity</button>
          </div>
          {timeBlock && !startTime && !endTime && <p className="text-sm text-slate-600">Time not set · {legacyLabel(timeBlock)}. Keep the earlier timing, or enter a start and end time.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label htmlFor={formId + '-start'}>Start time</label><input ref={startRef} {...fieldProps('start')} type="time" value={startTime} onChange={(event) => changeStart(event.target.value)} className={input} />{fieldError('start')}</div>
            <div><label htmlFor={formId + '-end'}>End time</label><input {...fieldProps('end')} type="time" value={endTime === '24:00' ? '00:00' : endTime} onChange={(event) => { setEndTime(event.target.value === '00:00' ? '24:00' : event.target.value); setTimeBlock(null); setConfirmCancel(false); }} className={input} />{fieldError('end')}</div>
          </div>
          <p className="text-sm text-slate-600">End time at midnight means the end of this day.</p>
        </>}
        <div className="flex flex-wrap gap-3">{selected && !choosing && <button type="submit" className="rounded-lg bg-violet-700 px-5 py-2.5 font-semibold text-white">{entry ? 'Apply changes' : 'Add to day'}</button>}
          <button type="button" onClick={cancel} className="rounded-lg border bg-white px-4 py-2">Cancel</button></div>
        {confirmCancel && <div role="group" aria-label="Discard scheduled activity changes" className="rounded-lg bg-amber-50 p-3">
          <p>Discard the changes in this activity editor? Your week stays as it is.</p><div className="mt-2 flex flex-wrap gap-3">
            <button type="button" onClick={onCancel} className="rounded-lg bg-red-700 px-4 py-2 font-semibold text-white">Discard changes</button>
            <button type="button" onClick={() => setConfirmCancel(false)} className="rounded-lg border bg-white px-4 py-2">Keep editing</button>
          </div>
        </div>}
      </fieldset>
    </form> : <ActivityForm activity={null} room={room} scheduleDate={date} disabled={disabled}
      submitLabel="Save activity & choose time" helpText="Save this activity to your library first. Next, check the time and add it to the day. Save week separately to keep your schedule."
      onDirtyChange={setCreateDirty} onBusyChange={catalogSaving} onSaved={catalogSaved} onClose={() => { setCreating(false); setCreateDirty(false); }} />}
  </section>;
}
