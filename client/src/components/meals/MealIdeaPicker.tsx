import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../../lib/api';
import { useUnsavedChanges } from '../UnsavedChangesContext';
import { MEAL_IDEAS } from './mealIdeas';
import type { MealIdea } from './mealIdeas';
import { MEAL_TYPES } from './weeklyPlan';
import type { Meal, MealType } from './weeklyPlan';
import RecipePhotoImport from './RecipePhotoImport';
import type { PhotoIngredient } from './recipePhoto';

export type IngredientOption = { id: string; name: string; unit: string; archived?: boolean };
type RecipeRow = { id: string; mealId: string; ingredientId: string; quantity: number };
export type MealIdeaSaveResult = { meal: Meal; ingredients: IngredientOption[]; recipe: RecipeRow[] };
type Props = { ingredients: IngredientOption[]; meals: Meal[]; disabled: boolean;
  onSaved: (result: MealIdeaSaveResult) => void; onEditingChange: (editing: boolean) => void };
type DraftRow = { key: string; source: string; name: string; unit: string; quantity: string; resolution?: string; original?: string };
type Draft = { requestId: string; name: string; type: MealType; description: string; rows: DraftRow[] };
const labels: Record<MealType, string> = { breakfast: 'Breakfast', snack: 'Morning snack', lunch: 'Lunch', afternoonSnack: 'Afternoon snack' };
const units = ['count', 'g', 'ml', 'oz', 'lb', 'gal'];
const input = 'ska-meal-idea-input mt-1 block min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'ska-meal-idea-button min-h-11 min-w-11 rounded-xl border border-violet-200 bg-white px-4 py-2.5 font-semibold text-slate-800 disabled:opacity-50';
const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export default function MealIdeaPicker({ ingredients, meals, disabled, onSaved, onEditingChange }: Props) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'ideas' | 'saved'>('ideas');
  const [query, setQuery] = useState('');
  const [type, setType] = useState<MealType | ''>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const rowNumber = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const copyController = useRef<AbortController | null>(null);
  const editingCallback = useRef(onEditingChange);
  const reportUnsaved = useUnsavedChanges();
  const hasDraft = !!draft;
  const editing = hasDraft || photoOpen;
  const blocked = disabled || busy || copying;
  const activeIngredients = ingredients.filter(value => !value.archived);
  const searchWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (name: string, description: string, mealType: MealType, ingredientNames = '') =>
    (!type || mealType === type) && searchWords.every(word => `${name} ${description} ${ingredientNames}`.toLowerCase().includes(word));
  const ideas = MEAL_IDEAS.filter(idea => matches(idea.name, idea.description, idea.type, idea.ingredients.map(value => value.name).join(' ')));
  const savedMeals = meals.filter(meal => !meal.archived && matches(meal.name, meal.description || '', meal.type));

  useLayoutEffect(() => { editingCallback.current = onEditingChange; onEditingChange(editing); }, [editing, onEditingChange]);
  useEffect(() => () => editingCallback.current(false), []);
  useLayoutEffect(() => { reportUnsaved(editing, busy || copying); }, [editing, busy, copying, reportUnsaved]);
  useEffect(() => () => reportUnsaved(false, false), [reportUnsaved]);
  useLayoutEffect(() => {
    if (hasDraft) nameRef.current?.focus();
    else if (restoreFocus.current) { restoreFocus.current = false; browseRef.current?.focus(); }
    else if (open) searchRef.current?.focus();
  }, [hasDraft, photoOpen, open]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; copyController.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!editing && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing, busy]);

  function row(value: { name: string; unit: string; quantity: number }, sourceId?: string): DraftRow {
    const exact = activeIngredients.filter(ingredient => normalize(ingredient.name) === normalize(value.name) && ingredient.unit === value.unit);
    const source = sourceId ? activeIngredients.find(ingredient => ingredient.id === sourceId) : undefined;
    const related = ingredients.filter(ingredient => normalize(ingredient.name) === normalize(value.name));
    const linked = sourceId ? source : exact.length === 1 ? exact[0] : undefined;
    return { key: String(++rowNumber.current), source: linked?.id || (related.length || sourceId ? 'unresolved' : 'new'),
      name: linked?.name || value.name, unit: linked?.unit || value.unit, quantity: String(value.quantity),
      resolution: !linked && (related.length || sourceId) ? 'Choose an active ingredient with the correct unit, or create a separate ingredient. Existing quantities and units stay unchanged.' : undefined };
  }
  function begin(name: string, mealType: MealType, description: string, rows: DraftRow[]) {
    setDraft({ requestId: crypto.randomUUID(), name, type: mealType, description, rows });
    setFields({}); setError(''); setConfirmCancel(false);
  }
  function chooseIdea(idea: MealIdea) {
    if (blocked) return;
    begin(idea.name, idea.type, idea.description, idea.ingredients.map(value => row(value)));
  }
  function usePhoto(name: string, rows: PhotoIngredient[]) {
    begin(name, type || 'lunch', '', rows.map(value => ({
      ...row({ name: value.name, unit: value.unit, quantity: Number(value.quantity) }),
      quantity: value.quantity, original: value.original,
      ...(!value.unit ? { source: 'new', unit: '', resolution: 'Choose a unit and enter the amount per person for this line. The original measure was not converted.' } : {}),
    })));
    setPhotoOpen(false);
  }
  async function copyMeal(meal: Meal) {
    if (disabled || busyRef.current || copying) return;
    busyRef.current = true; setCopying(true); setError('');
    const controller = new AbortController(); copyController.current = controller;
    try {
      const response = await axios.get(`${API_BASE_URL}/api/meals/${meal.id}/ingredients`, { signal: controller.signal });
      if (!mounted.current) return;
      const recipe: RecipeRow[] = response.data.data;
      begin(`${meal.name} copy`, meal.type, meal.description || '', recipe.map(link => {
        const ingredient = ingredients.find(value => value.id === link.ingredientId);
        return row({ name: ingredient?.name || '', unit: ingredient?.unit || 'count', quantity: link.quantity }, link.ingredientId);
      }));
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        const data = axios.isAxiosError(failure) ? failure.response?.data?.error : undefined;
        setError(data?.message || 'Could not load this recipe. Choose the saved meal again to retry.');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setCopying(false);
    }
  }
  function update(values: Partial<Draft>) {
    if (blocked) return;
    setDraft(old => old ? { ...old, ...values } : old); setConfirmCancel(false); setFields({}); setError('');
  }
  function updateRow(key: string, values: Partial<DraftRow>) {
    if (!draft) return;
    update({ rows: draft.rows.map(value => value.key === key ? { ...value, ...values } : value) });
  }
  function chooseIngredient(value: DraftRow, source: string) {
    const ingredient = activeIngredients.find(option => option.id === source);
    const changedUnit = ingredient && ingredient.unit !== value.unit;
    updateRow(value.key, { source, ...(ingredient ? { name: ingredient.name, unit: ingredient.unit } : {}),
      ...(changedUnit ? { quantity: '' } : {}), resolution: changedUnit ? 'The unit changed. Enter the quantity in this unit; amounts are not converted automatically.' : undefined });
  }
  function changeUnit(value: DraftRow, unit: string) {
    updateRow(value.key, { unit, ...(unit !== value.unit ? { quantity: '', resolution: 'The unit changed. Enter the quantity in this unit; amounts are not converted automatically.' } : {}) });
  }
  function discard() {
    if (blocked) return;
    restoreFocus.current = true;
    setDraft(null); setConfirmCancel(false); setFields({}); setError(''); setOpen(false);
  }
  const fieldProps = (key: string) => ({ id: `${formId}-${key}`, 'aria-invalid': !!fields[key],
    'aria-describedby': fields[key] ? `${formId}-error-${key}` : undefined });
  const fieldError = (key: string) => fields[key] && <p id={`${formId}-error-${key}`} className="mt-1 text-sm text-red-700">{fields[key]}</p>;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || busyRef.current || !draft) return;
    const invalid: Record<string, string> = {};
    if (!draft.name.trim() || draft.name.trim().length > 255) invalid.name = 'Enter a meal name between 1 and 255 characters.';
    if (!MEAL_TYPES.includes(draft.type)) invalid.type = 'Choose a meal type.';
    if (!draft.rows.length) invalid.ingredients = 'Add at least one ingredient to this recipe.';
    const seen = new Set<string>();
    draft.rows.forEach((value, index) => {
      const key = `ingredients.${index}`;
      if (value.source === 'unresolved') invalid[`${key}.ingredientId`] = 'Choose an ingredient or choose to create a new one.';
      else if (value.source === 'new') {
        if (!value.name.trim() || value.name.trim().length > 255) invalid[`${key}.name`] = 'Enter an ingredient name between 1 and 255 characters.';
        if (!units.includes(value.unit)) invalid[`${key}.unit`] = 'Choose a supported unit.';
      } else if (!activeIngredients.some(ingredient => ingredient.id === value.source)) invalid[`${key}.ingredientId`] = 'Choose an active ingredient.';
      const amount = Number(value.quantity);
      if (!value.quantity.trim() || !Number.isFinite(amount) || amount <= 0 || amount >= 1e12 || Number(amount.toFixed(6)) !== amount) {
        invalid[`${key}.quantity`] = 'Enter a positive quantity with at most six decimal places.';
      }
      const identity = `${normalize(value.name)}:${value.unit}`;
      if (seen.has(identity)) invalid[`${key}.ingredientId`] = 'This ingredient is already listed. Combine its quantities in one row.';
      seen.add(identity);
    });
    setFields(invalid); setError('');
    if (Object.keys(invalid).length) {
      setError('Check the highlighted fields before saving.');
      return;
    }
    const payload = { requestId: draft.requestId, meal: { name: draft.name.trim(), type: draft.type, description: draft.description.trim() },
      ingredients: draft.rows.map(value => ({ ...(value.source === 'new' ? { name: value.name.trim(), unit: value.unit } : { ingredientId: value.source }), quantity: Number(value.quantity) })) };
    busyRef.current = true; setBusy(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/api/meals/with-recipe`, payload);
      if (!mounted.current) return;
      setDraft(null); setOpen(false); setConfirmCancel(false); setFields({});
      onSaved(response.data.data);
    } catch (failure) {
      if (!mounted.current) return;
      const data = axios.isAxiosError(failure) ? failure.response?.data?.error : undefined;
      setError(data?.message || 'Could not save this meal. Your changes are still here. Try saving again.');
      setFields(Object.fromEntries(Object.entries(data?.fields || {}).map(([key, value]) => [key.startsWith('meal.') ? key.slice(5) : key, String(value)])));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="ska-meal-ideas min-w-0 rounded-2xl border border-violet-200 bg-violet-50/60 p-4 sm:p-5" aria-label="Meal ideas">
    {photoOpen ? <RecipePhotoImport disabled={disabled} onReady={usePhoto} onCancel={() => { restoreFocus.current = true; setPhotoOpen(false); }} /> : !draft ? <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h4 className="text-lg font-bold text-slate-900">A little inspiration for your menu</h4>
        <p className="mt-1 text-sm text-slate-600">Choose an idea, copy a saved meal or import a recipe photo. Make it your own before saving.</p></div>
        <div className="flex flex-wrap gap-2"><button ref={browseRef} type="button" disabled={blocked} aria-expanded={open} aria-controls={`${formId}-picker`} className={button} onClick={() => { setOpen(value => !value); setError(''); }}>Browse meal ideas</button>
        <button type="button" disabled={blocked} className={button} onClick={() => { setPhotoOpen(true); setError(''); }}>Import recipe photo</button></div></div>
      {open && <div id={`${formId}-picker`} className="mt-4 min-w-0 space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Meal idea sources"><button type="button" disabled={blocked} aria-pressed={tab === 'ideas'} className={button} onClick={() => { setTab('ideas'); setError(''); }}>Starter ideas</button>
          <button type="button" disabled={blocked} aria-pressed={tab === 'saved'} className={button} onClick={() => { setTab('saved'); setError(''); }}>Saved meals</button></div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="min-w-0" htmlFor={`${formId}-search`}>Search meal ideas<input ref={searchRef} id={`${formId}-search`} type="search" value={query} disabled={blocked} className={input} onChange={event => setQuery(event.target.value)} /></label>
          <label className="min-w-0" htmlFor={`${formId}-filter`}>Meal idea type<select id={`${formId}-filter`} value={type} disabled={blocked} className={input} onChange={event => setType(event.target.value as MealType | '')}><option value="">All meal types</option>{MEAL_TYPES.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label></div>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">{error}</p>}
        {copying && <p role="status">Loading the recipe to copy…</p>}
        <div className="ska-meal-idea-results grid min-w-0 gap-3 sm:grid-cols-2">
          {tab === 'ideas' ? ideas.map(idea => <button type="button" disabled={blocked} key={idea.id} aria-label={`Choose ${idea.name}`} className={`${button} min-w-0 text-left`} onClick={() => chooseIdea(idea)}>
            <span className="block break-words font-bold">{idea.name}</span><span className="mt-1 block text-sm text-violet-700">{labels[idea.type]}</span><span className="mt-2 block break-words text-sm font-normal text-slate-600">{idea.ingredients.map(value => value.name).join(', ')}</span></button>)
            : savedMeals.map(meal => <button type="button" disabled={blocked} key={meal.id} aria-label={`Copy ${meal.name}`} className={`${button} min-w-0 text-left`} onClick={() => void copyMeal(meal)}>
              <span className="block break-words font-bold">{meal.name}</span><span className="mt-1 block text-sm font-normal text-violet-700">{labels[meal.type]} · Make a copy</span></button>)}
        </div>
        {!(tab === 'ideas' ? ideas.length : savedMeals.length) && <p className="rounded-xl bg-white p-3 text-slate-600">{query.trim() || type ? 'No meals match your search. Try another name or meal type.' : 'No saved meals yet. Start with an idea or create your own meal below.'}</p>}
      </div>}
    </> : <form noValidate aria-label="Create meal from idea" onSubmit={event => void save(event)} className="min-w-0 space-y-4">
      <div><h4 className="text-xl font-bold text-slate-900">Make this meal your own</h4><p className="mt-1 text-sm text-slate-600">Nothing is saved yet. Edit the name and ingredients, then save the complete recipe.</p></div>
      <p role="status" className="text-sm font-semibold text-violet-800">Unsaved meal draft</p>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">{error}</p>}
      <fieldset disabled={blocked} className="min-w-0 space-y-4">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2"><div className="min-w-0"><label htmlFor={`${formId}-name`}>Meal name</label><input ref={nameRef} {...fieldProps('name')} value={draft.name} className={input} onChange={event => update({ name: event.target.value })} />{fieldError('name')}</div>
          <div className="min-w-0"><label htmlFor={`${formId}-type`}>Meal type</label><select {...fieldProps('type')} value={draft.type} className={input} onChange={event => update({ type: event.target.value as MealType })}>{MEAL_TYPES.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select>{fieldError('type')}</div></div>
        <div className="min-w-0"><label htmlFor={`${formId}-description`}>Description</label><textarea {...fieldProps('description')} className={input} value={draft.description} onChange={event => update({ description: event.target.value })} />{fieldError('description')}</div>
        <div><h5 className="font-bold">Ingredients</h5><p className="mt-1 text-sm text-slate-600">Quantities are per person. Starter amounts are editable estimates; use the amounts your facility serves.</p></div>
        {fieldError('ingredients')}
        {draft.rows.map((value, index) => {
          const key = `ingredients.${index}`;
          const linked = activeIngredients.find(ingredient => ingredient.id === value.source);
          return <section key={value.key} aria-label={`Ingredient ${index + 1} details`} className="ska-meal-idea-row min-w-0 space-y-3 rounded-xl border border-violet-100 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h6 className="font-semibold">Ingredient {index + 1}</h6><button type="button" aria-label={`Remove ingredient ${index + 1}`} className={button} onClick={() => update({ rows: draft.rows.filter(item => item.key !== value.key) })}>Remove</button></div>
            <div className="min-w-0"><label htmlFor={`${formId}-${key}.ingredientId`}>Ingredient {index + 1}</label><select {...fieldProps(`${key}.ingredientId`)} className={input} value={value.source} onChange={event => chooseIngredient(value, event.target.value)}>
              {value.source === 'unresolved' && <option value="unresolved">Choose how to use this ingredient</option>}<option value="new">Create a new ingredient</option>{activeIngredients.map(ingredient => <option key={ingredient.id} value={ingredient.id}>{ingredient.name} ({ingredient.unit})</option>)}</select>{fieldError(`${key}.ingredientId`)}</div>
            {value.resolution && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{value.resolution}</p>}
            {value.original && <p className="break-words text-sm text-slate-600">From recipe: {value.original}</p>}
            {!linked ? <div className="grid min-w-0 gap-3 sm:grid-cols-2"><div className="min-w-0"><label htmlFor={`${formId}-${key}.name`}>Ingredient {index + 1} name</label><input {...fieldProps(`${key}.name`)} className={input} value={value.name} onChange={event => updateRow(value.key, { name: event.target.value })} />{fieldError(`${key}.name`)}</div>
              <div className="min-w-0"><label htmlFor={`${formId}-${key}.unit`}>Ingredient {index + 1} unit</label><select {...fieldProps(`${key}.unit`)} className={input} value={value.unit} onChange={event => changeUnit(value, event.target.value)}>{!value.unit && <option value="">Choose a unit</option>}{units.map(unit => <option key={unit} value={unit}>{unit}</option>)}</select>{fieldError(`${key}.unit`)}</div></div>
              : <p className="break-words text-sm text-slate-600">Using {linked.name} ({linked.unit}). To rename an ingredient or change its unit for this copy, choose Create a new ingredient.</p>}
            <div className="min-w-0"><label htmlFor={`${formId}-${key}.quantity`}>Ingredient {index + 1} quantity per person ({value.unit})</label><input {...fieldProps(`${key}.quantity`)} type="number" min="0.000001" step="any" className={input} value={value.quantity} onChange={event => updateRow(value.key, { quantity: event.target.value })} />{fieldError(`${key}.quantity`)}</div>
          </section>;
        })}
        <button type="button" className={button} onClick={() => update({ rows: [...draft.rows, { key: String(++rowNumber.current), source: 'new', name: '', unit: 'count', quantity: '1' }] })}>Add ingredient</button>
        <div className="flex flex-wrap gap-3"><button type="submit" className={`${button} !border-violet-700 !bg-violet-700 !text-white`}>{busy ? 'Saving meal…' : 'Save meal & recipe'}</button><button type="button" className={button} onClick={() => setConfirmCancel(true)}>Cancel</button></div>
        {confirmCancel && <div role="group" aria-label="Discard meal draft" className="rounded-xl bg-amber-50 p-3"><p>Discard this meal draft? Your saved meals and ingredients stay as they are.</p><div className="mt-3 flex flex-wrap gap-3"><button type="button" className={button} onClick={() => setConfirmCancel(false)}>Keep editing</button><button type="button" className={button} onClick={discard}>Discard meal</button></div></div>}
      </fieldset>
    </form>}
  </section>;
}
