import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { authError } from '../../auth/transport';
import { currentMonday } from '../../lib/dates';
import { inventoryRequestId } from '../../api/inventory';
import { activitiesUrl, activityPlanUrl, entryPayload, entryProblem, orderedEntries, clockTime, timeMinutes } from '../../api/activities';
import type { Activity, ActivityPlan, Entry, MaterialCheck } from '../../api/activities';

const entryFields = ['date', 'startTime', 'endTime', 'timeBlock', 'activityId', 'activity', 'useLatest', 'copyFrom'] as const;
type EntryField = typeof entryFields[number];
type DraftUndo = { kind: 'draft'; addedIds: string[]; removed: Entry[];
  changed: { before: Entry; after: Entry; fields: EntryField[] }[]; label: string };
type UndoStep = { kind: 'removal'; entry: Entry; label: string } | DraftUndo;

function undoDraft(step: DraftUndo, current: Entry[]) {
  const added = new Set(step.addedIds);
  const changes = new Map(step.changed.map((change) => [change.before.id, change]));
  const restored = current.filter((entry) => !added.has(entry.id)).map((entry) => {
    const change = changes.get(entry.id);
    if (!change) return entry;
    const next = { ...entry };
    // Revert only the fields this operation changed, and retain a newer edit to
    // the same field. Other additions, times and library selections stay intact.
    for (const field of change.fields) {
      if (!Object.is(entry[field], change.after[field])) continue;
      if (Object.hasOwn(change.before, field)) Object.assign(next, { [field]: change.before[field] });
      else if (field === 'useLatest' || field === 'copyFrom') delete next[field];
    }
    return next;
  });
  const present = new Set(restored.map((entry) => entry.id));
  return [...restored, ...step.removed.filter((entry) => !present.has(entry.id))];
}

export function useActivityPlanner() {
  const [roomId, setRoomId] = useState('');
  const [weekStart, setWeekStart] = useState(currentMonday);
  const [catalog, setCatalog] = useState<Activity[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [catalogTick, setCatalogTick] = useState(0);
  const [reload, setReload] = useState(0);
  const [plan, setPlan] = useState<ActivityPlan | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const draftEntries = useRef<Entry[]>([]);
  const undoSteps = useRef<UndoStep[]>([]);
  const [undoHistory, setUndoHistory] = useState<UndoStep[]>([]);
  const [materials, setMaterials] = useState<MaterialCheck[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewTick, setPreviewTick] = useState(0);
  const requestId = useRef('');
  const savePending = useRef(false);
  const generation = useRef(0);

  const replaceEntries = useCallback((next: Entry[]) => { draftEntries.current = next; setEntries(next); }, []);
  const replaceUndo = useCallback((next: UndoStep[]) => { undoSteps.current = next; setUndoHistory(next); }, []);
  const clearUndo = useCallback(() => replaceUndo([]), [replaceUndo]);

  useEffect(() => {
    const controller = new AbortController(); setCatalogBusy(true); setCatalogError('');
    void axios.get<{ data: Activity[] }>(activitiesUrl, { signal: controller.signal }).then((response) => {
      if (!controller.signal.aborted) setCatalog(response.data.data);
    }).catch((failure) => { if (!controller.signal.aborted) setCatalogError(authError(failure, 'Could not load activities. Try Refresh activities.')); })
      .finally(() => { if (!controller.signal.aborted) setCatalogBusy(false); });
    return () => controller.abort();
  }, [catalogTick]);
  useEffect(() => {
    const controller = new AbortController(); const turn = generation.current + 1; generation.current = turn;
    setPlan(null); replaceEntries([]); setMaterials([]); setDirty(false); setError(''); setNotice(''); setBusy(false);
    clearUndo();
    if (!roomId || !weekStart) return () => controller.abort();
    setBusy(true);
    void axios.get<{ data: ActivityPlan }>(activityPlanUrl, { params: { roomId, weekStart }, signal: controller.signal }).then((response) => {
      if (controller.signal.aborted) return;
      setPlan(response.data.data); replaceEntries(response.data.data.entries); setMaterials(response.data.data.materials);
      requestId.current = inventoryRequestId();
    }).catch((failure) => { if (!controller.signal.aborted) setError(authError(failure, 'Could not load this week. Try Reload week.')); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { generation.current = turn + 1; controller.abort(); };
  }, [roomId, weekStart, reload, replaceEntries, clearUndo]);
  useEffect(() => {
    const controller = new AbortController(); setPreviewError('');
    if (!plan) { setPreviewBusy(false); return () => controller.abort(); }
    if (entries.some(entryProblem)) { setMaterials([]); setPreviewBusy(false); setPreviewError(''); return () => controller.abort(); }
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      void axios.post<{ data: { materials: MaterialCheck[] } }>(activityPlanUrl + '/preview',
        { roomId, weekStart, version: plan.version, entries: entryPayload(entries) }, { signal: controller.signal }).then((response) => {
        if (!controller.signal.aborted) setMaterials(response.data.data.materials);
      }).catch((failure) => { if (!controller.signal.aborted) { setMaterials([]); setPreviewError(authError(failure, 'Could not check materials. Try Check materials again.')); } })
        .finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [entries, roomId, weekStart, plan, previewTick]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const canLeave = () => !dirty || window.confirm('Discard the unsaved changes to this week?');
  function chooseRoom(id: string) { if (id !== roomId && !savePending.current && canLeave()) { setPlan(null); setRoomId(id); } }
  function chooseWeek(date: string) { if (date !== weekStart && !savePending.current && canLeave()) { setPlan(null); setWeekStart(date); } }
  function reloadWeek() { if (!savePending.current && canLeave()) setReload((value) => value + 1); }
  function changed() { setDirty(true); setNotice(''); setError(''); requestId.current = inventoryRequestId(); }
  function suggestedTimes(date: string, duration = 20) {
    const ends = draftEntries.current.filter((entry) => entry.date === date && entry.endTime).map((entry) => timeMinutes(entry.endTime!));
    const lastEnd = ends.length ? Math.max(...ends) : 480;
    // Convenient suggestions, always editable; no opening-hours or entry-count limit.
    const start = lastEnd < 1440 ? lastEnd : 480;
    return { startTime: clockTime(start), endTime: clockTime(Math.min(start + duration, 1440)) };
  }
  function addEntry(date: string, activity: Activity | null = null, times?: { startTime: string | null; endTime: string | null; timeBlock?: string | null }) {
    if (!plan || savePending.current) return;
    const selectedTimes = times || suggestedTimes(date, activity?.durationMinutes || 20);
    replaceEntries([...draftEntries.current, { id: inventoryRequestId(), date, startTime: selectedTimes.startTime, endTime: selectedTimes.endTime,
      timeBlock: times?.timeBlock ?? null, activityId: activity?.id || '', activity, useLatest: !!activity }]);
    changed();
  }
  function updateEntry(id: string, values: { activity: Activity; startTime: string | null; endTime: string | null; timeBlock: string | null }) {
    if (!plan || savePending.current) return;
    if (!draftEntries.current.some((entry) => entry.id === id)) return;
    replaceEntries(draftEntries.current.map((entry) => {
      if (entry.id !== id) return entry;
      const next = { ...entry, startTime: values.startTime, endTime: values.endTime, timeBlock: values.timeBlock,
      // A time edit keeps the scheduled snapshot, even when the library has a newer version.
      ...(entry.activityId !== values.activity.id ? { activityId: values.activity.id, activity: values.activity, useLatest: true } : {}),
      };
      if (entry.activityId !== values.activity.id) delete next.copyFrom;
      return next;
    }));
    changed();
  }
  function removeEntry(id: string) {
    if (!plan || savePending.current) return;
    const removed = draftEntries.current.find((entry) => entry.id === id);
    if (!removed) return;
    replaceUndo([...undoSteps.current, { kind: 'removal', entry: removed, label: 'Undo removal' }]);
    replaceEntries(draftEntries.current.filter((entry) => entry.id !== id)); changed();
  }
  function applyDraftChange(nextEntries: Entry[], label: string) {
    if (!plan || savePending.current) return;
    const before = new Map(draftEntries.current.map((entry) => [entry.id, entry]));
    const after = new Map(nextEntries.map((entry) => [entry.id, entry]));
    const step: DraftUndo = { kind: 'draft', label,
      addedIds: nextEntries.filter((entry) => !before.has(entry.id)).map((entry) => entry.id),
      removed: draftEntries.current.filter((entry) => !after.has(entry.id)),
      changed: nextEntries.flatMap((entry) => {
        const previous = before.get(entry.id);
        if (!previous) return [];
        const fields = entryFields.filter((field) => !Object.is(previous[field], entry[field]));
        return fields.length ? [{ before: previous, after: entry, fields }] : [];
      }) };
    if (!step.addedIds.length && !step.removed.length && !step.changed.length) return;
    replaceUndo([...undoSteps.current, step]);
    replaceEntries([...nextEntries]);
    changed();
  }
  function undoChange() {
    if (!plan || savePending.current) return;
    const step = undoSteps.current.at(-1);
    if (!step) return;
    replaceUndo(undoSteps.current.slice(0, -1));
    replaceEntries(step.kind === 'draft' ? undoDraft(step, draftEntries.current) : draftEntries.current.some((entry) => entry.id === step.entry.id)
      ? draftEntries.current : [...draftEntries.current, step.entry]);
    changed();
  }
  const undoRemoval = undoChange;
  function chooseActivity(id: string, activityId: string, updateOnly = false) {
    if (!plan || savePending.current) return;
    const activity = catalog.find((item) => item.id === activityId) || null;
    if (!draftEntries.current.some((entry) => entry.id === id)) return;
    replaceEntries(draftEntries.current.map((entry) => {
      if (entry.id !== id) return entry;
      const next = { ...entry, activityId, activity, useLatest: true,
        ...(!updateOnly && entry.startTime && activity?.durationMinutes ? { endTime: clockTime(Math.min(timeMinutes(entry.startTime) + activity.durationMinutes, 1440)) } : {}) };
      delete next.copyFrom;
      return next;
    }));
    changed();
  }
  function changeTime(id: string, field: 'startTime' | 'endTime', value: string) {
    if (!plan || savePending.current) return;
    if (!draftEntries.current.some((entry) => entry.id === id)) return;
    replaceEntries(draftEntries.current.map((entry) => {
      if (entry.id !== id) return entry;
      if (field === 'endTime') return { ...entry, timeBlock: null, endTime: value === '00:00' ? '24:00' : value };
      const duration = entry.startTime && entry.endTime && entry.endTime > entry.startTime ? timeMinutes(entry.endTime) - timeMinutes(entry.startTime) : entry.activity?.durationMinutes || 20;
      return { ...entry, timeBlock: null, startTime: value,
        ...(value ? { endTime: clockTime(Math.min(timeMinutes(value) + duration, 1440)) } : {}) };
    }));
    changed();
  }
  const activitySaved = useCallback((activity: Activity) => {
    setCatalog((previous) => [...previous.filter((item) => item.id !== activity.id), activity].sort((a, b) => a.name.localeCompare(b.name)));
    setNotice('Activity saved to the library. Save week separately to keep schedule changes.');
    // Saved and copied entries retain their snapshots; explicit library selections
    // use the edited activity. A library save never replaces a draft during Save week.
    if (savePending.current || !draftEntries.current.some((entry) => entry.activityId === activity.id && entry.useLatest && !entry.copyFrom)) return;
    replaceEntries(draftEntries.current.map((entry) => entry.activityId === activity.id && entry.useLatest && !entry.copyFrom ? { ...entry, activity } : entry));
    requestId.current = inventoryRequestId();
  }, [replaceEntries]);
  async function save() {
    if (!plan || savePending.current) return;
    const toSave = draftEntries.current;
    if (toSave.some(entryProblem)) { setError('Choose an activity and valid times for every row before saving.'); return; }
    savePending.current = true; setSaving(true); setError(''); setNotice('');
    const turn = generation.current;
    try {
      const response = await axios.post<{ data: ActivityPlan }>(activityPlanUrl, {
        roomId, weekStart, version: plan.version, entries: entryPayload(toSave), requestId: requestId.current,
      });
      if (turn !== generation.current) return;
      setPlan(response.data.data); replaceEntries(response.data.data.entries); setMaterials(response.data.data.materials);
      clearUndo();
      setDirty(false); setNotice('Week saved.'); requestId.current = inventoryRequestId();
    } catch (failure) { if (turn === generation.current) setError(authError(failure, 'Could not save the week. Your choices are still here; try Save week again.')); }
    finally { savePending.current = false; if (turn === generation.current) setSaving(false); }
  }
  return { roomId, weekStart, catalog, catalogBusy, catalogError, refreshCatalog: () => setCatalogTick((v) => v + 1),
    plan, entries: orderedEntries(entries), materials, dirty, busy, saving, error, notice, previewError, previewBusy,
    checkMaterials: () => setPreviewTick((v) => v + 1), chooseRoom, chooseWeek, reloadWeek, suggestedTimes, addEntry, updateEntry, removeEntry,
    removedCount: undoHistory.filter((step) => step.kind === 'removal').length, undoRemoval,
    applyDraftChange, undoCount: undoHistory.length, undoLabel: undoHistory.at(-1)?.label || '', undoChange,
    chooseActivity, changeTime, activitySaved, save };
}
