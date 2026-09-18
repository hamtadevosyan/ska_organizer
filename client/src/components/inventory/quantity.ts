// Keep previews exact for the same six-decimal quantities accepted by the API.
export const validQuantity = (value: string) => /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value);
const scaled = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')); };
export function resultingQuantity(current: string, entered: string, action: string): string | null {
  if (!validQuantity(current) || !validQuantity(entered)) return null;
  const result = action === 'correction' ? scaled(entered) : scaled(current) + (action === 'usage' ? -1n : 1n) * scaled(entered);
  if (result < 0n || result >= 1000000000000000000n) return null;
  const fraction = (result % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (result / 1000000n).toString() + (fraction ? '.' + fraction : '');
}
export const unitNames: Record<string, string> = {
  count: 'pieces', lb: 'pounds (lb)', oz: 'ounces (oz)', g: 'grams (g)', gal: 'gallons (gal)', ml: 'milliliters (ml)', box: 'boxes', pack: 'packs',
};
