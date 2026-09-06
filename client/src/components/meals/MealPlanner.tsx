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

const MEAL_TYPES = ['breakfast', 'snack', 'lunch', 'afternoonSnack'] as const;

type MealType = (typeof MEAL_TYPES)[number];

type Meal = {
  id: string;
  name: string;
  type: MealType;
  description?: string;
};

type MenuDay = {
  day: string;
  menu: Record<MealType, Meal>;
};

type ShoppingItem = {
  ingredient?: {
    id?: string;
    name?: string;
    unit?: string;
  };
  ingredientId?: string;
  name?: string;
  unit?: string;
  quantity: number;
};

type FinalShoppingItem = ShoppingItem & {
  inStorage: number;
  toBuy: number;
};

type ShelfItemInput = {
  ingredientId: string;
  quantity: number;
};

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

const getIngredientId = (item: ShoppingItem) =>
  item.ingredient?.id || item.ingredientId || item.name || 'unknown-item';

const getIngredientName = (item: ShoppingItem) =>
  item.ingredient?.name || item.name || item.ingredientId || 'Unnamed item';

const getIngredientUnit = (item: ShoppingItem) =>
  item.ingredient?.unit || item.unit || '';

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

const MealPlanner = () => {
  const [availableMeals, setAvailableMeals] = useState<Meal[]>([]);
  const [weeklyMenu, setWeeklyMenu] = useState<MenuDay[]>([]);
  const [shoppingItems, setShoppingItems] = useState<ShoppingItem[]>([]);
  const [inStock, setInStock] = useState<Record<string, number>>({});
  const [childrenCount, setChildrenCount] = useState(20);
  const [staffCount, setStaffCount] = useState(5);
  const [actionLoading, setActionLoading] = useState<'generate' | 'save' | null>(
    null
  );
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [shoppingLoading, setShoppingLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<MessageType>('info');
  const [hasSaved, setHasSaved] = useState(false);

  const isBusy = actionLoading !== null;

  const mealsByType = useMemo(() => {
    const groups: Record<MealType, Meal[]> = {
      breakfast: [],
      snack: [],
      lunch: [],
      afternoonSnack: [],
    };

    availableMeals.forEach((meal) => {
      if (isMealType(meal.type)) {
        groups[meal.type].push(meal);
      }
    });

    return groups;
  }, [availableMeals]);

  const finalShoppingItems = useMemo<FinalShoppingItem[]>(() => {
    return shoppingItems.map((item) => {
      const itemId = getIngredientId(item);
      const stockQuantity = Number(inStock[itemId]) || 0;

      return {
        ...item,
        inStorage: stockQuantity,
        toBuy: Math.max(Number(item.quantity) - stockQuantity, 0),
      };
    });
  }, [shoppingItems, inStock]);

  const showMessage = (text: string, type: MessageType = 'info') => {
    setMessage(text);
    setMessageType(type);
  };

  useEffect(() => {
    let active = true;

    const loadMeals = async () => {
      setCatalogLoading(true);
      setCatalogError('');

      try {
        const response = await axios.get<{ data: Meal[] }>(
          `${API_BASE_URL}/api/meals`
        );
        const meals = Array.isArray(response.data.data) ? response.data.data : [];

        if (active) {
          setAvailableMeals(meals);
        }
      } catch (err) {
        console.error('Failed to load meal catalog:', err);
        if (active) {
          setCatalogError(getErrorMessage(err, 'Failed to load the meal catalog.'));
        }
      } finally {
        if (active) {
          setCatalogLoading(false);
        }
      }
    };

    loadMeals();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (weeklyMenu.length === 0) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setShoppingLoading(true);

      try {
        const response = await axios.post<{ data: { items: ShoppingItem[] } }>(
          `${API_BASE_URL}/api/shopping/generate`,
          {
            week: weeklyMenu,
            childrenCount,
            staffCount,
          },
          { signal: controller.signal }
        );

        const items = Array.isArray(response.data.data.items)
          ? response.data.data.items
          : [];

        setShoppingItems(items);
        setInStock((previous) => {
          const next: Record<string, number> = {};
          items.forEach((item) => {
            const itemId = getIngredientId(item);
            next[itemId] = previous[itemId] || 0;
          });
          return next;
        });
      } catch (err) {
        if (!axios.isCancel(err)) {
          console.error('Failed to refresh shopping list:', err);
          showMessage(
            getErrorMessage(err, 'Failed to refresh the shopping list.'),
            'error'
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setShoppingLoading(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [weeklyMenu, childrenCount, staffCount]);

  const generateMenu = async () => {
    setActionLoading('generate');
    setMessage('');
    setHasSaved(false);

    try {
      const response = await axios.get<{ data: { week: MenuDay[] } }>(
        `${API_BASE_URL}/api/menu/generate`
      );
      const week = response.data.data.week || [];

      if (week.length === 0) {
        throw new Error('The server returned an empty weekly menu.');
      }

      setWeeklyMenu(week);
      setShoppingItems([]);
      setInStock({});
      showMessage(
        'Menu generated. Adjust any meal below; the shopping list will update automatically.',
        'success'
      );
    } catch (err) {
      console.error('Failed to generate menu:', err);
      showMessage(getErrorMessage(err, 'Failed to generate the menu.'), 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const updateMealSelection = (
    dayIndex: number,
    mealType: MealType,
    mealId: string
  ) => {
    const selectedMeal = mealsByType[mealType].find((meal) => meal.id === mealId);
    if (!selectedMeal) return;

    setWeeklyMenu((previous) =>
      previous.map((day, index) =>
        index === dayIndex
          ? {
              ...day,
              menu: {
                ...day.menu,
                [mealType]: selectedMeal,
              },
            }
          : day
      )
    );
    setHasSaved(false);
  };

  const updatePeopleCount = (
    setter: (value: number) => void,
    value: number
  ) => {
    setter(Math.max(0, value));
    setHasSaved(false);
  };

  const clearInStock = () => {
    const cleared: Record<string, number> = {};
    shoppingItems.forEach((item) => {
      cleared[getIngredientId(item)] = 0;
    });

    setInStock(cleared);
    setHasSaved(false);
  };

  const saveMenu = async () => {
    if (weeklyMenu.length === 0) {
      showMessage('Please generate a menu first.', 'error');
      return;
    }

    setActionLoading('save');
    setMessage('');

    try {
      await axios.post(`${API_BASE_URL}/api/menu/confirm`, {
        week: weeklyMenu,
      });

      const shelfItems: ShelfItemInput[] = Object.entries(inStock).map(
        ([ingredientId, quantity]) => ({
          ingredientId,
          quantity: Number(quantity) || 0,
        })
      );

      await axios.post(`${API_BASE_URL}/api/shelf/check`, {
        items: shelfItems,
      });

      setHasSaved(true);
      showMessage('Menu and in-house quantities saved.', 'success');
    } catch (err) {
      console.error('Failed to save menu:', err);
      showMessage(getErrorMessage(err, 'Failed to save the menu.'), 'error');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-emerald-100 bg-white p-5 shadow-sm print:hidden">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-emerald-700">
              <Database size={17} />
              Database-backed planner
            </div>
            <h3 className="mt-2 text-2xl font-bold text-gray-900">
              Generate, adjust, save, and print
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">
              Every dropdown keeps the selected meal ID, so recipe ingredients and
              shopping calculations remain accurate.
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
              disabled={isBusy || shoppingLoading || weeklyMenu.length === 0}
              onClick={saveMenu}
            />
            <ActionButton
              label="Print List"
              icon={<Printer size={18} />}
              loading={false}
              disabled={finalShoppingItems.length === 0}
              onClick={() => window.print()}
            />
          </div>
        </div>
      </section>

      {message && <MessageBox message={message} type={messageType} />}

      {catalogError && <MessageBox message={catalogError} type="error" />}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3 print:hidden">
        <InfoCard
          title="Children"
          value={childrenCount}
          onChange={(value) => updatePeopleCount(setChildrenCount, value)}
          disabled={isBusy}
        />
        <InfoCard
          title="Staff"
          value={staffCount}
          onChange={(value) => updatePeopleCount(setStaffCount, value)}
          disabled={isBusy}
        />
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Status</p>
          <p className="mt-2 text-lg font-bold text-gray-800">
            {hasSaved ? 'Saved' : weeklyMenu.length > 0 ? 'Draft' : 'Not started'}
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
                Choose a database meal for every day and meal period.
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
            <EmptyState
              title="No menu yet"
              description="Click Generate Menu to create the weekly plan."
            />
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
                          Needed: {needed.value} {needed.unit}
                        </p>
                        <p
                          className={`mt-1 text-xs font-semibold ${
                            buyRaw > 0
                              ? 'text-emerald-700'
                              : 'text-gray-400 line-through'
                          }`}
                        >
                          Buy: {buy.value} {buy.unit}
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
                            value={Number(stock.value)}
                            onChange={(event) => {
                              const displayedQuantity = Number(event.target.value);
                              setHasSaved(false);
                              setInStock((previous) => ({
                                ...previous,
                                [itemId]: convertFromUS(
                                  displayedQuantity,
                                  needed.unit,
                                  sourceUnit
                                ),
                              }));
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
              Final quantities after subtracting what is already in house.
            </p>
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <PackageCheck size={18} className="text-emerald-300" />
            <span className="rounded-full bg-emerald-400 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-950">
              Live updated
            </span>
          </div>
        </div>

        {finalShoppingItems.length === 0 ? (
          <div className="rounded-2xl bg-white/10 p-5 print:bg-gray-100">
            <p className="font-semibold">Shopping list not ready</p>
            <p className="mt-1 text-sm text-slate-300 print:text-gray-600">
              Generate a menu to create the shopping list.
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
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) => (
  <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
    <p className="text-sm text-gray-500">{title}</p>
    <input
      type="number"
      min="0"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
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
              {meal.name}
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

