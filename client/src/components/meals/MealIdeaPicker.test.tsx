import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { UnsavedChangesContext } from '../UnsavedChangesContext';
import MealIdeaPicker from './MealIdeaPicker';
import type { IngredientOption, MealIdeaSaveResult } from './MealIdeaPicker';
import { MEAL_IDEAS } from './mealIdeas';
import type { Meal } from './weeklyPlan';

vi.mock('axios');
const oats: IngredientOption = { id: 'oats', name: 'Oats', unit: 'g' };
const milk: IngredientOption = { id: 'milk', name: 'Milk', unit: 'ml' };
const savedMeal: Meal = { id: 'existing', name: 'Saved porridge', type: 'breakfast', description: 'Our original recipe' };
const recipe = [{ id: 'original-link', mealId: savedMeal.id, ingredientId: oats.id, quantity: 40 }];
const result: MealIdeaSaveResult = { meal: { id: 'new-meal', name: 'My porridge', type: 'breakfast', description: '' }, ingredients: [oats, milk],
  recipe: [{ id: 'new-link', mealId: 'new-meal', ingredientId: oats.id, quantity: 45 }] };
const response = (data: unknown) => ({ data: { data } });
function props(extra: Partial<Parameters<typeof MealIdeaPicker>[0]> = {}) {
  return { ingredients: [oats, milk], meals: [savedMeal], disabled: false, onSaved: vi.fn(), onEditingChange: vi.fn(), ...extra };
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }
function chooseOatmeal() {
  fireEvent.click(screen.getByRole('button', { name: 'Browse meal ideas' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose Oatmeal with banana' }));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(axios.isAxiosError).mockImplementation((error): error is import('axios').AxiosError => !!error && typeof error === 'object' && 'response' in error);
  vi.mocked(axios.get).mockResolvedValue(response(recipe));
  vi.mocked(axios.post).mockResolvedValue(response(result));
});

test('starts collapsed and searches names or ingredients with a meal type filter without writes', () => {
  render(<MealIdeaPicker {...props()} />);
  expect(screen.queryByLabelText('Search meal ideas')).not.toBeInTheDocument();
  const browse = screen.getByRole('button', { name: 'Browse meal ideas' });
  expect(browse).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(browse);
  expect(screen.getByLabelText('Search meal ideas')).toHaveFocus();
  change('Search meal ideas', '  BANANA  OATS ');
  expect(screen.getByRole('button', { name: 'Choose Oatmeal with banana' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Choose Chicken and rice' })).not.toBeInTheDocument();
  change('Meal idea type', 'lunch');
  expect(screen.getByText('No meals match your search. Try another name or meal type.')).toBeVisible();
  expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});

test('choosing fills a focused local draft, reuses unique compatible ingredients and leaves the starter unchanged', () => {
  const originals = JSON.stringify(MEAL_IDEAS);
  const callbacks = props(); render(<MealIdeaPicker {...callbacks} />); chooseOatmeal();
  expect(screen.getByRole('form', { name: 'Create meal from idea' })).toBeVisible();
  expect(screen.getByLabelText('Meal name')).toHaveValue('Oatmeal with banana');
  expect(screen.getByLabelText('Meal name')).toHaveFocus();
  expect(screen.getByLabelText('Meal type')).toHaveValue('breakfast');
  expect(screen.getByLabelText('Ingredient 1')).toHaveValue('oats');
  expect(screen.getByLabelText('Ingredient 1 quantity per person (g)')).toHaveValue(30);
  expect(screen.getByLabelText('Ingredient 2 name')).toHaveValue('Banana');
  expect(screen.getByLabelText('Ingredient 2 quantity per person (g)')).toHaveValue(60);
  expect(screen.getByLabelText('Ingredient 3')).toHaveValue('milk');
  expect(screen.getByLabelText('Ingredient 3 quantity per person (ml)')).toHaveValue(120);
  expect(callbacks.onEditingChange).toHaveBeenLastCalledWith(true);
  expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  change('Meal name', 'Changed draft'); change('Ingredient 1 quantity per person (g)', '45');
  expect(JSON.stringify(MEAL_IDEAS)).toBe(originals);
});

test('renames, changes type, adds and removes ingredients before saving the exact complete recipe once', async () => {
  const callbacks = props(); render(<MealIdeaPicker {...callbacks} />); chooseOatmeal();
  change('Meal name', '  Fruit porridge  '); change('Meal type', 'lunch'); change('Description', '  Our kitchen version  ');
  change('Ingredient 1 quantity per person (g)', '45');
  fireEvent.click(screen.getByRole('button', { name: 'Remove ingredient 3' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  change('Ingredient 3 name', ' Apple '); change('Ingredient 3 unit', 'g'); change('Ingredient 3 quantity per person (g)', '25');
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledExactlyOnceWith(result));
  expect(axios.post).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/api/meals/with-recipe'), {
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), meal: { name: 'Fruit porridge', type: 'lunch', description: 'Our kitchen version' },
    ingredients: [{ ingredientId: 'oats', quantity: 45 }, { name: 'Banana', unit: 'g', quantity: 60 }, { name: 'Apple', unit: 'g', quantity: 25 }],
  });
  expect(screen.queryByRole('form', { name: 'Create meal from idea' })).not.toBeInTheDocument();
  expect(callbacks.onEditingChange).toHaveBeenLastCalledWith(false);
});

test('uses an explicit ingredient choice and creates a separate ingredient when editing its name or unit', async () => {
  const callbacks = props({ ingredients: [oats, milk, { id: 'apple', name: 'Apple', unit: 'count' }] });
  render(<MealIdeaPicker {...callbacks} />); chooseOatmeal();
  change('Ingredient 2', 'apple');
  expect(screen.queryByLabelText('Ingredient 2 name')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Ingredient 2 quantity per person (count)')).toHaveValue(null);
  expect(screen.getByText('The unit changed. Enter the quantity in this unit; amounts are not converted automatically.')).toBeVisible();
  change('Ingredient 2 quantity per person (count)', '0.5');
  change('Ingredient 1', 'new'); change('Ingredient 1 name', 'Rolled oats'); change('Ingredient 1 unit', 'oz');
  expect(screen.getByLabelText('Ingredient 1 quantity per person (oz)')).toHaveValue(null);
  change('Ingredient 1 quantity per person (oz)', '1');
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ ingredients: [
    { name: 'Rolled oats', unit: 'oz', quantity: 1 }, { ingredientId: 'apple', quantity: 0.5 }, { ingredientId: 'milk', quantity: 120 },
  ] });
  expect(oats).toEqual({ id: 'oats', name: 'Oats', unit: 'g' });
  expect(axios.put).not.toHaveBeenCalled();
});

test('validates names, positive quantities, duplicates and empty recipes locally while preserving draft values', () => {
  render(<MealIdeaPicker {...props()} />); chooseOatmeal();
  change('Meal name', ' '); change('Ingredient 1 quantity per person (g)', '0'); change('Ingredient 2 name', '');
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  expect(screen.getByLabelText('Meal name')).toHaveAccessibleDescription('Enter a meal name between 1 and 255 characters.');
  expect(screen.getByLabelText('Ingredient 1 quantity per person (g)')).toHaveAccessibleDescription('Enter a positive quantity with at most six decimal places.');
  expect(screen.getByLabelText('Ingredient 2 name')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Ingredient 1 quantity per person (g)')).toHaveValue(0);
  change('Meal name', 'My porridge'); change('Ingredient 1 quantity per person (g)', '30'); change('Ingredient 2', 'oats');
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  expect(screen.getByLabelText('Ingredient 2')).toHaveAccessibleDescription('This ingredient is already listed. Combine its quantities in one row.');
  for (let index = 3; index > 0; index--) fireEvent.click(screen.getByRole('button', { name: `Remove ingredient ${index}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  expect(screen.getByText('Add at least one ingredient to this recipe.')).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});

test('retains server field errors and edits, then retries with the same request ID', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce({ response: { status: 400, data: { error: { message: 'Review the recipe.', fields: {
    'meal.name': 'Use a more specific meal name.', 'meal.type': 'Confirm the meal type.', 'meal.description': 'Confirm the description.',
    'ingredients.1.name': 'Use a more specific ingredient name.', 'ingredients.1.unit': 'Confirm the unit.', 'ingredients.1.quantity': 'Confirm the amount.',
  } } } } });
  const callbacks = props(); render(<MealIdeaPicker {...callbacks} />); chooseOatmeal();
  change('Meal name', 'My porridge');
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Meal name')).toHaveValue('My porridge');
  expect(screen.getByLabelText('Meal name')).toHaveAccessibleDescription('Use a more specific meal name.');
  expect(screen.getByLabelText('Meal type')).toHaveAccessibleDescription('Confirm the meal type.');
  expect(screen.getByLabelText('Description')).toHaveAccessibleDescription('Confirm the description.');
  expect(screen.getByLabelText('Ingredient 2 name')).toHaveAccessibleDescription('Use a more specific ingredient name.');
  expect(screen.getByLabelText('Ingredient 2 unit')).toHaveAccessibleDescription('Confirm the unit.');
  expect(screen.getByLabelText('Ingredient 2 quantity per person (g)')).toHaveAccessibleDescription('Confirm the amount.');
  expect(callbacks.onSaved).not.toHaveBeenCalled();
  change('Ingredient 2 name', 'Ripe banana');
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  const bodies = vi.mocked(axios.post).mock.calls.map(call => call[1] as { requestId: string });
  expect(bodies[1].requestId).toBe(bodies[0].requestId);
  expect(axios.post).toHaveBeenCalledTimes(2);
});

test('a lost save response retains the exact request for retry and blocks duplicate submits while saving', async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(axios.post).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const report = vi.fn(); const callbacks = props();
  render(<UnsavedChangesContext.Provider value={report}><MealIdeaPicker {...callbacks} /></UnsavedChangesContext.Provider>);
  chooseOatmeal();
  const form = screen.getByRole('form', { name: 'Create meal from idea' });
  fireEvent.submit(form); fireEvent.submit(form);
  expect(axios.post).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByLabelText('Meal name')).toBeDisabled();
  expect(report).toHaveBeenLastCalledWith(true, true);
  await act(async () => reject(new Error('Synthetic lost response')));
  await screen.findByText('Could not save this meal. Your changes are still here. Try saving again.');
  const first = vi.mocked(axios.post).mock.calls[0][1];
  expect(report).toHaveBeenLastCalledWith(true, false);
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  expect(vi.mocked(axios.post).mock.calls[1][1]).toEqual(first);
  expect(report).toHaveBeenLastCalledWith(false, false);
});

test('copies a saved recipe through GET, permits renaming and never edits the original meal or links', async () => {
  const originals = JSON.stringify({ savedMeal, recipe, oats });
  const callbacks = props({ meals: [savedMeal, { ...savedMeal, id: 'old', name: 'Archived porridge', archived: true }] });
  render(<MealIdeaPicker {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Browse meal ideas' }));
  fireEvent.click(screen.getByRole('button', { name: 'Saved meals' }));
  expect(screen.queryByRole('button', { name: 'Copy Archived porridge' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Saved porridge' }));
  await screen.findByRole('form', { name: 'Create meal from idea' });
  expect(axios.get).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/api/meals/existing/ingredients'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.getByLabelText('Meal name')).toHaveValue('Saved porridge copy');
  expect(screen.getByLabelText('Description')).toHaveValue('Our original recipe');
  expect(screen.getByLabelText('Ingredient 1 quantity per person (g)')).toHaveValue(40);
  expect(axios.post).not.toHaveBeenCalled();
  change('Meal name', 'New porridge'); change('Ingredient 1 quantity per person (g)', '45');
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ meal: { name: 'New porridge' }, ingredients: [{ ingredientId: 'oats', quantity: 45 }] });
  expect(JSON.stringify({ savedMeal, recipe, oats })).toBe(originals);
  expect(axios.put).not.toHaveBeenCalled(); expect(axios.delete).not.toHaveBeenCalled();
});

test('a saved-recipe load failure leaves choices available and can be retried without a write', async () => {
  vi.mocked(axios.get).mockRejectedValueOnce(new Error('Synthetic outage'));
  render(<MealIdeaPicker {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Browse meal ideas' }));
  fireEvent.click(screen.getByRole('button', { name: 'Saved meals' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy Saved porridge' }));
  await screen.findByText('Could not load this recipe. Choose the saved meal again to retry.');
  expect(screen.queryByRole('form', { name: 'Create meal from idea' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Saved porridge' }));
  await screen.findByLabelText('Meal name');
  expect(axios.get).toHaveBeenCalledTimes(2); expect(axios.post).not.toHaveBeenCalled();
});

test('ambiguous, archived and mismatched units require an explicit choice without converting quantities', async () => {
  const callbacks = props({ ingredients: [oats, { ...oats, id: 'other-oats' }, { id: 'banana', name: 'Banana', unit: 'count' }, { ...milk, archived: true }] });
  render(<MealIdeaPicker {...callbacks} />); chooseOatmeal();
  for (let index = 1; index <= 3; index++) expect(screen.getByLabelText(`Ingredient ${index}`)).toHaveValue('unresolved');
  expect(within(screen.getByLabelText('Ingredient 3')).queryByRole('option', { name: 'Milk (ml)' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  expect(screen.getByLabelText('Ingredient 1')).toHaveAccessibleDescription('Choose an ingredient or choose to create a new one.');
  expect(axios.post).not.toHaveBeenCalled();
  change('Ingredient 1', 'other-oats'); change('Ingredient 2', 'new'); change('Ingredient 3', 'new');
  expect(screen.getByLabelText('Ingredient 2 quantity per person (g)')).toHaveValue(60);
  expect(screen.getByLabelText('Ingredient 3 quantity per person (ml)')).toHaveValue(120);
  fireEvent.click(screen.getByRole('button', { name: 'Save meal & recipe' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ ingredients: [
    { ingredientId: 'other-oats', quantity: 30 }, { name: 'Banana', unit: 'g', quantity: 60 }, { name: 'Milk', unit: 'ml', quantity: 120 },
  ] });
});

test('copying an archived ingredient does not silently substitute another active ingredient with the same name', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce(response([{ ...recipe[0], ingredientId: 'old-oats' }]));
  render(<MealIdeaPicker {...props({ ingredients: [oats, { ...oats, id: 'old-oats', archived: true }] })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Browse meal ideas' })); fireEvent.click(screen.getByRole('button', { name: 'Saved meals' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy Saved porridge' }));
  await screen.findByLabelText('Meal name');
  expect(screen.getByLabelText('Ingredient 1')).toHaveValue('unresolved');
  expect(screen.getByLabelText('Ingredient 1 quantity per person (g)')).toHaveValue(40);
  expect(axios.post).not.toHaveBeenCalled();
});

test('cancel offers Keep editing or Discard meal and clears route and beforeunload protection without writes', () => {
  const callbacks = props(); const report = vi.fn();
  const { unmount } = render(<UnsavedChangesContext.Provider value={report}><MealIdeaPicker {...callbacks} /></UnsavedChangesContext.Provider>);
  chooseOatmeal(); change('Meal name', 'Keep my changes');
  const warning = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(warning);
  expect(warning.defaultPrevented).toBe(true); expect(report).toHaveBeenLastCalledWith(true, false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const confirmation = screen.getByRole('group', { name: 'Discard meal draft' });
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Meal name')).toHaveValue('Keep my changes');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard meal' }));
  expect(callbacks.onEditingChange).toHaveBeenLastCalledWith(false); expect(report).toHaveBeenLastCalledWith(false, false);
  const after = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
  expect(screen.getByRole('button', { name: 'Browse meal ideas' })).toHaveFocus();
  expect(axios.post).not.toHaveBeenCalled(); expect(axios.delete).not.toHaveBeenCalled();
  chooseOatmeal(); unmount(); expect(callbacks.onEditingChange).toHaveBeenLastCalledWith(false); expect(report).toHaveBeenLastCalledWith(false, false);
});

test('disabled state blocks browsing and freezes an existing draft without discarding its entries', () => {
  const callbacks = props(); const { rerender } = render(<MealIdeaPicker {...callbacks} disabled />);
  expect(screen.getByRole('button', { name: 'Browse meal ideas' })).toBeDisabled();
  rerender(<MealIdeaPicker {...callbacks} />); chooseOatmeal(); change('Meal name', 'Keep it');
  rerender(<MealIdeaPicker {...callbacks} disabled />);
  expect(screen.getByLabelText('Meal name')).toHaveValue('Keep it'); expect(screen.getByLabelText('Meal name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save meal & recipe' })).toBeDisabled();
  expect(axios.post).not.toHaveBeenCalled();
});
