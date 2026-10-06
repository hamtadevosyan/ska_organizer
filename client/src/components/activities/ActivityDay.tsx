import { BookOpen, Clock3, Pencil, Trash2 } from 'lucide-react';
import { dayLabel, entryProblem, legacyLabel, materialUnitLabel, suitable, timeRange } from '../../api/activities';
import type { Activity, Entry } from '../../api/activities';
import type { Room } from '../../api/rooms';

type Props = { date: string; entries: Entry[]; catalog: Activity[]; room?: Room; disabledReason: string; editable: boolean;
  editEntry: (entry: Entry, trigger: HTMLButtonElement) => void; removeEntry: (id: string) => void; chooseActivity: (id: string, activityId: string, updateOnly?: boolean) => void };

export function ActivityDay({ date, entries, catalog, room, disabledReason, editable, editEntry, removeEntry, chooseActivity }: Props) {
  const day = dayLabel(date);
  const locked = !!disabledReason;
  return <section aria-label={day} className="planner-day">
    <div className="planner-day-heading"><h2>{day}<span>{new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span></h2>
      <span className="planner-count">{entries.length} {entries.length === 1 ? 'activity' : 'activities'}</span></div>
    {!entries.length && <div className="planner-empty"><Clock3 size={28} aria-hidden="true" /><p>Nothing scheduled for this day.</p><span>{editable && !locked ? 'Use Add activity to start planning.' : 'Saved activities will appear here.'}</span></div>}
    <div className="planner-timeline">{entries.map((entry, index) => {
      const latest = catalog.find(activity => activity.id === entry.activityId);
      const overlaps = entry.startTime && entry.endTime && entries.some(other => other.id !== entry.id && other.startTime && other.endTime && entry.startTime! < other.endTime && entry.endTime! > other.startTime);
      return <fieldset key={entry.id} aria-label={day + ' activity ' + (index + 1)} className={'planner-entry tone-' + (index % 4)}>
        <div className="planner-entry-top"><p className="planner-time"><Clock3 size={16} aria-hidden="true" />{timeRange(entry)}</p>
          {editable && <div className="planner-entry-actions"><button type="button" aria-label={'Edit activity ' + (index + 1) + ' on ' + day} disabled={locked} onClick={event => editEntry(entry, event.currentTarget)} className="ska-button"><Pencil size={16} aria-hidden="true" />Edit</button>
            <button type="button" aria-label={'Remove activity ' + (index + 1) + ' on ' + day} disabled={locked} onClick={() => removeEntry(entry.id)} className="ska-button"><Trash2 size={16} aria-hidden="true" />Remove</button></div>}
        </div>
        <h3>{entry.activity?.name || 'Activity not chosen'}</h3>
        {entry.timeBlock && !entry.startTime && <p className="planner-entry-note">Time not set · {legacyLabel(entry.timeBlock)}. Your saved activity is kept; enter its times when ready.</p>}
        {entry.endTime === '24:00' && <p className="planner-entry-note">Ends at midnight, at the end of this day.</p>}
        {entryProblem(entry) && <p className="planner-entry-note is-warning">{entryProblem(entry)}</p>}
        {overlaps && <p className="planner-entry-note">Runs at the same time as another activity.</p>}
        {entry.activity && room && !suitable(entry.activity, room) && <p className="planner-entry-note is-warning">This saved activity does not match the room’s current ages or assignment. Its saved copy is kept.</p>}
        {(entry.activity?.description || !!entry.activity?.materials.length) && <details className="planner-instructions"><summary><BookOpen size={16} aria-hidden="true" />Instructions &amp; materials</summary>
          {entry.activity.description && <p>{entry.activity.description}</p>}
          {!!entry.activity.materials.length && <ul>{entry.activity.materials.map(material => <li key={material.itemId}>{material.name || 'Inventory item'} — {material.quantity} {materialUnitLabel(material.unit)}{material.reusable ? ' · reusable' : ''}</li>)}</ul>}
        </details>}
        {entry.activity && latest && latest.version !== entry.activity.version && <div className="planner-version"><p>A newer library version is available. This entry keeps its saved copy.</p>
          {editable && <button className="ska-button" disabled={locked || !room || !suitable(latest, room)} onClick={() => chooseActivity(entry.id, latest.id, true)}>Use updated activity</button>}</div>}
      </fieldset>;
    })}</div>
  </section>;
}
