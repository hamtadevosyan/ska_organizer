import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import RecipePhotoImport from './RecipePhotoImport';
import { prepareRecipeImage } from './recipePhoto';

vi.mock('axios');
vi.mock('./recipePhoto', async () => ({ ...await vi.importActual('./recipePhoto'), prepareRecipeImage: vi.fn() }));
const text = 'Banana oat bowls\nServes 4\nIngredients\n120 g Oats\n400 ml Milk\n2 Bananas\nDirections\nMix.';
const select = () => fireEvent.change(screen.getByLabelText('Recipe image file'), { target: { files: [new File(['image'], 'recipe.png', { type: 'image/png' })] } });
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(prepareRecipeImage).mockResolvedValue('cG5n');
  vi.mocked(axios.post).mockResolvedValue({ data: { data: { text } } });
  vi.mocked(axios.isAxiosError).mockImplementation((value): value is import('axios').AxiosError => !!value && typeof value === 'object' && 'response' in value);
});

test('offers separate camera and upload inputs, reviews OCR, confirms servings and returns editable rows without saving', async () => {
  const onReady = vi.fn(); render(<RecipePhotoImport disabled={false} onReady={onReady} onCancel={vi.fn()} />);
  expect(screen.getByLabelText('Recipe camera image')).toHaveAttribute('capture', 'environment');
  expect(screen.getByLabelText('Recipe image file')).not.toHaveAttribute('capture');
  select(); await screen.findByLabelText('Recipe meal name');
  expect(screen.getByLabelText('Recipe meal name')).toHaveFocus();
  expect(screen.getByLabelText('Recipe makes how many servings?')).toHaveValue(4);
  fireEvent.click(screen.getByRole('button', { name: 'Use recipe in meal draft' }));
  expect(onReady).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Recipe meal name'), { target: { value: 'Our bowls' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Use recipe in meal draft' }));
  expect(onReady).toHaveBeenCalledWith('Our bowls', [
    { name: 'Oats', unit: 'g', quantity: '30', original: '120 g Oats' },
    { name: 'Milk', unit: 'ml', quantity: '100', original: '400 ml Milk' },
    { name: 'Bananas', unit: 'count', quantity: '0.5', original: '2 Bananas' },
  ]);
  expect(axios.post).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/api/meals/recipe-photo'), { image: 'cG5n' }, expect.objectContaining({ timeout: 45000 }));
});

test('requires missing yield and ingredient review, and editing resets the confirmation', async () => {
  vi.mocked(axios.post).mockResolvedValue({ data: { data: { text: 'Soup\nIngredients\nWater' } } });
  const onReady = vi.fn(); render(<RecipePhotoImport disabled={false} onReady={onReady} onCancel={vi.fn()} />);
  select(); await screen.findByLabelText('Recipe meal name');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Use recipe in meal draft' }));
  expect(screen.getByLabelText('Recipe makes how many servings?')).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(screen.getByLabelText('Recipe makes how many servings?'), { target: { value: '2' } });
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.change(screen.getByLabelText('Recipe ingredient lines'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use recipe in meal draft' }));
  expect(screen.getByLabelText('Recipe ingredient lines')).toHaveAttribute('aria-invalid', 'true');
  expect(onReady).not.toHaveBeenCalled();
});

test('failed reading can retry the same file and cancelling aborts a pending request', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce({ response: { data: { error: { message: 'Synthetic unreadable image' } } } });
  const onCancel = vi.fn(); const { unmount } = render(<RecipePhotoImport disabled={false} onReady={vi.fn()} onCancel={onCancel} />);
  select(); expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic unreadable image');
  let resolve: (value: unknown) => void = () => {};
  vi.mocked(axios.post).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  select(); await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: 'Upload recipe image' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel photo import' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing photo' }));
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel photo import' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard photo' }));
  expect(vi.mocked(axios.post).mock.calls[1][2]?.signal?.aborted).toBe(true);
  expect(onCancel).toHaveBeenCalledOnce(); unmount();
  await act(async () => resolve({ data: { data: { text } } }));
});

test('shows all seven source lines, detects eight servings and makes fraction corrections explicit', async () => {
  const ingredients = ['1 % cups flour', '3 Y2 teaspoons baking powder', '1 tablespoon sugar', 'Ys, teaspoon salt', '1 Y% cups milk', '3 tablespoons butter, melted', '1 large egg'];
  const source = ['broken heading', 'Original recipe (1X) yields 8 servings', ...ingredients];
  const lines = source.map((text, i) => ({ text, confidence: i ? 95 : 15, box: { x: 20, y: i * 80, width: 600, height: 40 } }));
  vi.mocked(axios.post).mockResolvedValue({ data: { data: { text: source.join('\n'), lines, width: 1000, height: 1500 } } });
  const onReady = vi.fn(); render(<RecipePhotoImport disabled={false} onReady={onReady} onCancel={vi.fn()} />);
  select(); await screen.findByLabelText('Recipe meal name');
  expect(screen.getByLabelText('Recipe meal name')).toHaveValue('');
  expect(screen.getByLabelText('Recipe makes how many servings?')).toHaveValue(8);
  expect(screen.getAllByRole('group', { name: /^Review ingredient/ })).toHaveLength(7);
  expect(screen.getAllByRole('img', { name: /^Photo of ingredient/ })).toHaveLength(7);
  expect(screen.getByLabelText('Ingredient line 6')).toHaveValue('3 tablespoons butter, melted');
  expect(screen.getByLabelText('Ingredient line 7')).toHaveValue('1 large egg');
  fireEvent.change(screen.getByLabelText('Recipe meal name'), { target: { value: 'Pancakes' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Use recipe in meal draft' }));
  expect(onReady).not.toHaveBeenCalled();
  for (const [index, amount] of [[1, '1 1/2'], [2, '3 1/2'], [4, '1/4'], [5, '1 1/4']]) {
    fireEvent.click(screen.getByRole('button', { name: `Use ${amount} for ingredient ${index}` }));
  }
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Use recipe in meal draft' }));
  expect(onReady).toHaveBeenCalledWith('Pancakes', expect.arrayContaining([
    expect.objectContaining({ original: '3 tablespoons butter, melted' }),
    expect.objectContaining({ name: 'large egg', quantity: '0.125', unit: 'count' }),
  ]));
  expect(onReady.mock.calls[0][1]).toHaveLength(7);
});

test('an oversized OCR ingredient list requests a smaller photo instead of silently dropping its end', async () => {
  vi.mocked(axios.post).mockResolvedValue({ data: { data: { text: 'Ingredients\n' + Array(51).fill('1 g Oats').join('\n') } } });
  render(<RecipePhotoImport disabled={false} onReady={vi.fn()} onCancel={vi.fn()} />);
  select();
  expect(await screen.findByRole('alert')).toHaveTextContent('more than 50 ingredient lines');
  expect(screen.queryByRole('button', { name: 'Use recipe in meal draft' })).not.toBeInTheDocument();
});
