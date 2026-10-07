import { describe, expect, it } from 'vitest';
import { MEAL_IDEAS } from './mealIdeas';
import { MEAL_TYPES } from './weeklyPlan';

describe('bundled meal ideas', () => {
  it('offers each meal type and valid per-person ingredients without shared duplicate rows', () => {
    expect(MEAL_IDEAS.length).toBe(20);
    expect(new Set(MEAL_IDEAS.map((idea) => idea.id)).size).toBe(MEAL_IDEAS.length);
    expect(new Set(MEAL_IDEAS.map((idea) => idea.name)).size).toBe(MEAL_IDEAS.length);
    expect(new Set(MEAL_IDEAS.map((idea) => idea.type))).toEqual(new Set(MEAL_TYPES));
    for (const idea of MEAL_IDEAS) {
      expect(idea.name.trim().length).toBeGreaterThan(0);
      expect(idea.ingredients.length).toBeGreaterThan(0);
      expect(new Set(idea.ingredients.map((row) => `${row.name.toLowerCase()}|${row.unit}`)).size).toBe(idea.ingredients.length);
      for (const row of idea.ingredients) {
        expect(row.name.trim().length).toBeGreaterThan(0);
        expect(['count', 'g', 'ml', 'oz', 'lb', 'gal']).toContain(row.unit);
        expect(Number.isFinite(row.quantity)).toBe(true);
        expect(row.quantity).toBeGreaterThan(0);
        expect(Number(row.quantity.toFixed(6))).toBe(row.quantity);
      }
    }
  });
});
