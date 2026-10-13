import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../../lib/api';
import { currentMonday, fromPlan, mondayOf, validationError, MEAL_TYPES } from './weeklyPlan';
import type { Draft, Plan } from './weeklyPlan';

type GenerationIssue = { mealId?: string; mealName?: string; message: string };
type Action = { kind: 'generate' | 'save' | 'import'; controller: AbortController };
type Entry = {
  draft: Draft; loaded: boolean; dirty: boolean; savedAt?: string;
  preview?: Plan; calculatedKey?: string; calculationError: string;
  loadError: string; generationError: string; generationIssues: GenerationIssue[]; retryImport: boolean; message: string; messageType: 'success' | 'error' | 'info';
};
const empty = (): Entry => ({ draft: { week: [], childrenCount: '20', staffCount: '5', inHouse: {}, version: 0 },
  loaded: false, dirty: false, calculationError: '', loadError: '', generationError: '', generationIssues: [], retryImport: false, message: '', messageType: 'info' });
const errorMessage = (error: unknown, fallback: string): string => {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data;
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message;
    return typeof message === 'string' && message.trim() ? message : fallback;
  }
  return error instanceof Error ? error.message : fallback;
};
const generationIssues = (details: { missingTypes?: { message: string }[]; excludedMeals?: {
  mealId: string; mealName: string; reasons: string[];
}[] } = {}): GenerationIssue[] => [
  ...(details.missingTypes || []).map(({ message }) => ({ message })),
  ...(details.excludedMeals || []).map(({ mealId, mealName, reasons }) => ({ mealId, mealName, message: reasons.join(' ') })),
];
const generatedWeekIsValid = (week: Draft['week']) => Array.isArray(week) && week.length === 5 &&
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].every((day, index) => week[index]?.day === day &&
    MEAL_TYPES.every((type) => typeof week[index]?.menu?.[type]?.id === 'string' && !!week[index].menu[type]?.id));
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
  const action = useRef<Action | null>(null);
  const draftRevision = useRef(0);
  const renderedRevision = draftRevision.current;
  const mounted = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const entry = entries[weekStart] || empty();
  const inputKey = keyOf(entry.draft);
  const invalid = validationError(entry.draft);
  const historical = !!entry.savedAt && !entry.dirty && !!entry.preview;
  const calculated = historical || entry.calculatedKey === inputKey;
  const ready = !historical && enabled && entry.loaded && entry.draft.week.length > 0 && !invalid &&
    !entry.calculationError && entry.calculatedKey === inputKey && !!entry.preview?.previewToken;
  const printReady = enabled && entry.loaded && !invalid && !entry.calculationError && calculated &&
    !!entry.preview && !entry.preview.warnings?.length && (historical || !!entry.preview.previewToken);
  const patch = useCallback((week: string, fn: (old: Entry) => Entry) => setEntries((old) => ({ ...old, [week]: fn(old[week] || empty()) })), []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; action.current?.controller.abort(); action.current = null; };
  }, []);

  const cancelGeneration = useCallback((showMessage = true) => {
    if (!action.current || action.current.kind === 'save') return;
    action.current.controller.abort(); action.current = null;
    if (!mounted.current) return;
    setActionLoading(null);
    if (showMessage) patch(weekStart, (old) => ({ ...old,
      message: 'Menu generation canceled. Your previous menu and counts are unchanged.', messageType: 'info' }));
  }, [patch, weekStart]);

  useEffect(() => {
    if (!enabled) {
      cancelGeneration();
      draftRevision.current++;
      sequence.current++;
      setEntries((old) => Object.fromEntries(Object.entries(old).map(([week, value]) =>
        [week, { ...value, calculatedKey: undefined }])));
    }
  }, [enabled, cancelGeneration]);

  useEffect(() => {
    try { localStorage.setItem('skao.planner.week', weekStart); } catch { /* Optional preference. */ }
  }, [weekStart]);

  const loaded = entry.loaded;
  useEffect(() => {
    if (!enabled || loaded) return;
    let active = true;
    const controller = new AbortController();
    axios.get(url(weekStart), { signal: controller.signal }).then(({ data }) => {
      if (!active) return;
      const plan: Plan | null = data.data;
      patch(weekStart, () => ({ ...empty(), loaded: true, ...(plan ? {
        draft: fromPlan(plan), savedAt: plan.savedAt, preview: plan,
        message: 'Your saved week is ready.', messageType: 'success' as const,
      } : {}) }));
    }).catch((error: unknown) => {
      if (active) patch(weekStart, (old) => ({ ...old, loadError: errorMessage(error, 'Could not load this week. Retry before editing.') }));
    });
    return () => { active = false; controller.abort(); };
  }, [weekStart, loaded, reload, enabled, patch]);

  useEffect(() => {
    const request = ++sequence.current;
    if (!enabled || !loaded || invalid || historical) return;
    const draft: Draft = JSON.parse(inputKey);
    if (!draft.week.length) return;
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await axios.post(`${url(weekStart)}/preview`, {
          week: draft.week, version: draft.version, refreshRecipes: draft.refreshRecipes || false,
          childrenCount: Number(draft.childrenCount), staffCount: Number(draft.staffCount),
          ...(draft.dailyChildrenCounts ? { dailyChildrenCounts: Object.fromEntries(Object.entries(draft.dailyChildrenCounts).map(([date, count]) => [date, Number(count)])) } : {}),
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
  }, [weekStart, inputKey, loaded, invalid, retry, enabled, historical, patch]);

  const anyDirty = Object.values(entries).some((value) => value.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [anyDirty]);

  const update = (change: Partial<Draft> | ((draft: Draft) => Partial<Draft>)) => {
    if (action.current?.kind === 'save' || !enabledRef.current) return;
    cancelGeneration(false);
    draftRevision.current++;
    sequence.current++;
    patch(weekStart, (old) => ({ ...old,
      draft: { ...old.draft, ...(typeof change === 'function' ? change(old.draft) : change) }, dirty: true, calculatedKey: undefined,
      calculationError: '', generationError: '', generationIssues: [], message: '', messageType: 'info',
    }));
  };
  const selectWeek = (date: string) => {
    const monday = mondayOf(date);
    if (!monday || monday === weekStart || action.current?.kind === 'save') return;
    cancelGeneration(false);
    draftRevision.current++;
    sequence.current++;
    patch(monday, (old) => ({ ...old, calculatedKey: undefined }));
    setWeekStart(monday);
  };
  const reopen = () => {
    if (action.current?.kind === 'save') return;
    if (entry.dirty && !window.confirm('Discard this week’s unsaved changes and reopen its saved version?')) return;
    cancelGeneration(false);
    draftRevision.current++;
    sequence.current++;
    patch(weekStart, empty);
    setReload((value) => value + 1);
  };
  const generate = async (importLegacy = false) => {
    if (!enabledRef.current || !entry.loaded || action.current || renderedRevision !== draftRevision.current) return;
    if (entry.draft.week.length && !window.confirm('Replace this week’s draft menu? Your saved version will remain until you save.')) return;
    const current: Action = { kind: importLegacy ? 'import' : 'generate', controller: new AbortController() };
    const draftKey = keyOf(entry.draft);
    const applies = () => mounted.current && enabledRef.current && action.current === current;
    action.current = current;
    setActionLoading(current.kind);
    patch(weekStart, (old) => ({ ...old, generationError: '', generationIssues: [], retryImport: importLegacy, message: '' }));
    try {
      const { data } = importLegacy
        ? await axios.post(`${url(weekStart)}/import-preview`, undefined, { signal: current.controller.signal })
        : await axios.get(`${API_BASE_URL}/api/menu/generate`, { signal: current.controller.signal });
      if (!applies()) return;
      if (importLegacy ? !Array.isArray(data.data?.week) || !data.data.week.length : !generatedWeekIsValid(data.data?.week)) throw new Error('The generated menu was incomplete. Your previous menu is unchanged. Try again or complete recipes in Meal Setup.');
      draftRevision.current++;
      sequence.current++;
      patch(weekStart, (old) => keyOf(old.draft) !== draftKey ? old : ({ ...old,
        draft: { ...old.draft, week: data.data.week, inHouse: {}, refreshRecipes: true },
        dirty: true, preview: undefined, calculatedKey: undefined, calculationError: '', generationError: '',
        generationIssues: generationIssues({ excludedMeals: data.data.setupWarnings }),
        message: importLegacy
          ? 'Earlier menu copied into an unsaved draft. Review the meals, counts and shopping list before saving.'
          : 'Menu generated as an unsaved draft. Review the meals and shopping list before saving.', messageType: 'info',
      }));
    } catch (error) {
      if (!applies()) return;
      const details = axios.isAxiosError(error) ? error.response?.data?.error?.details : undefined;
      patch(weekStart, (old) => keyOf(old.draft) !== draftKey ? old : ({ ...old,
        generationError: errorMessage(error, 'Could not generate a menu. Your previous menu is unchanged. Try again.'),
        generationIssues: generationIssues(details || {}), message: '',
      }));
    } finally {
      if (action.current === current) { action.current = null; if (mounted.current) setActionLoading(null); }
    }
  };
  const save = async () => {
    if (!enabledRef.current || !ready || action.current || renderedRevision !== draftRevision.current) return;
    const current: Action = { kind: 'save', controller: new AbortController() };
    action.current = current;
    setActionLoading('save');
    try {
      const { data } = await axios.put(url(weekStart), { previewToken: entry.preview?.previewToken });
      if (!mounted.current || action.current !== current) return;
      const plan: Plan = data.data;
      patch(weekStart, () => ({ ...empty(), loaded: true, draft: fromPlan(plan), savedAt: plan.savedAt,
        preview: plan, dirty: false, message: 'Menu and shopping list saved.', messageType: 'success' }));
    } catch (error) {
      if (!mounted.current || action.current !== current) return;
      const conflict = axios.isAxiosError(error) && error.response?.status === 409;
      patch(weekStart, (old) => ({ ...old, message: errorMessage(error, 'Save failed. Your draft is still here; try saving again.'),
        messageType: 'error', ...(conflict ? { calculatedKey: undefined, calculationError: 'Recalculate to refresh an expired calculation, or reopen if this week was saved elsewhere.' } : {}) }));
    } finally { if (action.current === current) { action.current = null; if (mounted.current) setActionLoading(null); } }
  };
  return { weekStart, selectWeek, reopen, entry, update, ready, printReady, historical, calculated, invalid, actionLoading,
    isBusy: actionLoading !== null || !entry.loaded, generate, save, cancelGeneration, retryGeneration: () => generate(entry.retryImport),
    recalculate: () => { if (!enabledRef.current || action.current) return; draftRevision.current++; sequence.current++; patch(weekStart, (old) => ({ ...old, dirty: true, calculatedKey: undefined, calculationError: '', message: '' })); setRetry((n) => n + 1); },
  };
}
