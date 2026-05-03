import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Sparkles,
  Loader2,
  Save,
  Printer,
  RefreshCw,
  ShoppingCart,
  PackageCheck,
} from 'lucide-react';
import { API_BASE_URL } from '../lib/api';

type Meal = {
  id: string;
  name: string;
  type: string;
};

type MenuDay = {
  day: string;
  menu: {
    breakfast: Meal;
    snack: Meal;
    lunch: Meal;
    afternoonSnack: Meal;
  };
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

type ShelfItemInput = {
  ingredientId: string;
  quantity: number;
};

const getErrorMessage = (err: unknown, fallback: string) => {
  if (axios.isAxiosError(err)) {
    return err.response?.data?.error?.message || err.response?.data?.message || fallback;
  }

  return fallback;
};

const getIngredientId = (item: ShoppingItem) => {
  return item.ingredient?.id || item.ingredientId || item.name || 'unknown-item';
};

const getIngredientName = (item: ShoppingItem) => {
  return item.ingredient?.name || item.name || item.ingredientId || 'Unnamed Item';
};

const getIngredientUnit = (item: ShoppingItem) => {
  return item.ingredient?.unit || item.unit || '';
};

const convertToUS = (quantity: number, unit: string) => {
  if (!quantity) return { value: '0', unit };

  switch (unit) {
    case 'g':
      return quantity >= 453.592
        ? { value: (quantity / 453.592).toFixed(2), unit: 'lb' }
        : { value: (quantity / 28.35).toFixed(1), unit: 'oz' };

    case 'ml':
      return {
        value: (quantity / 3785.41).toFixed(3),
        unit: 'gal',
      };

    default:
      return { value: String(quantity), unit };
  }
};

const Meals = () => {
  const [weeklyMenu, setWeeklyMenu] = useState<MenuDay[]>([]);
  const [shoppingItems, setShoppingItems] = useState<ShoppingItem[]>([]);
  const [inStock, setInStock] = useState<Record<string, number>>({});
  const [childrenCount, setChildrenCount] = useState(20);
  const [staffCount, setStaffCount] = useState(5);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error' | 'info'>('info');
  const [hasSaved, setHasSaved] = useState(false);

  const isBusy = loading !== null;

  const showMessage = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setMessage(text);
    setMessageType(type);
  };

  const finalShoppingItems = useMemo(() => {
    return shoppingItems.map((item) => {
      const itemId = getIngredientId(item);
      const stockQty = Number(inStock[itemId]) || 0;
      const toBuy = Math.max(item.quantity - stockQty, 0);

      return {
        ...item,
        inStorage: stockQty,
        toBuy,
      };
    });
  }, [shoppingItems, inStock]);

  const generateShoppingListForMenu = async () => {
    const shoppingRes = await axios.post(`${API_BASE_URL}/api/shopping/generate`, {
      childrenCount,
      staffCount,
    });

    const items = shoppingRes.data.data.items || [];
    setShoppingItems(items);

    const nextStock: Record<string, number> = {};
    items.forEach((item: ShoppingItem) => {
      const itemId = getIngredientId(item);
      nextStock[itemId] = inStock[itemId] || 0;
    });

    setInStock(nextStock);
  };

  useEffect(() => {
    if (weeklyMenu.length === 0) return;

    const timer = setTimeout(() => {
      generateShoppingListForMenu().catch((err) => {
        console.error('Failed to refresh shopping list:', err);
        showMessage(getErrorMessage(err, 'Failed to refresh shopping list.'), 'error');
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [childrenCount, staffCount]);

  const generateMenu = async () => {
    setLoading('generate');
    setMessage('');
    setHasSaved(false);

    try {
      const menuRes = await axios.get(`${API_BASE_URL}/api/menu/generate`);
      const week = menuRes.data.data.week || [];

      setWeeklyMenu(week);

      await axios.post(`${API_BASE_URL}/api/menu/confirm`, {
        week,
      });

      await generateShoppingListForMenu();

      showMessage('Menu generated. Shopping list is ready to review.', 'success');
    } catch (err) {
      console.error('Failed to generate menu:', err);
      showMessage(getErrorMessage(err, 'Failed to generate menu.'), 'error');
    } finally {
      setLoading(null);
    }
  };

  const updateMealName = (
    dayIndex: number,
    mealKey: keyof MenuDay['menu'],
    value: string
  ) => {
    setWeeklyMenu((prev) =>
      prev.map((day, index) => {
        if (index !== dayIndex) return day;

        return {
          ...day,
          menu: {
            ...day.menu,
            [mealKey]: {
              ...day.menu[mealKey],
              name: value,
            },
          },
        };
      })
    );

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

    setLoading('save');
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

      if (shelfItems.length > 0) {
        await axios.post(`${API_BASE_URL}/api/shelf/check`, {
          items: shelfItems,
        });
      }

      setHasSaved(true);
      showMessage('Menu and in-house quantities saved.', 'success');
    } catch (err) {
      console.error('Failed to save menu:', err);
      showMessage(getErrorMessage(err, 'Failed to save menu.'), 'error');
    } finally {
      setLoading(null);
    }
  };

  const printShoppingList = () => {
    window.print();
  };

  return (
    <div className="p-6 space-y-6">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 p-8 text-white shadow-xl print:hidden">
        <div className="absolute right-[-60px] top-[-60px] h-48 w-48 rounded-full bg-white/10" />
        <div className="absolute bottom-[-80px] left-[35%] h-56 w-56 rounded-full bg-white/10" />

        <div className="relative z-10 flex flex-col gap-6 xl:flex-row xl:items-center xl:justify-between">
          <div className="max-w-3xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm">
              <Sparkles size={16} />
              Smart Kids Academy Meal Planning
            </div>

            <h2 className="text-4xl font-bold tracking-tight">Meal Planner</h2>
            <p className="mt-3 text-sm leading-6 text-emerald-50">
              Generate a weekly menu, edit it in place, enter what is already in house,
              and print a clean shopping list.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ActionButton
              label="Generate Menu"
              icon={<RefreshCw size={18} />}
              loading={loading === 'generate'}
              disabled={isBusy}
              onClick={generateMenu}
            />

            <ActionButton
              label="Save Menu"
              icon={<Save size={18} />}
              loading={loading === 'save'}
              disabled={isBusy || weeklyMenu.length === 0}
              onClick={saveMenu}
            />

            <ActionButton
              label="Print List"
              icon={<Printer size={18} />}
              loading={false}
              disabled={finalShoppingItems.length === 0}
              onClick={printShoppingList}
            />
          </div>
        </div>
      </section>

      {message && <MessageBox message={message} type={messageType} />}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3 print:hidden">
        <InfoCard
          title="Children"
          value={childrenCount}
          onChange={setChildrenCount}
          disabled={isBusy}
        />

        <InfoCard
          title="Staff"
          value={staffCount}
          onChange={setStaffCount}
          disabled={isBusy}
        />

        <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500">Status</p>
          <p className="mt-2 text-lg font-bold text-gray-800">
            {hasSaved ? 'Saved' : weeklyMenu.length > 0 ? 'Draft' : 'Not Started'}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Shopping list updates immediately when in-house amounts change.
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr] print:hidden">
        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <div className="mb-5">
            <h3 className="text-2xl font-bold text-gray-800">Editable Weekly Menu</h3>
            <p className="text-sm text-gray-500">
              Adjust generated meals directly before saving.
            </p>
          </div>

          {weeklyMenu.length === 0 ? (
            <EmptyState
              title="No Menu Yet"
              description="Click Generate Menu to create the weekly plan."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {weeklyMenu.map((day, dayIndex) => (
                <div
                  key={day.day}
                  className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-4"
                >
                  <h4 className="mb-4 text-lg font-bold text-emerald-700">{day.day}</h4>

                  <MealEditLine
                    label="Breakfast"
                    value={day.menu.breakfast?.name || ''}
                    onChange={(value) => updateMealName(dayIndex, 'breakfast', value)}
                  />

                  <MealEditLine
                    label="Snack"
                    value={day.menu.snack?.name || ''}
                    onChange={(value) => updateMealName(dayIndex, 'snack', value)}
                  />

                  <MealEditLine
                    label="Lunch"
                    value={day.menu.lunch?.name || ''}
                    onChange={(value) => updateMealName(dayIndex, 'lunch', value)}
                  />

                  <MealEditLine
                    label="Afternoon Snack"
                    value={day.menu.afternoonSnack?.name || ''}
                    onChange={(value) => updateMealName(dayIndex, 'afternoonSnack', value)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-2xl font-bold text-gray-800">Shopping Items</h3>
              <p className="text-sm text-gray-500">
                Enter in-house quantities next to each item.
              </p>
            </div>

            {shoppingItems.length > 0 && (
              <button
                onClick={clearInStock}
                disabled={isBusy}
                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Clear All
              </button>
            )}
          </div>

          {shoppingItems.length === 0 ? (
            <EmptyState
              title="No Shopping Items Yet"
              description="Generate a menu first. Items will appear here automatically."
            />
          ) : (
            <div className="space-y-3">
              {shoppingItems.map((item) => {
                const itemId = getIngredientId(item);
                const unit = getIngredientUnit(item);
                const needed = convertToUS(item.quantity, unit);
                const stockQty = Number(inStock[itemId]) || 0;
                const buyQty = Math.max(item.quantity - stockQty, 0);
                const buy = convertToUS(buyQty, unit);

                return (
                  <div
                    key={itemId}
                    className="rounded-2xl border border-gray-100 bg-gray-50 p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-semibold text-gray-900">
                          {getIngredientName(item)}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Needed: {needed.value} {needed.unit}
                        </p>
                        <p
                          className={`mt-1 text-xs font-semibold ${
                            buyQty > 0 ? 'text-emerald-700' : 'text-gray-400 line-through'
                          }`}
                        >
                          Buy: {buy.value} {buy.unit}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                          In House
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            disabled={isBusy}
                            value={inStock[itemId] ?? 0}
                            onChange={(e) => {
                              setHasSaved(false);
                              setInStock((prev) => ({
                                ...prev,
                                [itemId]: Number(e.target.value),
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
              Final list after subtracting in-house quantities.
            </p>
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <PackageCheck size={18} className="text-emerald-300" />
            <span className="rounded-full bg-emerald-400 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-950">
              Live Updated
            </span>
          </div>
        </div>

        {finalShoppingItems.length === 0 ? (
          <div className="rounded-2xl bg-white/10 p-5 print:bg-gray-100">
            <p className="font-semibold">Shopping List Not Ready</p>
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
                  <th className="p-4">In House</th>
                  <th className="p-4">Buy</th>
                </tr>
              </thead>
              <tbody>
                {finalShoppingItems.map((item) => {
                  const itemId = getIngredientId(item);
                  const unit = getIngredientUnit(item);
                  const needed = convertToUS(item.quantity, unit);
                  const stock = convertToUS(item.inStorage, unit);
                  const buy = convertToUS(item.toBuy, unit);

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
  icon: React.ReactNode;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-bold shadow-sm transition ${
      disabled
        ? 'cursor-not-allowed bg-white/20 text-white/50'
        : 'bg-white text-emerald-700 hover:-translate-y-0.5 hover:shadow-lg'
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
  <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
    <p className="text-sm text-gray-500">{title}</p>
    <input
      type="number"
      min="0"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="mt-2 w-full rounded-xl border border-gray-200 px-4 py-3 text-lg font-semibold outline-none focus:border-emerald-500 disabled:bg-gray-100"
    />
  </div>
);

const MealEditLine = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => (
  <div className="mb-3 rounded-xl bg-white p-3 shadow-sm">
    <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 w-full rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-emerald-500"
    />
  </div>
);

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
  type: 'success' | 'error' | 'info';
}) => {
  const styles = {
    success: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    error: 'border-red-100 bg-red-50 text-red-700',
    info: 'border-blue-100 bg-blue-50 text-blue-700',
  };

  return (
    <div className={`rounded-2xl border px-5 py-4 text-sm shadow-sm ${styles[type]}`}>
      {message}
    </div>
  );
};

export default Meals;
