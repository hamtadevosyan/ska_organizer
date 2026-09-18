const { amount, decimal } = require('../services/inventoryValidation');
const { convert } = require('../services/inventoryStock');

test.each([
  ['1', 'lb', 'g', '453.59237'], ['1', 'oz', 'g', '28.349523'],
  ['1000', 'g', 'lb', '2.204622'], ['1', 'gal', 'ml', '3785.411784'],
  ['0.123456', 'count', 'count', '0.123456'], ['0.3', 'pack', 'pack', '0.3'],
])('converts %s %s to %s without overstating available stock', (value, from, to, expected) => {
  expect(decimal(convert(amount(value), from, to))).toBe(expected);
});
test.each([['count', 'g'], ['pack', 'count'], ['box', 'pack'], ['gal', 'lb']])('rejects incompatible %s to %s conversions', (from, to) => {
  expect(() => convert(amount('1'), from, to)).toThrow('incompatible unit');
});
