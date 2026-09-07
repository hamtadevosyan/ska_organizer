export const MEAL_TYPES = ['breakfast', 'snack', 'lunch', 'afternoonSnack'] as const;
export type MealType = (typeof MEAL_TYPES)[number];
export type Meal = { id: string; name: string; type: MealType; description?: string };
export type MenuDay = { day: string; menu: Partial<Record<MealType, Meal>> };
export type ShoppingItem = {
  ingredient: { id: string; name: string; unit: string };
  quantity: number; inStorage: number; toBuy: number;
};
export type Plan = {
  weekStart: string; week: MenuDay[]; childrenCount: number; staffCount: number;
  inHouse: Record<string, number>; items: ShoppingItem[]; version: number;
  savedAt?: string; previewToken?: string;
};
export type Draft = {
  week: MenuDay[]; childrenCount: string; staffCount: string;
  inHouse: Record<string, number | ''>; version: number;
};
export function mondayOf(date: string) {
  const day = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(day.getTime())) return '';
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}
export function currentMonday() {
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return mondayOf(localDate);
}
export const fromPlan = (plan: Plan): Draft => ({ week: plan.week,
  childrenCount: String(plan.childrenCount), staffCount: String(plan.staffCount),
  inHouse: plan.inHouse, version: plan.version });
export function validationError(draft: Draft) {
  const counts = [draft.childrenCount, draft.staffCount];
  if (!counts.every((n) => n.trim() !== '' && Number.isSafeInteger(Number(n)) && Number(n) >= 0) ||
      !Number.isSafeInteger(Number(counts[0]) + Number(counts[1])) || Number(counts[0]) + Number(counts[1]) <= 0) {
    return 'Child and staff counts must be non-negative whole numbers with a positive total.';
  }
  if (!Object.values(draft.inHouse).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    return 'In-house quantities must be non-negative numbers.';
  }
  return '';
}
