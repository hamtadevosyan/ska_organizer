import { useMemo, useState } from 'react';
import AppModal from '../AppModal';
import { dayLabel, timeRange } from '../../api/activities';
import type { ActivityPlan, Entry } from '../../api/activities';
import { countOverlaps, moveEntry } from './planReuse';
import { PlanActionPreview } from './PlanActionPreview';

type Props = { plan: ActivityPlan; entry: Entry; entries: Entry[]; dates: string[]; roomName: string; onApply: (entries: Entry[]) => void; onCancel: () => void };
export function ActivityMove({ plan, entry, entries, dates, roomName, onApply, onCancel }: Props) {
  const [destination, setDestination] = useState(dates[(dates.indexOf(entry.date) + 1) % dates.length]);
  const next = useMemo(() => moveEntry(entries, entry.id, destination), [entries, entry.id, destination]);
  return <AppModal id="planner-move" title="Move activity" initialFocusId="planner-move-day" onDismiss={onCancel}>
    <div className="planner-reuse"><p><strong>{entry.activity?.name}</strong> · {timeRange(entry)}</p>
      <p>In {roomName}, move from {dayLabel(entry.date)} {entry.date}. The activity, instructions, materials and times stay the same.</p>
      <label className="ska-field">Destination day<select id="planner-move-day" value={destination} onChange={event => setDestination(event.target.value)}>{dates.map(date => <option value={date} key={date}>{dayLabel(date)} {date}</option>)}</select></label>
      <p>To {dayLabel(destination)} {destination}. {entries.filter(value => value.date === destination && value.id !== entry.id).length} existing activities there will be kept.</p>
      {countOverlaps(next) > 0 && <p className="planner-entry-note">Some activities overlap in time. Review their times in the draft.</p>}
      <PlanActionPreview plan={plan} entries={next} disabled={destination === entry.date} actionLabel="Move in draft" onApply={() => onApply(next)} />
      <button type="button" className="ska-button" onClick={onCancel}>Cancel</button>
    </div>
  </AppModal>;
}
