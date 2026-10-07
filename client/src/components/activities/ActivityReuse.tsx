import { useEffect, useState } from 'react';
import axios from 'axios';
import AppModal from '../AppModal';
import { authError } from '../../auth/transport';
import { activityPlanUrl, dayLabel, suitable, timeRange, weekDates, materialUnitLabel } from '../../api/activities';
import type { Activity, ActivityPlan, Entry } from '../../api/activities';
import type { Room } from '../../api/rooms';
import { assessReuse, copyDayEntries, copyWeekEntries, countOverlaps } from './planReuse';
import type { CopyResult } from './planReuse';
import { PlanActionPreview } from './PlanActionPreview';

type Props = { scope: 'day' | 'week'; destination: ActivityPlan; entries: Entry[]; room: Room; rooms: Room[]; catalog: Activity[];
  initialDate: string; onApply: (entries: Entry[]) => void; onCancel: () => void };
function previousWeek(date: string) { const value = new Date(date + 'T00:00:00Z'); value.setUTCDate(value.getUTCDate() - 7); return value.toISOString().slice(0, 10); }
function monday(date: string) { const value = new Date(date + 'T00:00:00Z'); return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(value.valueOf()) && value.toISOString().slice(0, 10) === date && value.getUTCDay() === 1 && date >= '1970-01-05'; }
const dateName = (date: string) => dayLabel(date) + ' ' + date;

export function ActivityReuse({ scope, destination, entries, room, rooms, catalog, initialDate, onApply, onCancel }: Props) {
  const [sourceRoom, setSourceRoom] = useState(room.id);
  const [sourceWeek, setSourceWeek] = useState(scope === 'week' ? previousWeek(destination.weekStart) : destination.weekStart);
  const [sourceDayIndex, setSourceDayIndex] = useState(0);
  const [destinationDay, setDestinationDay] = useState(initialDate);
  const [loaded, setLoaded] = useState<ActivityPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [candidate, setCandidate] = useState<CopyResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const source = loaded?.roomId === sourceRoom && loaded.weekStart === sourceWeek ? loaded : null;
  const sourceDates = monday(sourceWeek) ? weekDates(sourceWeek) : [];
  const destinationDates = weekDates(destination.weekStart);
  const sourceEntries = source?.entries.filter(entry => scope === 'week' || entry.date === sourceDates[sourceDayIndex]) || [];
  const included = sourceEntries.filter(entry => !excluded.includes(entry.id));
  const assessment = assessReuse(sourceEntries, room, catalog);
  const choices = catalog.filter(activity => suitable(activity, room));
  const blocked = included.some(entry => assessment.find(value => value.entryId === entry.id)?.blocked && !replacements[entry.id]);
  const replaced = candidate && mode === 'replace' ? entries.filter(entry => candidate.affectedDates.includes(entry.date)).length : 0;
  const sourceName = rooms.find(value => value.id === sourceRoom)?.name || 'Source room';
  function invalidate() { setCandidate(null); setConfirmed(false); }
  useEffect(() => {
    const controller = new AbortController(); setLoaded(null); setError(''); setExcluded([]); setReplacements({}); setCandidate(null); setConfirmed(false);
    if (!sourceRoom || !monday(sourceWeek)) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    void axios.get<{ data: ActivityPlan }>(activityPlanUrl, { params: { roomId: sourceRoom, weekStart: sourceWeek }, signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setLoaded(response.data.data); })
      .catch(failure => { if (!controller.signal.aborted) setError(authError(failure, 'Could not load the saved source week. Try Reload source week.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sourceRoom, sourceWeek, reload]);
  function preview() {
    if (!source || !source.savedAt || !included.length || blocked) return;
    const selectedSource = { ...source, entries: included };
    const result = scope === 'week' ? copyWeekEntries(selectedSource, entries, destination.weekStart, { mode })
      : copyDayEntries(selectedSource, sourceDates[sourceDayIndex], entries, destinationDay, { mode });
    // Replacement is an explicit current-library selection, not a changed saved source.
    const copied = result.copied.map(entry => {
      const replacementId = replacements[entry.copyFrom!.entryId];
      if (!replacementId) return entry;
      const activity = choices.find(value => value.id === replacementId)!;
      const { copyFrom: _source, ...values } = entry;
      void _source;
      return { ...values, activityId: activity.id, activity, useLatest: true };
    });
    const byId = new Map(copied.map(entry => [entry.id, entry]));
    setCandidate({ ...result, copied, entries: result.entries.map(entry => byId.get(entry.id) || entry) }); setConfirmed(false);
  }
  return <AppModal id="planner-copy" title={'Copy ' + scope} initialFocusId="planner-source-room" onDismiss={onCancel}>
    <div className="planner-reuse">
      <p>Reuse a saved {scope}. Review it first, then add it to your draft.</p>
      <div className="planner-reuse-settings"><label className="ska-field">Source room<select id="planner-source-room" value={sourceRoom} onChange={event => { invalidate(); setSourceRoom(event.target.value); }}>
        {rooms.map(value => <option key={value.id} value={value.id}>{value.name}{value.active ? '' : ' (archived)'}</option>)}</select></label>
        <label className="ska-field">Source week starting Monday<input type="date" value={sourceWeek} min="1970-01-05" step="7" onChange={event => { invalidate(); setSourceWeek(event.target.value); }} /></label>
        {scope === 'day' && <><label className="ska-field">Source day<select value={sourceDayIndex} onChange={event => { invalidate(); setSourceDayIndex(Number(event.target.value)); }}>{sourceDates.map((date, index) => <option value={index} key={date}>{dateName(date)}</option>)}</select></label>
          <label className="ska-field">Destination day<select value={destinationDay} onChange={event => { invalidate(); setDestinationDay(event.target.value); }}>{destinationDates.map(date => <option value={date} key={date}>{dateName(date)}</option>)}</select></label></>}
      </div>
      {!monday(sourceWeek) && <p role="alert">Choose a valid Monday for the source week.</p>}
      <button type="button" className="ska-button" disabled={loading || !monday(sourceWeek)} onClick={() => { invalidate(); setReload(value => value + 1); }}>Reload source week</button>
      {loading ? <p role="status">Loading saved activities…</p> : error ? <p role="alert" className="ska-alert is-error">{error}</p> : source && <>
        <p className="planner-copy-summary">From <strong>{sourceName}</strong>, {scope === 'day' ? dateName(sourceDates[sourceDayIndex]) : source.weekStart + ' through ' + sourceDates[6]}<br />
          To <strong>{room.name}</strong>, {scope === 'day' ? dateName(destinationDay) : destination.weekStart + ' through ' + destinationDates[6]}</p>
        {!source.savedAt || source.version < 1 ? <p>This source week has not been saved. Save it before copying.</p> : !sourceEntries.length ? <p>No saved activities in this {scope}. Your destination will stay unchanged.</p> : <>
          <p>{included.length} of {sourceEntries.length} saved activities selected. Saved names, instructions, materials and times are kept.</p>
          <div className="planner-reuse-list">{sourceEntries.map((entry, index) => {
            const check = assessment[index]; const include = !excluded.includes(entry.id);
            return <fieldset key={entry.id} className="planner-reuse-entry"><legend>Activity {index + 1}</legend>
              <label className="planner-reuse-check"><input type="checkbox" checked={include} aria-label={'Include ' + check.name + ' on ' + dateName(entry.date) + ' activity ' + (index + 1)} onChange={event => { invalidate(); setExcluded(values => event.target.checked ? values.filter(id => id !== entry.id) : [...values, entry.id]); }} /><strong>{check.name}</strong></label>
              <p>{dateName(entry.date)} · {timeRange(entry)}</p>
              {check.message && <p className={'planner-entry-note' + (check.blocked && !replacements[entry.id] ? ' is-warning' : '')}>{check.message}</p>}
              <details><summary>Saved instructions &amp; materials</summary><p>{entry.activity?.description || 'No instructions listed.'}</p>
                <ul>{entry.activity?.materials.map(material => <li key={material.itemId}>{material.name || 'Inventory item'} — {material.quantity} {materialUnitLabel(material.unit)}{material.reusable ? ' · reusable' : ''}</li>)}</ul></details>
              <label className="ska-field">Replacement for activity {index + 1}<select disabled={!include} value={replacements[entry.id] || ''} onChange={event => { invalidate(); setReplacements(values => ({ ...values, [entry.id]: event.target.value })); }}>
                <option value="">Keep saved activity</option>{choices.map(activity => <option key={activity.id} value={activity.id}>{activity.name} (current library version)</option>)}</select></label>
              {include && replacements[entry.id] && <p className="planner-entry-note">This copy will use the chosen activity’s current instructions and materials. Its saved time stays the same.</p>}
            </fieldset>;
          })}</div>
          <fieldset className="planner-copy-mode"><legend>Existing destination activities</legend>
            <label className="planner-reuse-check"><input type="radio" name="copy-mode" checked={mode === 'append'} onChange={() => { invalidate(); setMode('append'); }} />Add to existing activities</label>
            <label className="planner-reuse-check"><input type="radio" name="copy-mode" checked={mode === 'replace'} onChange={() => { invalidate(); setMode('replace'); }} />Replace activities on copied days</label>
            <p>Only dates with selected source activities are replaced. Empty or excluded source days leave the destination alone.</p></fieldset>
          {blocked && <p role="alert">Resolve the flagged activities above: choose a suitable replacement or uncheck them.</p>}
          <button type="button" className="ska-button" disabled={!included.length || blocked} onClick={preview}>Preview copy</button>
          {candidate && <div className="planner-copy-review"><h3>Review copy</h3><p>{candidate.copied.length} activities will be copied to {candidate.affectedDates.map(dateName).join(', ')}. {replaced ? replaced + ' existing activities will be replaced.' : 'Existing activities are kept.'}</p>
            <ul>{candidate.copied.map(entry => <li key={entry.id}>{entry.activity?.name} · {dateName(entry.date)} · {timeRange(entry)}</li>)}</ul>
            {countOverlaps(candidate.entries) > 0 && <p className="planner-entry-note">Some activities overlap in time. Review their times in the draft.</p>}
            {replaced > 0 && <label className="planner-reuse-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm replacing {replaced} existing activities on these dates.</label>}
            <PlanActionPreview plan={destination} entries={candidate.entries} disabled={replaced > 0 && !confirmed} actionLabel="Add copy to draft" onApply={() => onApply(candidate.entries)} />
          </div>}
        </>}
      </>}
      <button type="button" className="ska-button" onClick={onCancel}>Cancel</button>
    </div>
  </AppModal>;
}
