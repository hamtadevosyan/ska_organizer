import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../../lib/api';
import { currentMonday, fromPlan, mondayOf, validationError } from './weeklyPlan';
import type { Draft, Plan } from './weeklyPlan';

type Entry = {
  draft: Draft; loaded: boolean; dirty: boolean; savedAt?: string;
  preview?: Plan; calculatedKey?: string; calculationError: string;
  loadError: string; message: string; messageType: 'success' | 'error' | 'info';
};
const empty = (): Entry => ({ draft: { week: [], childrenCount: '20', staffCount: '5', inHouse: {}, version: 0 },
  loaded: false, dirty: false, calculationError: '', loadError: '', message: '', messageType: 'info' });
const errorMessage = (error: unknown, fallback: string) => axios.isAxiosError(error)
  ? error.response?.data?.error?.message || error.response?.data?.message || fallback
  : error instanceof Error ? error.message : fallback;
const keyOf = (draft: Draft) => JSON.stringify(draft);
const url = (week: string) => `${API_BASE_URL}/api/menu/plans/${week}`;
const rememberedWeek = () => {
  try { const value = localStorage.getItem('skao.planner.week'); if (value && mondayOf(value) === value) return value; }
  catch { /* Storage may be unavailable; planning still works. */ }
  return currentMonday();
};

export function useWeeklyPlan(enabled = true) {
  const [weekStart, setWeekStart] = useState(rememberedWeek);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [actionLoading, setActionLoading] = useState<'generate' | 'save' | 'import' | null>(null);
  const [retry, setRetry] = useState(0);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  const entry = entries[weekStart] || empty();
  const inputKey = keyOf(entry.draft);
  const invalid = validationError(entry.draft);
  const calculated = entry.calculatedKey === inputKey;
  const ready = enabled && entry.loaded && entry.draft.week.length > 0 && !invalid &&
    !entry.calculationError && entry.calculatedKey === inputKey && !!entry.preview?.previewToken;
  const patch = (week: string, fn: (old: Entry) => Entry) => setEntries((old) => ({ ...old, [week]: fn(old[week] || empty()) }));

  useEffect(() => {
    if (!enabled) {
      sequence.current++;
      setEntries((old) => Object.fromEntries(Object.entries(old).map(([week, value]) =>
        [week, { ...value, calculatedKey: undefined }])));
    }
  }, [enabled]);

  useEffect(() => {
    try { localStorage.setItem('skao.planner.week', weekStart); } catch { /* Optional preference. */ }
  }, [weekStart]);

  const loaded = entry.loaded;
  useEffect(() => {
    if (loaded) return;
    let active = true;
    const controller = new AbortController();
    axios.get(url(weekStart), { signal: controller.signal }).then(({ data }) => {
      if (!active) return;
      const plan: Plan | null = data.data;
      patch(weekStart, () => ({ ...empty(), loaded: true, ...(plan ? {
        draft: fromPlan(plan), savedAt: plan.savedAt, preview: plan,
        message: 'Saved week reopened.', messageType: 'success' as const,
      } : {}) }));
    }).catch((error: unknown) => {
      if (active) patch(weekStart, (old) => ({ ...old, loadError: errorMessage(error, 'Could not load this week. Retry before editing.') }));
    });
    return () => { active = false; controller.abort(); };
  }, [weekStart, loaded, reload]);

  useEffect(() => {
    const request = ++sequence.current;
    if (!enabled || !loaded || invalid) return;
    const draft: Draft = JSON.parse(inputKey);
    if (!draft.week.length) return;
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await axios.post(`${url(weekStart)}/preview`, {
          ...draft, childrenCount: Number(draft.childrenCount), staffCount: Number(draft.staffCount),
        }, { signal: controller.signal });
        if (!active || request !== sequence.current) return;
        patch(weekStart, (old) => keyOf(old.draft) !== inputKey ? old : {
          ...old, preview: data.data, calculatedKey: inputKey, calculationError: '',
        });
      } catch (error) {
        if (active && request === sequence.current) patch(weekStart, (old) => ({ ...old,
          calculatedKey: undefined, calculationError: errorMessage(error, 'Shopping calculation failed. Retry to enable Save and Print.') }));
      }
    }, 300);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [weekStart, inputKey, loaded, invalid, retry, enabled]);

  const anyDirty = Object.values(entries).some((value) => value.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [anyDirty]);

  const update = (change: Partial<Draft>) => {
    sequence.current++;
    patch(weekStart, (old) => ({ ...old,
      draft: { ...old.draft, ...change }, dirty: true, calculatedKey: undefined,
      calculationError: '', message: '', messageType: 'info',
    }));
  };
  const selectWeek = (date: string) => {
    const monday = mondayOf(date);
    if (!monday || monday === weekStart || actionLoading) return;
    sequence.current++;
    patch(monday, (old) => ({ ...old, calculatedKey: undefined }));
    setWeekStart(monday);
  };
  const reopen = () => {
    if (entry.dirty && !window.confirm('Discard this week’s unsaved changes and reopen its saved version?')) return;
    sequence.current++;
    patch(weekStart, empty);
    setReload((value) => value + 1);
  };
  const generate = async (importLegacy = false) => {
    if (!entry.loaded || actionLoading) return;
    if (entry.draft.week.length && !window.confirm('Replace this week’s draft menu? Your saved version will remain until you save.')) return;
    setActionLoading(importLegacy ? 'import' : 'generate');
    try {
      if (importLegacy) {
        const { data } = await axios.post(`${url(weekStart)}/import-preview`);
        update(fromPlan(data.data));
      } else {
        const { data } = await axios.get(`${API_BASE_URL}/api/menu/generate`);
        update({ week: data.data.week, inHouse: {}, refreshRecipes: true });
      }
      patch(weekStart, (old) => ({ ...old, message: importLegacy
        ? 'Earlier menu copied into this draft. Check the week, counts and stock, then save.'
        : 'Menu generated. Adjust meals, counts and stock, then save.', messageType: 'info' }));
    } catch (error) {
      patch(weekStart, (old) => ({ ...old, message: errorMessage(error, 'Could not create a menu.'), messageType: 'error' }));
    } finally { setActionLoading(null); }
  };
  const save = async () => {
    if (!ready || actionLoading) return;
    setActionLoading('save');
    try {
      const { data } = await axios.put(url(weekStart), { previewToken: entry.preview?.previewToken });
      const plan: Plan = data.data;
      patch(weekStart, () => ({ ...empty(), loaded: true, draft: fromPlan(plan), savedAt: plan.savedAt,
        preview: plan, dirty: false, message: 'Menu, headcounts and stock saved together.', messageType: 'success' }));
    } catch (error) {
      const conflict = axios.isAxiosError(error) && error.response?.status === 409;
      patch(weekStart, (old) => ({ ...old, message: errorMessage(error, 'Save failed. Your draft is still here; try saving again.'),
        messageType: 'error', ...(conflict ? { calculatedKey: undefined, calculationError: 'Recalculate to refresh an expired calculation, or reopen if this week was saved elsewhere.' } : {}) }));
    } finally { setActionLoading(null); }
  };
  return { weekStart, selectWeek, reopen, entry, update, ready, calculated, invalid, actionLoading,
    isBusy: actionLoading !== null || !entry.loaded, generate, save,
    recalculate: () => { sequence.current++; patch(weekStart, (old) => ({ ...old, calculatedKey: undefined, calculationError: '' })); setRetry((n) => n + 1); },
  };
}
