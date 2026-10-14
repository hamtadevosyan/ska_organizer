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
  loadError: string; rosterError: string; rosterEmpty: boolean; generationError: string; generationIssues: GenerationIssue[]; retryImport: boolean; message: string; messageType: 'success' | 'error' | 'info';
};
const empty = (): Entry => ({ draft: { week: [], childrenCount: '', staffCount: '', inHouse: {}, version: 0 },
  loaded: false, dirty: false, calculationError: '', loadError: '', rosterError: '', rosterEmpty: false, generationError: '', generationIssues: [], retryImport: false, message: '', messageType: 'info' });
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
type RosterCounts = { childrenCount: number; staffCount: number };
const rosterCounts = (value: RosterCounts): RosterCounts => {
  if (!value || ![value.childrenCount, value.staffCount].every((count) => Number.isSafeInteger(count) && count >= 0) ||
      !Number.isSafeInteger(value.childrenCount + value.staffCount)) {
    throw new Error('The roster counts could not be verified. Retry reading the current roster.');
  }
  return value;
};
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
  const [rosterLoading, setRosterLoading] = useState(false);
  const rosterRequest = useRef<{ controller: AbortController; revision: number } | null>(null);
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
  const ready = !rosterLoading && !historical && enabled && entry.loaded && entry.draft.week.length > 0 && !invalid &&
    !entry.calculationError && entry.calculatedKey === inputKey && !!entry.preview?.previewToken;
  const printReady = !rosterLoading && enabled && entry.loaded && !invalid && !entry.calculationError && calculated &&
    !!entry.preview && !entry.preview.warnings?.length && (historical || !!entry.preview.previewToken);
  const patch = useCallback((week: string, fn: (old: Entry) => Entry) => setEntries((old) => ({ ...old, [week]: fn(old[week] || empty()) })), []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; action.current?.controller.abort(); action.current = null;
      rosterRequest.current?.controller.abort(); rosterRequest.current = null; };
  }, []);

  const cancelRosterRequest = useCallback(() => {
    if (!rosterRequest.current) return;
    rosterRequest.current.controller.abort(); rosterRequest.current = null;
    if (mounted.current) setRosterLoading(false);
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
      cancelRosterRequest();
      draftRevision.current++;
      sequence.current++;
      setEntries((old) => Object.fromEntries(Object.entries(old).map(([week, value]) =>
        [week, { ...value, calculatedKey: undefined }])));
    }
  }, [enabled, cancelGeneration, cancelRosterRequest]);

  useEffect(() => {
    try { localStorage.setItem('skao.planner.week', weekStart); } catch { /* Optional preference. */ }
  }, [weekStart]);

  const loaded = entry.loaded;
  useEffect(() => {
    if (!enabled || loaded) return;
    let active = true;
    const controller = new AbortController();
    const revision = draftRevision.current;
    const applies = () => active && mounted.current && enabledRef.current && revision === draftRevision.current;
    let loadingRoster = false;
    const loadWeek = async () => {
      try {
        const { data } = await axios.get(url(weekStart), { signal: controller.signal });
        if (!applies()) return;
        const plan: Plan | null = data.data;
        if (plan) {
          patch(weekStart, () => ({ ...empty(), loaded: true, draft: fromPlan(plan), savedAt: plan.savedAt, preview: plan,
            message: 'Your saved week is ready.', messageType: 'success' }));
          return;
        }
        loadingRoster = true;
        const rosterResponse = await axios.get(`${API_BASE_URL}/api/menu/headcounts`, { signal: controller.signal });
        if (!applies()) return;
        const counts = rosterCounts(rosterResponse.data.data);
        patch(weekStart, () => ({ ...empty(), loaded: true, rosterEmpty: counts.childrenCount + counts.staffCount === 0,
          draft: { ...empty().draft, childrenCount: String(counts.childrenCount), staffCount: String(counts.staffCount) },
        }));
      } catch (error: unknown) {
        if (applies()) patch(weekStart, (old) => ({ ...old,
          loadError: errorMessage(error, loadingRoster
            ? 'Could not read the current roster counts. Retry loading this week before editing.'
            : 'Could not load this week. Retry before editing.'),
        }));
      }
    };
    void loadWeek();
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
    cancelRosterRequest();
    draftRevision.current++;
    sequence.current++;
    patch(weekStart, (old) => ({ ...old,
      draft: { ...old.draft, ...(typeof change === 'function' ? change(old.draft) : change) }, dirty: true, calculatedKey: undefined,
      calculationError: '', rosterError: '', generationError: '', generationIssues: [], message: '', messageType: 'info',
    }));
  };
  const selectWeek = (date: string) => {
    const monday = mondayOf(date);
    if (!monday || monday === weekStart || action.current?.kind === 'save') return;
    cancelGeneration(false);
    cancelRosterRequest();
    draftRevision.current++;
    sequence.current++;
    patch(monday, (old) => ({ ...old, calculatedKey: undefined }));
    setWeekStart(monday);
  };
  const reopen = () => {
    if (action.current?.kind === 'save') return;
    if (entry.dirty && !window.confirm('Discard this week’s unsaved changes and reopen its saved version?')) return;
    cancelGeneration(false);
    cancelRosterRequest();
    draftRevision.current++;
    sequence.current++;
    patch(weekStart, empty);
    setReload((value) => value + 1);
  };
  const useCurrentRosterCounts = async () => {
    if (!enabledRef.current || !entry.loaded || action.current || rosterRequest.current || renderedRevision !== draftRevision.current) return;
    const current = { controller: new AbortController(), revision: draftRevision.current };
    const draftKey = keyOf(entry.draft);
    const applies = () => mounted.current && enabledRef.current && rosterRequest.current === current &&
      current.revision === draftRevision.current;
    rosterRequest.current = current;
    setRosterLoading(true);
    patch(weekStart, (old) => ({ ...old, rosterError: '' }));
    try {
      const { data } = await axios.get(`${API_BASE_URL}/api/menu/headcounts`, { signal: current.controller.signal });
      if (!applies()) return;
      const counts = rosterCounts(data.data);
      draftRevision.current++;
      sequence.current++;
      patch(weekStart, (old) => keyOf(old.draft) !== draftKey ? old : ({ ...old,
        draft: { ...old.draft, childrenCount: String(counts.childrenCount), staffCount: String(counts.staffCount) },
        dirty: true, calculatedKey: undefined, calculationError: '', rosterError: '', rosterEmpty: counts.childrenCount + counts.staffCount === 0,
        message: 'Current roster counts applied to this unsaved draft. Daily child counts are unchanged. Review before saving.',
        messageType: 'info',
      }));
    } catch (error: unknown) {
      if (applies()) patch(weekStart, (old) => ({ ...old,
        rosterError: errorMessage(error, 'Could not read the current roster. Your previous counts are unchanged. Retry or enter planned counts.'),
      }));
    } finally {
      if (rosterRequest.current === current) {
        rosterRequest.current = null;
        if (mounted.current) setRosterLoading(false);
      }
    }
  };
  const generate = async (importLegacy = false) => {
    if (!enabledRef.current || !entry.loaded || action.current || rosterRequest.current || renderedRevision !== draftRevision.current) return;
    if (importLegacy && invalid) {
      patch(weekStart, (old) => ({ ...old, generationError: `Enter planned counts before copying an earlier menu. ${invalid}`, generationIssues: [], retryImport: true }));
      return;
    }
    if (entry.draft.week.length && !window.confirm('Replace this week’s draft menu? Your saved version will remain until you save.')) return;
    const current: Action = { kind: importLegacy ? 'import' : 'generate', controller: new AbortController() };
    const draftKey = keyOf(entry.draft);
    const applies = () => mounted.current && enabledRef.current && action.current === current;
    action.current = current;
    setActionLoading(current.kind);
    patch(weekStart, (old) => ({ ...old, generationError: '', generationIssues: [], retryImport: importLegacy, message: '' }));
    try {
      const { data } = importLegacy
        ? await axios.post(`${url(weekStart)}/import-preview`, {
          childrenCount: Number(entry.draft.childrenCount), staffCount: Number(entry.draft.staffCount),
        }, { signal: current.controller.signal })
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
    if (!enabledRef.current || !ready || action.current || rosterRequest.current || renderedRevision !== draftRevision.current) return;
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
  return { weekStart, selectWeek, reopen, entry, update, useCurrentRosterCounts, rosterLoading, ready, printReady, historical, calculated, invalid, actionLoading,
    isBusy: actionLoading !== null || !entry.loaded, generate, save, cancelGeneration, retryGeneration: () => generate(entry.retryImport),
    recalculate: () => { if (!enabledRef.current || action.current) return; cancelRosterRequest(); draftRevision.current++; sequence.current++; patch(weekStart, (old) => ({ ...old, dirty: true, calculatedKey: undefined, calculationError: '', message: '' })); setRetry((n) => n + 1); },
  };
}
