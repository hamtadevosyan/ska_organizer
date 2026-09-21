import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { authError } from '../../auth/transport';
import { currentMonday } from '../../lib/dates';
import { inventoryRequestId } from '../../api/inventory';
import { activitiesUrl, activityPlanUrl, entryPayload, entryProblem, orderedEntries, clockTime, timeMinutes } from '../../api/activities';
import type { Activity, ActivityPlan, Entry, MaterialCheck } from '../../api/activities';

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
    setPlan(null); setEntries([]); setMaterials([]); setDirty(false); setError(''); setNotice(''); setBusy(false);
    if (!roomId || !weekStart) return () => controller.abort();
    setBusy(true);
    void axios.get<{ data: ActivityPlan }>(activityPlanUrl, { params: { roomId, weekStart }, signal: controller.signal }).then((response) => {
      if (controller.signal.aborted) return;
      setPlan(response.data.data); setEntries(response.data.data.entries); setMaterials(response.data.data.materials);
      requestId.current = inventoryRequestId();
    }).catch((failure) => { if (!controller.signal.aborted) setError(authError(failure, 'Could not load this week. Try Reload week.')); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { generation.current = turn + 1; controller.abort(); };
  }, [roomId, weekStart, reload]);
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
  function addEntry(date: string, activity: Activity | null = null) {
    if (!plan || savePending.current) return;
    const ends = entries.filter((entry) => entry.date === date && entry.endTime).map((entry) => timeMinutes(entry.endTime!));
    const lastEnd = ends.length ? Math.max(...ends) : 480;
    // Convenient suggestions, always editable; no opening-hours or entry-count limit.
    const start = lastEnd < 1440 ? lastEnd : 480;
    setEntries((previous) => [...previous, { id: inventoryRequestId(), date, startTime: clockTime(start), endTime: clockTime(Math.min(start + (activity?.durationMinutes || 20), 1440)),
      timeBlock: null, activityId: activity?.id || '', activity, useLatest: !!activity }]);
    changed();
  }
  function removeEntry(id: string) {
    if (!plan || savePending.current) return;
    setEntries((previous) => previous.filter((entry) => entry.id !== id)); changed();
  }
  function chooseActivity(id: string, activityId: string, updateOnly = false) {
    if (!plan || savePending.current) return;
    const activity = catalog.find((item) => item.id === activityId) || null;
    setEntries((previous) => previous.map((entry) => entry.id !== id ? entry : { ...entry, activityId, activity, useLatest: true,
      ...(!updateOnly && entry.startTime && activity?.durationMinutes ? { endTime: clockTime(Math.min(timeMinutes(entry.startTime) + activity.durationMinutes, 1440)) } : {}) }));
    changed();
  }
  function changeTime(id: string, field: 'startTime' | 'endTime', value: string) {
    if (!plan || savePending.current) return;
    setEntries((previous) => previous.map((entry) => {
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
    setNotice('Activity saved. Choose it in the week below.');
    // Saved entries retain their snapshots; newly selected drafts use the edited activity.
    setEntries((previous) => previous.map((entry) => entry.activityId === activity.id && entry.useLatest ? { ...entry, activity } : entry));
    requestId.current = inventoryRequestId();
  }, []);
  async function save() {
    if (!plan || savePending.current) return;
    if (entries.some(entryProblem)) { setError('Choose an activity and valid times for every row before saving.'); return; }
    savePending.current = true; setSaving(true); setError(''); setNotice('');
    const turn = generation.current;
    try {
      const response = await axios.post<{ data: ActivityPlan }>(activityPlanUrl, {
        roomId, weekStart, version: plan.version, entries: entryPayload(entries), requestId: requestId.current,
      });
      if (turn !== generation.current) return;
      setPlan(response.data.data); setEntries(response.data.data.entries); setMaterials(response.data.data.materials);
      setDirty(false); setNotice('Week saved.'); requestId.current = inventoryRequestId();
    } catch (failure) { if (turn === generation.current) setError(authError(failure, 'Could not save the week. Your choices are still here; try Save week again.')); }
    finally { savePending.current = false; if (turn === generation.current) setSaving(false); }
  }
  return { roomId, weekStart, catalog, catalogBusy, catalogError, refreshCatalog: () => setCatalogTick((v) => v + 1),
    plan, entries: orderedEntries(entries), materials, dirty, busy, saving, error, notice, previewError, previewBusy,
    checkMaterials: () => setPreviewTick((v) => v + 1), chooseRoom, chooseWeek, reloadWeek, addEntry, removeEntry, chooseActivity, changeTime, activitySaved, save };
}
