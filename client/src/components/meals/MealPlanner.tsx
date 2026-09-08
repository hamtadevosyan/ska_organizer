import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import {
  Database,
  Loader2,
  PackageCheck,
  Printer,
  RefreshCw,
  Save,
  ShoppingCart,
} from 'lucide-react';
import { API_BASE_URL } from '../../lib/api';

import { MEAL_TYPES } from './weeklyPlan';
import type { Meal, MealType, ShoppingItem } from './weeklyPlan';
import { useWeeklyPlan } from './useWeeklyPlan';

type MessageType = 'success' | 'error' | 'info';

const MEAL_SLOTS: Array<{ key: MealType; label: string }> = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'snack', label: 'Morning Snack' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'afternoonSnack', label: 'Afternoon Snack' },
];

const isMealType = (value: string): value is MealType =>
  MEAL_TYPES.includes(value as MealType);

const getErrorMessage = (err: unknown, fallback: string) => {
  if (axios.isAxiosError(err)) {
    return err.response?.data?.error?.message || err.response?.data?.message || fallback;
  }

  return err instanceof Error ? err.message : fallback;
};

const getIngredientId = (item: ShoppingItem) => item.ingredient.id;
const getIngredientName = (item: ShoppingItem) => item.ingredient.name;
const getIngredientUnit = (item: ShoppingItem) => item.ingredient.unit;

const convertToUS = (
  quantity: number,
  sourceUnit: string,
  preferredUnit?: string
) => {
  const safeQuantity = Number.isFinite(quantity) ? quantity : 0;

  if (sourceUnit === 'g') {
    const targetUnit =
      preferredUnit === 'lb' || preferredUnit === 'oz'
        ? preferredUnit
        : Math.abs(safeQuantity) >= 453.592
          ? 'lb'
          : 'oz';

    return targetUnit === 'lb'
      ? { value: (safeQuantity / 453.592).toFixed(2), unit: 'lb' }
      : { value: (safeQuantity / 28.3495).toFixed(1), unit: 'oz' };
  }

  if (sourceUnit === 'ml') {
    return {
      value: (safeQuantity / 3785.41).toFixed(3),
      unit: 'gal',
    };
  }

  return { value: String(safeQuantity), unit: sourceUnit };
};

const convertFromUS = (
  quantity: number,
  displayedUnit: string,
  sourceUnit: string
) => {
  if (!Number.isFinite(quantity)) return 0;

  if (sourceUnit === 'g' && displayedUnit === 'lb') {
    return quantity * 453.592;
  }

  if (sourceUnit === 'g' && displayedUnit === 'oz') {
    return quantity * 28.3495;
  }

  if (sourceUnit === 'ml' && displayedUnit === 'gal') {
    return quantity * 3785.41;
  }

  return quantity;
};

const MealPlanner = ({ active = true }: { active?: boolean }) => {
  const planner = useWeeklyPlan();
  const { entry, update, isBusy, actionLoading, ready } = planner;
  const { week: weeklyMenu, childrenCount, staffCount, inHouse: inStock } = entry.draft;
  const { message, messageType } = entry;
  const hasSaved = !!entry.savedAt && !entry.dirty;
  const shoppingItems = entry.preview?.items || [];
  const finalShoppingItems = ready ? shoppingItems : [];
  const shoppingLoading = entry.loaded && weeklyMenu.length > 0 && !ready && !entry.calculationError && !planner.invalid;
  const [availableMeals, setAvailableMeals] = useState<Meal[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  useEffect(() => {
    if (!active) return;
    let current = true;
    const controller = new AbortController();
    setCatalogLoading(true);
    axios.get(`${API_BASE_URL}/api/meals`, { signal: controller.signal }).then(({ data }) => {
      if (current) { setAvailableMeals(data.data); setCatalogError(''); }
    }).catch((error: unknown) => {
      if (current) setCatalogError(getErrorMessage(error, 'Could not load the meal catalog.'));
    }).finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [active]);
  const mealsByType = useMemo(() => Object.fromEntries(MEAL_TYPES.map((type) =>
    [type, availableMeals.filter((meal) => isMealType(meal.type) && meal.type === type)]
  )) as Record<MealType, Meal[]>, [availableMeals]);
  const updateMealSelection = (dayIndex: number, type: MealType, id: string) => {
    const meal = availableMeals.find((option) => option.id === id && option.type === type);
    if (!meal) return;
    update({ week: weeklyMenu.map((day, index) => index === dayIndex ? { ...day, menu: { ...day.menu, [type]: meal } } : day) });
  };
  const clearInStock = () => update({ inHouse: {} });
  const generateMenu = () => { void planner.generate(); };
  const saveMenu = () => { void planner.save(); };

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-emerald-100 bg-white p-5 shadow-sm print:hidden">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-emerald-700">
              <Database size={17} />
              Weekly meal planner
            </div>
            <h3 className="mt-2 text-2xl font-bold text-gray-900">
              Generate, adjust, save, and print
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">
              Choose a week to reopen its menu, headcounts and stock. Drafts stay here when you switch weeks or tabs.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ActionButton
              label="Generate Menu"
              icon={<RefreshCw size={18} />}
              loading={actionLoading === 'generate'}
              disabled={isBusy || catalogLoading}
              onClick={generateMenu}
            />
            <ActionButton
              label="Save Menu"
              icon={<Save size={18} />}
              loading={actionLoading === 'save'}
              disabled={isBusy || !ready}
              onClick={saveMenu}
            />
            <ActionButton
              label="Print List"
              icon={<Printer size={18} />}
              loading={false}
              disabled={isBusy || !ready || finalShoppingItems.length === 0}
              onClick={() => window.print()}
            />
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm flex flex-wrap items-end gap-4 print:hidden">
        <label className="text-sm font-semibold text-gray-700">
          Week starting Monday
          <input type="date" aria-label="Week starting Monday" value={planner.weekStart}
            disabled={actionLoading !== null} onChange={(event) => planner.selectWeek(event.target.value)}
            className="mt-2 block rounded-xl border border-gray-200 px-4 py-2" />
        </label>
        <button type="button" disabled={actionLoading !== null} onClick={planner.reopen}
          className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold">
          {entry.loadError ? 'Retry loading week' : 'Reopen saved week'}
        </button>
        <p className="text-xs text-gray-500">Choose any date; the plan starts on that week’s Monday.</p>
      </section>
      {entry.loadError && <MessageBox message={entry.loadError} type="error" />}
      {planner.invalid && <MessageBox message={planner.invalid} type="error" />}
      {entry.calculationError && <div className="print:hidden">
        <MessageBox message={entry.calculationError} type="error" />
        <button type="button" onClick={planner.recalculate} className="mt-2 font-semibold text-emerald-700">Retry calculation</button>
      </div>}
      {message && <MessageBox message={message} type={messageType} />}

      {catalogError && <MessageBox message={catalogError} type="error" />}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3 print:hidden">
        <InfoCard
          title="Children"
          value={childrenCount}
          onChange={(value) => update({ childrenCount: value })}
          disabled={isBusy}
        />
        <InfoCard
          title="Staff"
          value={staffCount}
          onChange={(value) => update({ staffCount: value })}
          disabled={isBusy}
        />
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Status</p>
          <p className="mt-2 text-lg font-bold text-gray-800">
            {!entry.loaded ? 'Loading week…' : hasSaved ? 'Saved' : entry.dirty ? 'Draft — unsaved changes' : 'Not started'}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {shoppingLoading
              ? 'Updating the shopping list…'
              : `${availableMeals.length} meals available in the catalog.`}
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr] print:hidden">
        <div className="rounded-3xl border border-gray-100 bg-white p-6 shadow-sm">
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-2xl font-bold text-gray-800">
                Editable Weekly Menu
              </h3>
              <p className="text-sm text-gray-500">
                Choose a saved meal for every day and meal period.
              </p>
            </div>
            {catalogLoading && (
              <span className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="animate-spin" size={16} />
                Loading meals
              </span>
            )}
          </div>

          {weeklyMenu.length === 0 ? (
            <div>
              <EmptyState title="No menu yet" description="Click Generate Menu to create this week’s plan." />
              <button type="button" disabled={isBusy} onClick={() => { void planner.generate(true); }}
                className="mt-4 text-sm font-semibold text-emerald-700 disabled:opacity-50">
                Use earlier undated menu
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {weeklyMenu.map((day, dayIndex) => (
                <div
                  key={day.day}
                  className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-4"
                >
                  <h4 className="mb-4 text-lg font-bold text-emerald-700">
                    {day.day}
                  </h4>

                  {MEAL_SLOTS.map((slot) => (
                    <MealSelectLine
                      key={slot.key}
                      label={slot.label}
                      value={day.menu[slot.key]?.id || ''}
                      currentMeal={day.menu[slot.key]}
                      options={mealsByType[slot.key]}
                      disabled={isBusy || catalogLoading}
                      onChange={(mealId) =>
                        updateMealSelection(dayIndex, slot.key, mealId)
                      }
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-gray-100 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-2xl font-bold text-gray-800">Shopping Items</h3>
              <p className="text-sm text-gray-500">
                Enter the amount already in house.
              </p>
            </div>

            <div className="flex items-center gap-3">
              {shoppingLoading && (
                <Loader2 className="animate-spin text-emerald-600" size={18} />
              )}
              {shoppingItems.length > 0 && (
                <button
                  type="button"
                  onClick={clearInStock}
                  disabled={isBusy}
                  className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          {shoppingItems.length === 0 ? (
            <EmptyState
              title="No shopping items yet"
              description={
                weeklyMenu.length === 0
                  ? 'Generate a menu first.'
                  : 'Add recipe ingredients in Meal Setup or wait for the list to refresh.'
              }
            />
          ) : (
            <div className="space-y-3">
              {shoppingItems.map((item) => {
                const itemId = getIngredientId(item);
                const sourceUnit = getIngredientUnit(item);
                const needed = convertToUS(item.quantity, sourceUnit);
                const stockRaw = Number(inStock[itemId]) || 0;
                const stock = convertToUS(stockRaw, sourceUnit, needed.unit);
                const buyRaw = Math.max(item.quantity - stockRaw, 0);
                const buy = convertToUS(buyRaw, sourceUnit, needed.unit);

                return (
                  <div
                    key={itemId}
                    className="rounded-2xl border border-gray-100 bg-gray-50 p-4"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="font-semibold text-gray-900">
                          {getIngredientName(item)}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Needed: {ready ? `${needed.value} ${needed.unit}` : 'Awaiting calculation'}
                        </p>
                        <p
                          className={`mt-1 text-xs font-semibold ${
                            buyRaw > 0
                              ? 'text-emerald-700'
                              : 'text-gray-400 line-through'
                          }`}
                        >
                          Buy: {ready ? `${buy.value} ${buy.unit}` : 'Awaiting calculation'}
                        </p>
                      </div>

                      <div className="text-left sm:text-right">
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                          In house
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            disabled={isBusy}
                            aria-label={`${getIngredientName(item)} in house (${needed.unit})`}
                            value={inStock[itemId] === '' ? '' : Number(stock.value)}
                            onChange={(event) => {
                              const value = event.target.value;
                              update({ inHouse: { ...inStock, [itemId]: value === '' ? '' : convertFromUS(
                                Number(value), needed.unit, sourceUnit,
                              ) } });
                            }}
                            className="w-24 rounded-xl border border-gray-200 px-3 py-2 text-right font-semibold outline-none focus:border-emerald-500 disabled:bg-gray-100"
                          />
                          <span className="text-sm text-gray-500">{needed.unit}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-3xl bg-slate-950 p-6 text-white shadow-xl print:bg-white print:text-black print:shadow-none">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShoppingCart size={22} />
              <h3 className="text-2xl font-bold">Printable Shopping List</h3>
            </div>
            <p className="mt-1 text-sm text-slate-300 print:text-gray-600">
              Week of {planner.weekStart} · {childrenCount} children · {staffCount} staff. Quantities after subtracting stock.
            </p>
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <PackageCheck size={18} className="text-emerald-300" />
            <span className="rounded-full bg-emerald-400 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-950">
              {ready ? 'Up to date' : 'Not ready'}
            </span>
          </div>
        </div>

        {finalShoppingItems.length === 0 ? (
          <div className="rounded-2xl bg-white/10 p-5 print:bg-gray-100">
            <p className="font-semibold">Shopping list not ready</p>
            <p className="mt-1 text-sm text-slate-300 print:text-gray-600">
              Complete the menu and wait for a successful calculation before printing.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/10 print:border-gray-300">
            <table className="w-full text-left">
              <thead className="bg-white/10 text-xs uppercase tracking-wide text-slate-100 print:bg-gray-100 print:text-gray-700">
                <tr>
                  <th className="p-4">Item</th>
                  <th className="p-4">Needed</th>
                  <th className="p-4">In house</th>
                  <th className="p-4">Buy</th>
                </tr>
              </thead>
              <tbody>
                {finalShoppingItems.map((item) => {
                  const itemId = getIngredientId(item);
                  const sourceUnit = getIngredientUnit(item);
                  const needed = convertToUS(item.quantity, sourceUnit);
                  const stock = convertToUS(
                    item.inStorage,
                    sourceUnit,
                    needed.unit
                  );
                  const buy = convertToUS(item.toBuy, sourceUnit, needed.unit);

                  return (
                    <tr
                      key={itemId}
                      className="border-t border-white/10 text-slate-100 print:border-gray-200 print:text-black"
                    >
                      <td className="p-4 font-semibold text-white print:text-black">
                        {getIngredientName(item)}
                      </td>
                      <td className="p-4 text-slate-200 print:text-black">
                        {needed.value} {needed.unit}
                      </td>
                      <td className="p-4 text-slate-200 print:text-black">
                        {stock.value} {stock.unit}
                      </td>
                      <td
                        className={`p-4 font-bold print:text-black ${
                          item.toBuy > 0
                            ? 'text-emerald-300'
                            : 'text-slate-400 line-through'
                        }`}
                      >
                        {buy.value} {buy.unit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

const ActionButton = ({
  label,
  icon,
  loading,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-bold shadow-sm transition ${
      disabled
        ? 'cursor-not-allowed bg-gray-100 text-gray-400'
        : 'bg-emerald-600 text-white hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-lg'
    }`}
  >
    {loading ? <Loader2 className="animate-spin" size={18} /> : icon}
    {label}
  </button>
);

const InfoCard = ({
  title,
  value,
  onChange,
  disabled,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) => (
  <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
    <p className="text-sm text-gray-500">{title}</p>
    <input
      type="number"
      min="0"
      step="1"
      aria-label={title}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="mt-2 w-full rounded-xl border border-gray-200 px-4 py-3 text-lg font-semibold outline-none focus:border-emerald-500 disabled:bg-gray-100"
    />
  </div>
);

const MealSelectLine = ({
  label,
  value,
  currentMeal,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  currentMeal?: Meal;
  options: Meal[];
  disabled: boolean;
  onChange: (mealId: string) => void;
}) => {
  const includesCurrentMeal = options.some((meal) => meal.id === value);

  return (
    <label className="mb-3 block rounded-xl bg-white p-3 shadow-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-emerald-500 disabled:text-gray-400"
      >
        {!includesCurrentMeal && currentMeal && (
          <option value={currentMeal.id}>{currentMeal.name}</option>
        )}
        {options.length === 0 ? (
          <option value="">No {label.toLowerCase()} meals available</option>
        ) : (
          options.map((meal) => (
            <option key={meal.id} value={meal.id}>
              {currentMeal?.id === meal.id ? currentMeal.name : meal.name}
            </option>
          ))
        )}
      </select>
    </label>
  );
};

const EmptyState = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => (
  <div className="mt-5 rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-6">
    <p className="font-semibold text-gray-700">{title}</p>
    <p className="mt-1 text-sm text-gray-500">{description}</p>
  </div>
);

const MessageBox = ({
  message,
  type,
}: {
  message: string;
  type: MessageType;
}) => {
  const styles: Record<MessageType, string> = {
    success: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    error: 'border-red-100 bg-red-50 text-red-700',
    info: 'border-blue-100 bg-blue-50 text-blue-700',
  };

  return (
    <div
      className={`rounded-2xl border px-5 py-4 text-sm shadow-sm print:hidden ${styles[type]}`}
    >
      {message}
    </div>
  );
};

export default MealPlanner;
