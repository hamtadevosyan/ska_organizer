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
