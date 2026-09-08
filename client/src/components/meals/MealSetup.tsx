import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../../lib/api';
import { MEAL_TYPES } from './weeklyPlan';
import type { Meal, MealType } from './weeklyPlan';

type Ingredient = { id: string; name: string; unit: string; archived?: boolean };
type RecipeLink = { id: string; ingredientId: string; quantity: number };
type Feedback = { scope: string; message: string; fields?: Record<string, string>; error?: boolean };
const emptyMeal = () => ({ name: '', type: 'breakfast' as MealType, description: '' });
const emptyIngredient = () => ({ name: '', unit: 'count' });
const labels = { breakfast: 'Breakfast', snack: 'Morning snack', lunch: 'Lunch', afternoonSnack: 'Afternoon snack' };
const control = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 disabled:bg-gray-100';
const button = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50';
const primary = `${button} !bg-emerald-700 !text-white`;
function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return <div><label htmlFor={id} className="text-sm font-medium">{label}</label>{children}
    {error && <p id={`${id}-error`} className="mt-1 text-sm text-red-700">{error}</p>}</div>;
}

export default function MealSetup({ initialMealId, onBusyChange }: { initialMealId?: string; onBusyChange?: (busy: boolean) => void }) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [mealId, setMealId] = useState('');
  const [ingredientId, setIngredientId] = useState('');
  const [mealForm, setMealForm] = useState(emptyMeal);
  const [ingredientForm, setIngredientForm] = useState(emptyIngredient);
  const [links, setLinks] = useState<RecipeLink[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [assignment, setAssignment] = useState({ ingredientId: '', quantity: '1' });
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recipeLoading, setRecipeLoading] = useState(false);
  const [recipeError, setRecipeError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [recipeRetry, setRecipeRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [feedback, setFeedback] = useState<Feedback>();
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const meal = meals.find((value) => value.id === mealId);
  const ingredient = ingredients.find((value) => value.id === ingredientId);
  const availableIngredients = ingredients.filter((value) => !value.archived && !links.some((link) => link.ingredientId === value.id));
  const api = (path: string) => `${API_BASE_URL}/api/${path}`;
  const report = (scope: string, error: unknown) => {
    const data = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
    setFeedback({ scope, error: true, message: data?.message || 'Could not complete this request. Your entries are still here.', fields: data?.fields });
  };
  const field = (scope: string, name: string) => feedback?.scope === scope ? feedback.fields?.[name] : undefined;
  const attributes = (scope: string, name: string, id: string) => ({
    'aria-invalid': !!field(scope, name), 'aria-describedby': field(scope, name) ? `${id}-error` : undefined,
  });
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      axios.get(`${API_BASE_URL}/api/meals?includeArchived=true`, { signal: controller.signal }),
      axios.get(`${API_BASE_URL}/api/ingredients?includeArchived=true`, { signal: controller.signal }),
    ]).then(([mealResponse, ingredientResponse]) => {
      if (!current) return;
      const loadedMeals: Meal[] = mealResponse.data.data;
      setMeals(loadedMeals); setIngredients(ingredientResponse.data.data);
      const selected = loadedMeals.find((value) => value.id === initialMealId);
      if (selected) { setMealId(selected.id); setMealForm({ name: selected.name, type: selected.type, description: selected.description || '' }); }
      setFeedback(undefined); setLoading(false);
    }).catch((error: unknown) => { if (current) report('load', error); });
    return () => { current = false; controller.abort(); };
  }, [initialMealId, retry]);
  useEffect(() => {
    setLinks([]); setQuantities({}); setAssignment({ ingredientId: '', quantity: '1' }); setRecipeError(false);
    if (!mealId) { setRecipeLoading(false); return; }
    let current = true;
    const controller = new AbortController();
    setRecipeLoading(true);
    axios.get(`${API_BASE_URL}/api/meals/${mealId}/ingredients`, { signal: controller.signal }).then(({ data }) => {
      if (!current) return;
      const rows: RecipeLink[] = data.data;
      setLinks(rows); setQuantities(Object.fromEntries(rows.map((row) => [row.id, String(row.quantity)])));
    }).catch((error: unknown) => { if (current) { setRecipeError(true); report('recipe', error); } })
      .finally(() => { if (current) setRecipeLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [mealId, recipeRetry]);

  const run = async (scope: string, success: string, operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); onBusyChange?.(true); setFeedback(undefined);
    try { await operation(); setFeedback({ scope, message: success }); }
    catch (error) { report(scope, error); }
    finally { busyRef.current = false; setBusy(false); onBusyChange?.(false); }
  };
  const chooseMeal = (id: string) => {
    const value = meals.find((item) => item.id === id);
    setMealId(id); setMealForm(value ? { name: value.name, type: value.type, description: value.description || '' } : emptyMeal());
    setFeedback(undefined);
  };
  const chooseIngredient = (id: string) => {
    const value = ingredients.find((item) => item.id === id);
    setIngredientId(id); setIngredientForm(value ? { name: value.name, unit: value.unit } : emptyIngredient()); setFeedback(undefined);
  };
  const saveMeal = () => run('meal', mealId ? 'Meal updated.' : 'Meal added. Add its recipe below.', async () => {
    const { data } = mealId ? await axios.put(api(`meals/${mealId}`), mealForm) : await axios.post(api('meals'), mealForm);
    const saved: Meal = data.data;
    setMeals((old) => mealId ? old.map((value) => value.id === mealId ? saved : value) : [...old, saved]);
    setMealId(saved.id); setMealForm({ name: saved.name, type: saved.type, description: saved.description || '' });
  });
  const saveIngredient = () => run('ingredient', ingredientId ? 'Ingredient updated.' : 'Ingredient added.', async () => {
    const { data } = ingredientId ? await axios.put(api(`ingredients/${ingredientId}`), ingredientForm) : await axios.post(api('ingredients'), ingredientForm);
    const saved: Ingredient = data.data;
    setIngredients((old) => ingredientId ? old.map((value) => value.id === ingredientId ? saved : value) : [...old, saved]);
    setIngredientId(saved.id); setIngredientForm({ name: saved.name, unit: saved.unit });
  });
  const archive = (kind: 'meal' | 'ingredient') => {
    const value = kind === 'meal' ? meal : ingredient;
    if (!value) return;
    const action = value.archived ? 'Restore' : 'Archive';
    if (!window.confirm(`${action} ${value.name}? Saved weeks keep their original recipes and quantities.`)) return;
    void run(kind, `${kind === 'meal' ? 'Meal' : 'Ingredient'} ${value.archived ? 'restored' : 'archived'}.`, async () => {
      const { data } = await axios.put(api(`${kind === 'meal' ? 'meals' : 'ingredients'}/${value.id}`), { archived: !value.archived });
      if (kind === 'meal') setMeals((old) => old.map((item) => item.id === value.id ? data.data : item));
      else setIngredients((old) => old.map((item) => item.id === value.id ? data.data : item));
    });
  };
  const assign = () => run('assign', 'Ingredient added to the recipe.', async () => {
    const { data } = await axios.post(api(`meals/${mealId}/ingredients`), { ...assignment, quantity: Number(assignment.quantity) });
    const link: RecipeLink = data.data;
    setLinks((old) => [...old, link]); setQuantities((old) => ({ ...old, [link.id]: String(link.quantity) }));
    setAssignment({ ingredientId: '', quantity: '1' });
  });
  const saveQuantity = (link: RecipeLink) => run(link.id, 'Recipe quantity updated.', async () => {
    const { data } = await axios.put(api(`meals/ingredients/${link.id}`), { quantity: Number(quantities[link.id]) });
    setLinks((old) => old.map((value) => value.id === link.id ? data.data : value));
    setQuantities((old) => ({ ...old, [link.id]: String(data.data.quantity) }));
  });
  const remove = (link: RecipeLink) => {
    const name = ingredients.find((value) => value.id === link.ingredientId)?.name || 'this ingredient';
    if (!window.confirm(`Remove ${name} from ${meal?.name}? Saved weeks keep their original recipes.`)) return;
    void run(link.id, 'Ingredient removed from this recipe.', async () => {
      await axios.delete(api(`meals/ingredients/${link.id}`)); setLinks((old) => old.filter((value) => value.id !== link.id));
    });
  };

  return <div className="space-y-6">
    <div><h3 className="text-2xl font-bold">Meal Setup</h3>
      <p className="mt-1 text-sm text-gray-600">Correct the catalog and recipes here. Return to Planner to review the updated draft shopping list.</p></div>
    {feedback && <div role={feedback.error ? 'alert' : 'status'} className={`rounded-xl border p-4 ${feedback.error ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}>
      {feedback.message}
      {feedback.scope === 'load' && <button className={`${button} ml-3`} onClick={() => setRetry((old) => old + 1)}>Retry loading catalog</button>}
    </div>}
    {loading && <p>Loading catalog…</p>}
    <fieldset disabled={busy || loading} className="space-y-6">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Show archived meals and ingredients</label>
      <div className="grid gap-6 lg:grid-cols-2">
        <form noValidate onSubmit={(event) => { event.preventDefault(); void saveMeal(); }} className="space-y-4 rounded-2xl border bg-white p-5">
          <h4 className="text-lg font-bold">{mealId ? 'Edit meal' : 'Create meal'}</h4>
          <Field id="choose-meal" label="Choose meal"><select id="choose-meal" className={control} value={mealId} onChange={(event) => chooseMeal(event.target.value)}>
            <option value="">New meal</option>{meals.filter((value) => showArchived || !value.archived || value.id === mealId).map((value) => <option key={value.id} value={value.id}>{value.name}{value.archived ? ' (archived)' : ''}</option>)}
          </select></Field>
          <Field id="meal-name" label="Meal name" error={field('meal', 'name')}><input id="meal-name" {...attributes('meal', 'name', 'meal-name')} className={control} value={mealForm.name} onChange={(event) => setMealForm({ ...mealForm, name: event.target.value })} /></Field>
          <Field id="meal-type" label="Meal type" error={field('meal', 'type')}><select id="meal-type" {...attributes('meal', 'type', 'meal-type')} className={control} value={mealForm.type} onChange={(event) => setMealForm({ ...mealForm, type: event.target.value as MealType })}>{MEAL_TYPES.map((type) => <option key={type} value={type}>{labels[type]}</option>)}</select></Field>
          <Field id="meal-description" label="Description" error={field('meal', 'description')}><textarea id="meal-description" {...attributes('meal', 'description', 'meal-description')} className={control} value={mealForm.description} onChange={(event) => setMealForm({ ...mealForm, description: event.target.value })} /></Field>
          <div className="flex flex-wrap gap-2"><button className={primary} type="submit">{mealId ? 'Save meal' : 'Add meal'}</button>
            {meal && <button type="button" className={button} onClick={() => archive('meal')}>{meal.archived ? 'Restore meal' : 'Archive meal'}</button>}</div>
        </form>
        <form noValidate onSubmit={(event) => { event.preventDefault(); void saveIngredient(); }} className="space-y-4 rounded-2xl border bg-white p-5">
          <h4 className="text-lg font-bold">{ingredientId ? 'Edit ingredient' : 'Create ingredient'}</h4>
          <Field id="choose-ingredient" label="Choose ingredient"><select id="choose-ingredient" className={control} value={ingredientId} onChange={(event) => chooseIngredient(event.target.value)}>
            <option value="">New ingredient</option>{ingredients.filter((value) => showArchived || !value.archived || value.id === ingredientId).map((value) => <option key={value.id} value={value.id}>{value.name}{value.archived ? ' (archived)' : ''}</option>)}
          </select></Field>
          <Field id="ingredient-name" label="Ingredient name" error={field('ingredient', 'name')}><input id="ingredient-name" {...attributes('ingredient', 'name', 'ingredient-name')} className={control} value={ingredientForm.name} onChange={(event) => setIngredientForm({ ...ingredientForm, name: event.target.value })} /></Field>
          <Field id="ingredient-unit" label="Unit" error={field('ingredient', 'unit')}><select id="ingredient-unit" {...attributes('ingredient', 'unit', 'ingredient-unit')} className={control} value={ingredientForm.unit} onChange={(event) => setIngredientForm({ ...ingredientForm, unit: event.target.value })}>{['count', 'g', 'ml', 'oz', 'lb', 'gal'].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></Field>
          <p className="text-sm text-gray-600">An ingredient’s unit can only change before it has recipe or stock quantities.</p>
          <div className="flex flex-wrap gap-2"><button className={primary} type="submit">{ingredientId ? 'Save ingredient' : 'Add ingredient'}</button>
            {ingredient && <button type="button" className={button} onClick={() => archive('ingredient')}>{ingredient.archived ? 'Restore ingredient' : 'Archive ingredient'}</button>}</div>
        </form>
      </div>
      <section className="space-y-4 rounded-2xl border bg-white p-5">
        <h4 className="text-lg font-bold">{meal ? `Recipe for ${meal.name}` : 'Recipe'}</h4>
        {!meal ? <p>Choose or create a meal to edit its recipe.</p> : <>
          {meal.archived && <p className="text-amber-800">Restore this meal before changing its recipe.</p>}
          {recipeLoading && <p>Loading recipe…</p>}
          {recipeError && <button type="button" className={button} onClick={() => setRecipeRetry((old) => old + 1)}>Retry loading recipe</button>}
          <fieldset disabled={meal.archived || recipeLoading || recipeError} className="space-y-4">
            {!recipeLoading && !recipeError && !links.length && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">This meal has no recipe ingredients. Add them to enable saving and printing a complete shopping list.</p>}
            {links.map((link) => {
              const value = ingredients.find((item) => item.id === link.ingredientId);
              const name = value?.name || 'Missing ingredient';
              return <div key={link.id} className="flex flex-wrap items-end gap-3 rounded-lg bg-gray-50 p-3">
                <div className="min-w-48 flex-1"><Field id={`quantity-${link.id}`} label={`${name} quantity per person (${value?.unit || '?'})`} error={field(link.id, 'quantity')}>
                  <input id={`quantity-${link.id}`} {...attributes(link.id, 'quantity', `quantity-${link.id}`)} className={control} type="number" min="0.000001" step="any" value={quantities[link.id] ?? ''} onChange={(event) => setQuantities({ ...quantities, [link.id]: event.target.value })} />
                </Field>{value?.archived && <p className="text-sm text-amber-800">Archived ingredient — restore or remove it.</p>}</div>
                <button type="button" className={button} onClick={() => void saveQuantity(link)} aria-label={`Save quantity for ${name}`}>Save quantity</button>
                <button type="button" className={button} onClick={() => remove(link)} aria-label={`Remove ${name} from recipe`}>Remove</button>
              </div>;
            })}
            <form noValidate onSubmit={(event) => { event.preventDefault(); void assign(); }} className="space-y-3 border-t pt-4">
              <h5 className="font-semibold">Add ingredient to recipe</h5>
              <Field id="assign-ingredient" label="Recipe ingredient" error={field('assign', 'ingredientId')}><select id="assign-ingredient" {...attributes('assign', 'ingredientId', 'assign-ingredient')} className={control} value={assignment.ingredientId} onChange={(event) => setAssignment({ ...assignment, ingredientId: event.target.value })}>
                <option value="">Select an ingredient</option>{availableIngredients.map((value) => <option key={value.id} value={value.id}>{value.name} ({value.unit})</option>)}
              </select></Field>
              {!availableIngredients.length && <p className="text-sm text-gray-600">No unused active ingredients. Create an ingredient above, or edit an existing recipe quantity.</p>}
              <Field id="assign-quantity" label="Quantity per person" error={field('assign', 'quantity')}><input id="assign-quantity" {...attributes('assign', 'quantity', 'assign-quantity')} className={control} type="number" min="0.000001" step="any" value={assignment.quantity} onChange={(event) => setAssignment({ ...assignment, quantity: event.target.value })} /></Field>
              <button type="submit" className={primary} disabled={!availableIngredients.length}>Add to recipe</button>
            </form>
          </fieldset>
        </>}
      </section>
    </fieldset>
  </div>;
}
