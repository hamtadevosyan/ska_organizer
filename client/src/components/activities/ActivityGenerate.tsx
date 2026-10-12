import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import AppModal from '../AppModal';
import { authError } from '../../auth/transport';
import { inventoryRequestId } from '../../api/inventory';
import { activityPlanUrl, clockTime, dayLabel, entryPayload, entryProblem, orderedEntries, suitable, timeMinutes, timeRange, weekDates, materialUnitLabel } from '../../api/activities';
import type { Activity, ActivityGeneration, ActivityPlan, Entry, GenerationSlot } from '../../api/activities';
import type { Room } from '../../api/rooms';
import { countOverlaps } from './planReuse';
import { PlanActionPreview } from './PlanActionPreview';

type Props = { plan: ActivityPlan; entries: Entry[]; room: Room; catalog: Activity[]; onApply: (entries: Entry[]) => void;
  onCancel: () => void; onDirtyChange: (dirty: boolean) => void };
type Window = { id: string; startTime: string; endTime: string };
type Candidate = ActivityGeneration & { slots: GenerationSlot[]; replacedIds: string[] };
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
const windowProblem = (value: Pick<Window, 'startTime' | 'endTime'>) => !clock.test(value.startTime) || (!clock.test(value.endTime) && value.endTime !== '24:00')
  ? 'Enter a start and finish time.' : value.endTime <= value.startTime ? 'Finish time must be after start time.' : '';
const endValue = (value: string) => value === '24:00' ? '00:00' : value;

export function ActivityGenerate({ plan, entries, room, catalog, onApply, onCancel, onDirtyChange }: Props) {
  const [original] = useState(entries);
  const dates = weekDates(plan.weekStart);
  const [days, setDays] = useState(dates.slice(0, 5));
  const [windows, setWindows] = useState<Window[]>([{ id: inventoryRequestId(), startTime: '09:00', endTime: '09:30' }]);
  const [replaceIds, setReplaceIds] = useState<string[]>([]);
  const [replaceConsent, setReplaceConsent] = useState(false);
  const [allowRepeats, setAllowRepeats] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const turn = useRef(0);
  const fingerprint = catalog.map(value => value.id + ':' + value.version).sort().join(',');
  const context = plan.roomId + ':' + plan.weekStart + ':' + plan.version + ':' + fingerprint;
  const initialContext = useRef(context);
  const choices = catalog.filter(activity => activity.durationMinutes !== null && activity.durationMinutes > 0 && suitable(activity, room));
  const hasWindowProblem = windows.some(windowProblem);
  const settingsProblem = !days.length ? 'Choose at least one working day.' : !windows.length ? 'Add at least one time window.'
    : hasWindowProblem ? 'Correct the time windows below.' : days.length * windows.length > 140 ? 'Use no more than 140 time slots.' : '';
  const previewEntries = candidate ? orderedEntries(candidate.entries.filter(entry => candidate.generatedIds.includes(entry.id))) : [];
  const invalidPreview = candidate?.entries.some(entryProblem) || false;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { turn.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    if (context === initialContext.current) return;
    turn.current++; controller.current?.abort(); setPending(false); setCandidate(null);
    setError('The room, week or activity library changed. Cancel and reopen Generate week to use the latest information.');
  }, [context]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function settingsChanged() { setDirty(true); setCandidate(null); setSelectedSlots([]); setError(''); }
  function cancel() { turn.current++; controller.current?.abort(); onCancel(); }
  function stopRequest() { turn.current++; controller.current?.abort(); setPending(false); setError('Generation stopped. Your week and any earlier preview are still here.'); }
  async function generate(regenerate: boolean) {
    if (pending || context !== initialContext.current || (!regenerate && (settingsProblem || (replaceIds.length > 0 && !replaceConsent))) ||
      (regenerate && (!candidate || !selectedSlots.length || invalidPreview))) return;
    const current = candidate;
    const slots: GenerationSlot[] = regenerate && current ? current.slots.filter(slot => selectedSlots.includes(slot.id))
      : days.flatMap(date => windows.map(window => ({ id: window.id + '-' + date, date, startTime: window.startTime, endTime: window.endTime })));
    const toReplace = regenerate && current ? current.generatedSlots.filter(value => selectedSlots.includes(value.slotId)).map(value => value.entryId) : replaceIds;
    const excluded = regenerate && current ? [...new Set(current.entries.filter(entry => toReplace.includes(entry.id)).map(entry => entry.activityId))] : [];
    const request = new AbortController(); controller.current?.abort(); controller.current = request;
    const requestTurn = ++turn.current; setPending(true); setError(''); setDirty(true);
    try {
      const response = await axios.post<{ data: ActivityGeneration }>(activityPlanUrl + '/generate', {
        roomId: plan.roomId, weekStart: plan.weekStart, version: plan.version,
        entries: entryPayload(regenerate && current ? current.entries : original), slots,
        replaceEntryIds: toReplace, allowRepeats, excludeActivityIds: excluded,
      }, { signal: request.signal });
      if (request.signal.aborted || requestTurn !== turn.current) return;
      const result = response.data.data;
      const present = new Set(result.entries.map(entry => entry.id));
      const actuallyReplaced = original.filter(entry => !present.has(entry.id)).map(entry => entry.id);
      if (regenerate && current) {
        const keptIds = current.generatedIds.filter(id => present.has(id));
        setCandidate({ ...result, generatedIds: [...keptIds, ...result.generatedIds],
          generatedSlots: [...current.generatedSlots.filter(value => present.has(value.entryId)), ...result.generatedSlots],
          unfilledSlots: [...current.unfilledSlots.filter(slot => !selectedSlots.includes(slot.id)), ...result.unfilledSlots],
          warnings: result.warnings,
          slots: current.slots.map(slot => slots.find(next => next.id === slot.id) || slot), replacedIds: actuallyReplaced });
      } else setCandidate({ ...result, slots, replacedIds: actuallyReplaced });
      setSelectedSlots(result.unfilledSlots.map(slot => slot.id));
    } catch (failure) {
      if (!request.signal.aborted && requestTurn === turn.current) setError(authError(failure, 'Could not generate activities. Your week is unchanged. Try again.'));
    } finally { if (!request.signal.aborted && requestTurn === turn.current) setPending(false); }
  }
  function editEntry(id: string, field: 'activityId' | 'startTime' | 'endTime', value: string) {
    if (!candidate || pending) return;
    setError(''); setDirty(true);
    const slotId = candidate.generatedSlots.find(slot => slot.entryId === id)?.slotId;
    const previousEntry = candidate.entries.find(entry => entry.id === id);
    const slots = field === 'activityId' ? candidate.slots : candidate.slots.map(slot => {
      if (slot.id !== slotId) return slot;
      if (field === 'endTime') return { ...slot, endTime: value === '00:00' ? '24:00' : value };
      const shift = value && previousEntry?.startTime ? timeMinutes(value) - timeMinutes(previousEntry.startTime) : 0;
      return { ...slot, startTime: value, endTime: clockTime(Math.min(1440, Math.max(0, timeMinutes(slot.endTime) + shift))) };
    });
    setCandidate({ ...candidate, slots, entries: candidate.entries.map(entry => {
      if (entry.id !== id) return entry;
      if (field === 'activityId') {
        const activity = choices.find(option => option.id === value);
        if (!activity) return entry;
        return { ...entry, activityId: activity.id, activity, useLatest: true,
          ...(entry.startTime ? { endTime: clockTime(Math.min(timeMinutes(entry.startTime) + activity.durationMinutes!, 1440)) } : {}) };
      }
      if (field === 'endTime') return { ...entry, endTime: value === '00:00' ? '24:00' : value };
      const duration = entry.startTime && entry.endTime && entry.endTime > entry.startTime ? timeMinutes(entry.endTime) - timeMinutes(entry.startTime) : entry.activity?.durationMinutes || 20;
      return { ...entry, startTime: value, ...(value ? { endTime: clockTime(Math.min(timeMinutes(value) + duration, 1440)) } : {}) };
    }) });
  }
  function selectSlot(id: string, checked: boolean) { setSelectedSlots(values => checked ? [...values, id] : values.filter(value => value !== id)); setDirty(true); }
  return <AppModal id="planner-generate" title="Generate week" initialFocusId="generation-first-day" onDismiss={cancel}>
    <div className="planner-generation planner-reuse">
      <div className="planner-generation-intro"><Sparkles size={26} aria-hidden="true" /><div><strong>A week of possibilities</strong><p>Choose the days and times. We suggest suitable saved activities, then you make them your own.</p></div></div>
      <p className="planner-copy-summary"><strong>{room.name}</strong> · Week of {plan.weekStart}<br />Uses your local activity library. Nothing is saved until you use the draft and choose Save week.</p>
      {!candidate && <>
        <fieldset className="planner-generation-days" disabled={pending}><legend>Working days</legend>{dates.map((date, index) => <label key={date} className="planner-reuse-check"><input id={index === 0 ? 'generation-first-day' : undefined} type="checkbox" aria-label={'Plan ' + dayLabel(date)} checked={days.includes(date)} onChange={event => { settingsChanged(); setDays(values => event.target.checked ? [...values, date].sort() : values.filter(value => value !== date)); }} />{dayLabel(date)}</label>)}</fieldset>
        <fieldset className="planner-generation-windows" disabled={pending}><legend>Time windows</legend><p>One activity per window on each chosen day. Activities finish within the window; shorter activities leave a little breathing room.</p>
          {windows.map((window, index) => <div className="planner-generation-window" key={window.id}><label className="ska-field">Window {index + 1} start<input type="time" value={window.startTime} aria-invalid={!!windowProblem(window)} onChange={event => { settingsChanged(); setWindows(values => values.map(value => value.id === window.id ? { ...value, startTime: event.target.value } : value)); }} /></label>
            <label className="ska-field">Window {index + 1} finish by<input type="time" value={endValue(window.endTime)} aria-invalid={!!windowProblem(window)} onChange={event => { settingsChanged(); setWindows(values => values.map(value => value.id === window.id ? { ...value, endTime: event.target.value === '00:00' ? '24:00' : event.target.value } : value)); }} /></label>
            <button type="button" className="ska-button" aria-label={'Remove window ' + (index + 1)} disabled={pending} onClick={() => { settingsChanged(); setWindows(values => values.filter(value => value.id !== window.id)); }}><Trash2 size={17} aria-hidden="true" />Remove</button>
            {windowProblem(window) && <p className="planner-generation-window-error" role="alert">{windowProblem(window)}</p>}</div>)}
          <button type="button" className="ska-button" disabled={windows.length >= 20} onClick={() => { settingsChanged(); setWindows(values => [...values, { id: inventoryRequestId(), startTime: '10:00', endTime: '10:30' }]); }}><Plus size={18} aria-hidden="true" />Add time window</button></fieldset>
        {original.length > 0 && <details className="planner-copy-mode"><summary>Existing activities are kept</summary><p>Only select activities here if you want to replace them. All others stay in your week.</p>
          {orderedEntries(original).map((entry, index) => <label key={entry.id} className="planner-reuse-check"><input type="checkbox" disabled={pending} checked={replaceIds.includes(entry.id)} aria-label={'Replace existing activity ' + (index + 1)} onChange={event => { settingsChanged(); setReplaceConsent(false); setReplaceIds(values => event.target.checked ? [...values, entry.id] : values.filter(id => id !== entry.id)); }} /><span>{entry.activity?.name} · {dayLabel(entry.date)} · {timeRange(entry)}</span></label>)}
          {replaceIds.length > 0 && <label className="planner-reuse-check"><input type="checkbox" disabled={pending} checked={replaceConsent} onChange={event => { settingsChanged(); setReplaceConsent(event.target.checked); }} />I agree to replace the {replaceIds.length} selected existing activities after reviewing the preview.</label>}</details>}
        <p>{choices.length} suitable activities have ages and durations ready for this room. We favor variety and activities used less recently.</p>
        {!choices.length && <p className="ska-alert is-error" role="alert">No activities are ready to generate for this room. Add a duration and suitable ages (or all ages) in Saved activities, then reopen this tool.</p>}
      </>}
      <label className="planner-reuse-check"><input type="checkbox" disabled={pending} checked={allowRepeats} onChange={event => { setAllowRepeats(event.target.checked); setDirty(true); }} />Allow repeated activities when needed</label>
      <p className="planner-generation-small">Repeated activities are off by default. Missing materials are flagged for your review; stock is never used or reserved.</p>
      <p className="planner-generation-small">Materials are checked for this room only. Other rooms may also need the same reusable supplies.</p>
      {error && <p role="alert" className="ska-alert is-error">{error}</p>}
      {pending ? <div role="status" className="planner-generation-pending"><p>Finding activities and checking this week…</p><button type="button" className="ska-button" onClick={stopRequest}>Stop generation</button></div>
        : !candidate && <><button type="button" className="ska-button is-primary" disabled={!!settingsProblem || !choices.length || (replaceIds.length > 0 && !replaceConsent) || context !== initialContext.current} onClick={() => void generate(false)}><Sparkles size={18} aria-hidden="true" />Preview generated week</button>{settingsProblem && <p role="alert">{settingsProblem}</p>}</>}
      {candidate && <section className="planner-generation-review" aria-label="Generated week preview"><h3>Make it your week</h3>
        <p>{previewEntries.length} suggested activities. {candidate.replacedIds.length ? candidate.replacedIds.length + ' selected existing activities will be replaced.' : 'Existing activities stay in your week.'} Edit a suggestion or select just the slots you want to try again.</p>
        {candidate.replacedIds.length > 0 && <div className="planner-generation-unfilled"><strong>Selected activities to replace</strong><ul>{original.filter(entry => candidate.replacedIds.includes(entry.id)).map(entry => <li key={entry.id}>{entry.activity?.name} · {dayLabel(entry.date)} · {timeRange(entry)}</li>)}</ul></div>}
        {candidate.entries.some(entry => !candidate.generatedIds.includes(entry.id)) && <details><summary>Existing activities kept in this preview</summary><ul>{orderedEntries(candidate.entries.filter(entry => !candidate.generatedIds.includes(entry.id))).map(entry => <li key={entry.id}>{entry.activity?.name} · {dayLabel(entry.date)} · {timeRange(entry)}</li>)}</ul></details>}
        {candidate.warnings.length > 0 && <ul className="planner-generation-warnings">{candidate.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {countOverlaps(candidate.entries) > 0 && <p className="ska-alert">Some activities overlap. Review their times before using this draft.</p>}
        {previewEntries.map((entry, index) => {
          const slotId = candidate.generatedSlots.find(value => value.entryId === entry.id)?.slotId;
          return <fieldset key={entry.id} className="planner-generation-suggestion" disabled={pending}><legend>{dayLabel(entry.date)} · Suggestion {index + 1}</legend>
            <label className="ska-field">Suggested activity {index + 1}<select value={entry.activityId} onChange={event => editEntry(entry.id, 'activityId', event.target.value)}>{choices.map(activity => <option key={activity.id} value={activity.id}>{activity.name} · {activity.durationMinutes} min</option>)}</select></label>
            <div className="planner-generation-times"><label className="ska-field">Suggested start {index + 1}<input type="time" value={entry.startTime || ''} aria-invalid={!!entryProblem(entry)} onChange={event => editEntry(entry.id, 'startTime', event.target.value)} /></label>
              <label className="ska-field">Suggested end {index + 1}<input type="time" value={endValue(entry.endTime || '')} aria-invalid={!!entryProblem(entry)} onChange={event => editEntry(entry.id, 'endTime', event.target.value)} /></label></div>
            {entryProblem(entry) && <p role="alert">{entryProblem(entry)}</p>}
            <details><summary>Instructions and materials</summary><p>{entry.activity?.description || 'No instructions listed.'}</p><ul>{entry.activity?.materials.map(material => <li key={material.itemId}>{material.name || 'Inventory item'} · {material.quantity} {materialUnitLabel(material.unit)}{material.reusable ? ' · reusable' : ''}</li>)}</ul></details>
            {slotId && <label className="planner-reuse-check"><input type="checkbox" aria-label={'Try another activity for suggestion ' + (index + 1)} checked={selectedSlots.includes(slotId)} onChange={event => selectSlot(slotId, event.target.checked)} />Try another activity for this slot</label>}</fieldset>;
        })}
        {candidate.unfilledSlots.length > 0 && <div className="planner-generation-unfilled"><h3>Slots that need your choice</h3>{candidate.unfilledSlots.map(slot => <label key={slot.id} className="planner-reuse-check"><input type="checkbox" disabled={pending} checked={selectedSlots.includes(slot.id)} aria-label={'Retry ' + dayLabel(slot.date) + ' at ' + slot.startTime} onChange={event => selectSlot(slot.id, event.target.checked)} /><span><strong>{dayLabel(slot.date)} · {slot.startTime}–{slot.endTime}</strong><br />{slot.reason}</span></label>)}<p>You can use the filled suggestions now and add more activities later.</p></div>}
        <div className="planner-action-buttons"><button type="button" className="ska-button" disabled={pending || !selectedSlots.length || invalidPreview || context !== initialContext.current} onClick={() => void generate(true)}>Regenerate selected slots</button><button type="button" className="ska-button" disabled={pending} onClick={() => { setCandidate(null); setSelectedSlots([]); setError(''); }}>Change days and times</button></div>
        {invalidPreview ? <p role="alert">Correct the suggested activities and times before checking the preview.</p> : <PlanActionPreview plan={plan} entries={candidate.entries} disabled={pending || !!error || !previewEntries.length || context !== initialContext.current} actionLabel="Use generated plan" onApply={() => onApply(candidate.entries)} />}
      </section>}
      <button type="button" className="ska-button" onClick={cancel}>Cancel</button>
    </div>
  </AppModal>;
}
