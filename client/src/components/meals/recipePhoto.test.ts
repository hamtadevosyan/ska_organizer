import { expect, test } from 'vitest';
import { ingredientLines, prepareRecipeImage, reviewRecipeText } from './recipePhoto';

test('extracts a reviewable title, serving count and ingredient section without cooking instructions', () => {
  expect(reviewRecipeText('Banana bowls\nServes 4\n\nIngredients:\n• 120 g Oats\n400 ml Milk\n2 Bananas\nDirections\nMix and serve.')).toEqual({
    name: 'Banana bowls', servings: '4', ingredients: '120 g Oats\n400 ml Milk\n2 Bananas',
  });
  expect(reviewRecipeText('Ingredients\n120 g Oats\nMilk to taste')).toMatchObject({ name: '', servings: '', ingredients: '120 g Oats\nMilk to taste' });
  expect(reviewRecipeText('120 g Oats\n400 ml Milk')).toMatchObject({ name: '', servings: '', ingredients: '120 g Oats\n400 ml Milk' });
});

test('divides supported measures and counts by the confirmed recipe yield, including fractions', () => {
  expect(ingredientLines('120g Oats\n400 milliliters Milk\n2 Bananas\n1 1/2 oz Cheese\n½ lb Rice', 4).map(({ name, unit, quantity }) => ({ name, unit, quantity }))).toEqual([
    { name: 'Oats', unit: 'g', quantity: '30' }, { name: 'Milk', unit: 'ml', quantity: '100' },
    { name: 'Bananas', unit: 'count', quantity: '0.5' }, { name: 'Cheese', unit: 'oz', quantity: '0.375' },
    { name: 'Rice', unit: 'lb', quantity: '0.125' },
  ]);
});

test.each(['1 cup flour', '2 tbsp oil', 'a pinch of salt', '1-2 eggs', '-20 g sugar', '1 (400 g) can beans', '2 fl oz milk', '1/0 g oats', '0 g oats'])('keeps uncertain measure visible and never invents a valid amount: %s', line => {
  const [parsed] = ingredientLines(line, 4);
  expect(parsed.original).toBe(line);
  expect(parsed.quantity).toBe('');
});

test('retains unnumbered ingredients, and does not silently cap long ingredient lists', () => {
  expect(ingredientLines('Milk\nBananas', 4)).toEqual([
    { name: 'Milk', unit: '', quantity: '', original: 'Milk' }, { name: 'Bananas', unit: '', quantity: '', original: 'Bananas' },
  ]);
  expect(ingredientLines(Array(51).fill('1 g Oats').join('\n'), 1)).toHaveLength(51);
});

test('keeps gallons distinct from grams, with no unit conversion', () => {
  expect(ingredientLines('2 gal milk\n2 grams oats', 4).map(row => ({ unit: row.unit, quantity: row.quantity }))).toEqual([
    { unit: 'gal', quantity: '0.5' }, { unit: 'g', quantity: '0.5' },
  ]);
});

test('rejects nonphotos, SVG and oversized uploads before browser decoding or network requests', async () => {
  await expect(prepareRecipeImage(new File(['text'], 'recipe.txt', { type: 'text/plain' }))).rejects.toThrow('recipe photo');
  await expect(prepareRecipeImage(new File(['<svg/>'], 'recipe.svg', { type: 'image/svg+xml' }))).rejects.toThrow('recipe photo');
  const large = new File(['x'], 'recipe.png', { type: 'image/png' });
  Object.defineProperty(large, 'size', { value: 21 * 1024 * 1024 });
  await expect(prepareRecipeImage(large)).rejects.toThrow('under 20 MB');
});
