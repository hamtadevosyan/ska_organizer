import { SignedIn } from '../../tests/authFixture';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import MealSetup from './MealSetup';
import Meals from '../../pages/Meals';

vi.mock('axios');
vi.mock('./MealPlanner', () => ({ default: () => <div>Planner view</div> }));
const meal = { id: 'meal', name: 'Egg breakfast', type: 'breakfast', description: '' };
const eggs = { id: 'eggs', name: 'Eggs', unit: 'count' };
const milk = { id: 'milk', name: 'Milk', unit: 'ml' };
const old = { id: 'old', name: 'Old flour', unit: 'g', archived: true };
const link = { id: 'link', ingredientId: 'eggs', quantity: 1 };
const response = (data: unknown) => ({ data: { data } });
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function editor() {
  render(<MealSetup initialMealId="meal" />);
  await screen.findByLabelText('Eggs quantity per person (count)');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save quantity for Eggs' })).toBeEnabled());
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.isAxiosError).mockImplementation((error): error is import('axios').AxiosError => !!error && typeof error === 'object' && 'response' in error);
  vi.mocked(axios.get).mockImplementation(async (path) => response(path.includes('meals?') ? [meal] : path.includes('ingredients?') ? [eggs, milk, old] : [link]));
  vi.mocked(axios.put).mockImplementation(async (path, body) => response({ ...(path.includes('/meals/ingredients/') ? link : path.includes('/meals/') ? meal : eggs), ...body as object }));
  vi.mocked(axios.delete).mockResolvedValue(response({ deleted: true }));
});

describe('catalog corrections', () => {
  it('edits meal names, types and descriptions on the existing ID', async () => {
    await editor();
    change('Meal name', 'Egg lunch'); change('Meal type', 'lunch'); change('Description', 'With toast');
    fireEvent.click(screen.getByRole('button', { name: 'Save meal' }));
    await screen.findByText('Meal updated.');
    expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/meals/meal'), { name: 'Egg lunch', type: 'lunch', description: 'With toast' });
    expect(screen.getByRole('heading', { name: 'Recipe for Egg lunch' })).toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('prevents duplicate or archived assignments and edits an existing quantity', async () => {
    await editor();
    const choices = within(screen.getByRole('combobox', { name: 'Recipe ingredient' }));
    expect(choices.queryByRole('option', { name: 'Eggs (count)' })).not.toBeInTheDocument();
    expect(choices.queryByRole('option', { name: 'Old flour (g)' })).not.toBeInTheDocument();
    expect(choices.getByRole('option', { name: 'Milk (ml)' })).toBeInTheDocument();
    change('Eggs quantity per person (count)', '2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Save quantity for Eggs' }));
    await screen.findByText('Recipe quantity updated.');
    expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/meals/ingredients/link'), { quantity: 2.5 });
  });

  it('asks before removing a link and makes that ingredient assignable again', async () => {
    await editor();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Eggs from recipe' }));
    expect(axios.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Eggs from recipe' }));
    await screen.findByText('Ingredient removed from this recipe.');
    expect(axios.delete).toHaveBeenCalledWith(expect.stringContaining('/meals/ingredients/link'));
    expect(screen.queryByLabelText('Eggs quantity per person (count)')).not.toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'Recipe ingredient' })).getByRole('option', { name: 'Eggs (count)' })).toBeInTheDocument();
    expect(screen.getByText(/This meal has no recipe ingredients/)).toBeInTheDocument();
  });

  it('confirms archiving, disables recipe edits and restores a meal', async () => {
    await editor();
    fireEvent.click(screen.getByRole('button', { name: 'Archive meal' }));
    await screen.findByText('Meal archived.');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Archive Egg breakfast?'));
    expect(screen.getByRole('button', { name: 'Save quantity for Eggs' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore meal' }));
    await screen.findByText('Meal restored.');
    expect(screen.getByRole('button', { name: 'Save quantity for Eggs' })).toBeEnabled();
  });

  it('preserves the ingredient form and displays a blocked unit change beside the field', async () => {
    await editor(); change('Choose ingredient', 'eggs'); change('Unit', 'g');
    vi.mocked(axios.put).mockRejectedValueOnce({ response: { status: 409, data: { error: { message: 'Unit cannot change.', fields: { unit: 'Already used in recipes or stock.' } } } } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ingredient' }));
    await screen.findByText('Already used in recipes or stock.');
    expect(screen.getByLabelText('Unit')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Unit')).toHaveValue('g');
    expect(screen.getByLabelText('Ingredient name')).toHaveValue('Eggs');
  });

  it('shows quantity validation at its recipe row and retains the rejected input', async () => {
    await editor(); change('Eggs quantity per person (count)', '0');
    vi.mocked(axios.put).mockRejectedValueOnce({ response: { status: 400, data: { error: { message: 'Invalid quantity.', fields: { quantity: 'Quantity must be positive.' } } } } });
    fireEvent.click(screen.getByRole('button', { name: 'Save quantity for Eggs' }));
    await screen.findByText('Quantity must be positive.');
    expect(screen.getByLabelText('Eggs quantity per person (count)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Eggs quantity per person (count)')).toHaveValue(0);
  });
});


it('waits for a catalog write before allowing a return to Planner', async () => {
  let complete!: (value: ReturnType<typeof response>) => void;
  vi.mocked(axios.put).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  render(<SignedIn><Meals /></SignedIn>);
  fireEvent.click(screen.getByRole('button', { name: 'Meal Setup' }));
  await waitFor(() => expect(screen.getByLabelText('Choose meal')).toBeEnabled());
  change('Choose meal', 'meal');
  await screen.findByLabelText('Eggs quantity per person (count)');
  fireEvent.click(screen.getByRole('button', { name: 'Save meal' }));
  expect(screen.getByRole('button', { name: 'Planner' })).toBeDisabled();
  complete(response(meal));
  await screen.findByText('Meal updated.');
  expect(screen.getByRole('button', { name: 'Planner' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Planner' }));
  expect(screen.getByText('Planner view')).toBeVisible();
});
