import { useId } from 'react';
import { dayLabel, entryProblem, legacyLabel, suitable } from '../../api/activities';
import type { Activity, Entry } from '../../api/activities';
import type { Room } from '../../api/rooms';

type Props = { date: string; entries: Entry[]; choices: Activity[]; catalog: Activity[]; room?: Room; disabledReason: string; editable: boolean; addingActivity: boolean;
  addEntry: (date: string) => void; removeEntry: (id: string) => void; chooseActivity: (id: string, activityId: string, updateOnly?: boolean) => void;
  changeTime: (id: string, field: 'startTime' | 'endTime', value: string) => void };
const input = 'mt-1 block w-full rounded-lg border bg-white p-2.5 font-normal disabled:bg-slate-50';
export function ActivityDay({ date, entries, choices, catalog, room, disabledReason, editable, addingActivity, addEntry, removeEntry, chooseActivity, changeTime }: Props) {
  const day = dayLabel(date);
  const helpId = useId();
  const locked = !!disabledReason;
  return <section aria-label={day} className="rounded-2xl border bg-white p-4 shadow-sm sm:p-5">
    <h2 className="text-xl font-bold text-emerald-800">{day} <span className="text-sm font-normal text-slate-500">{date.slice(5)}</span></h2>
    {!entries.length && <p className="my-5 text-slate-600">Nothing scheduled for this day.</p>}
    <div className="my-4 space-y-3">{entries.map((entry, index) => {
      const label = day + ' activity ' + (index + 1);
      const latest = catalog.find((activity) => activity.id === entry.activityId);
      const overlaps = entry.startTime && entry.endTime && entries.some((other) => other.id !== entry.id && other.startTime && other.endTime && entry.startTime! < other.endTime && entry.endTime! > other.startTime);
      return <fieldset key={entry.id} aria-label={label} className="rounded-xl border bg-slate-50 p-3">
        <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[8.5rem_8.5rem_minmax(0,1fr)_auto]">
          <label className="text-sm font-semibold">Start<input type="time" aria-label={label + ' start'} value={entry.startTime || ''} disabled={locked} onChange={(e) => changeTime(entry.id, 'startTime', e.target.value)} className={input} /></label>
          <label className="text-sm font-semibold">End<input type="time" aria-label={label + ' end'} value={entry.endTime === '24:00' ? '00:00' : entry.endTime || ''} disabled={locked} onChange={(e) => changeTime(entry.id, 'endTime', e.target.value)} className={input} /></label>
          <label className="col-span-2 text-sm font-semibold sm:col-span-1">Activity<select aria-label={label} value={entry.activityId} disabled={locked} autoFocus={!entry.activityId} onChange={(e) => chooseActivity(entry.id, e.target.value)} className={input}>
            <option value="">Choose activity</option>
            {entry.activity && !choices.some((activity) => activity.id === entry.activityId) && <option value={entry.activityId}>{entry.activity.name} (saved)</option>}
            {choices.map((activity) => <option key={activity.id} value={activity.id}>{entry.activityId === activity.id ? entry.activity?.name || activity.name : activity.name}</option>)}
          </select></label>
          {editable && <button type="button" aria-label={'Remove activity ' + (index + 1) + ' on ' + day} disabled={locked} onClick={() => removeEntry(entry.id)} className="w-fit rounded-lg px-2 py-2.5 text-sm text-slate-600 underline disabled:opacity-50">Remove</button>}
        </div>
        {entry.timeBlock && !entry.startTime && <p className="mt-2 text-sm text-amber-800">Time not set · {legacyLabel(entry.timeBlock)}. Your saved activity is kept; enter its times when ready.</p>}
        {entry.endTime === '24:00' && <p className="mt-2 text-sm text-slate-600">Ends at midnight, at the end of this day.</p>}
        {entryProblem(entry) && <p className="mt-2 text-sm text-slate-600">{entryProblem(entry)}</p>}
        {overlaps && <p className="mt-2 text-sm text-slate-600">Runs at the same time as another activity.</p>}
        {entry.activity?.description && <details className="mt-2 text-sm text-slate-600"><summary className="cursor-pointer">Instructions</summary><p className="mt-1 whitespace-pre-wrap">{entry.activity.description}</p></details>}
        {entry.activity && latest && latest.version !== entry.activity.version && <button className="mt-2 text-sm text-emerald-800 underline" disabled={locked || !room || !suitable(latest, room)} onClick={() => chooseActivity(entry.id, latest.id, true)}>Use updated activity</button>}
      </fieldset>;
    })}</div>
    {editable && <>
      <button aria-label={addingActivity ? 'Continue activity for ' + day : 'Add to ' + day} disabled={locked} aria-describedby={locked ? helpId : undefined} onClick={() => addEntry(date)} className="rounded-lg bg-emerald-700 px-4 py-2.5 font-semibold text-white disabled:opacity-50">{addingActivity ? 'Continue activity' : '+ Add to day'}</button>
      {locked && <p id={helpId} className="mt-2 text-sm text-slate-600">{disabledReason}</p>}
    </>}
  </section>;
}
