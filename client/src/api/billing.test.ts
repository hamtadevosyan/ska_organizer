import { expect, test } from 'vitest';
import { billingCents, billingMoney } from './billing';

test.each([['0', 0], ['1.01', 101], ['1500.50', 150050], ['0.29', 29], ['999999999.99', 99999999999]])('money entry %s converts decimal digits to exact cents', (value, cents) => {
  expect(billingCents(String(value))).toBe(cents);
});
test.each(['', '-1', '1.001', '1e3', 'Infinity', 'NaN', ' 1.00', '.50', '1,000.00', '1000000000'])('ambiguous or out-of-range amount %j is rejected', value => {
  expect(billingCents(value)).toBeNull();
});
test('money displays two currency places rather than floating-point hour-like values', () => { expect(billingMoney(12525)).toBe('$125.25'); });
