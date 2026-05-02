import React, { useState } from 'react';
import axios from 'axios';
import {
  CalendarDays,
  CheckCircle2,
  ShoppingCart,
  ClipboardCheck,
  Sparkles,
  Loader2,
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
  ingredient: {
    id: string;
    name: string;
    unit: string;
  };
  quantity: number;
};

type FinalShoppingItem = {
  ingredient: {
    id: string;
    name: string;
    unit: string;
  };
  required: number;
  inStorage: number;
  toBuy: number;
  warnings?: string[];
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

const convertToUS = (quantity: number, unit: string) => {
  if (!quantity) {
    return { value: '0', unit };
  }

  switch (unit) {
    case 'g':
      return quantity >= 453.592
        ? { value: (quantity / 453.592).toFixed(2), unit: 'lb' }
        : { value: (quantity / 28.35).toFixed(1), unit: 'oz' };

    case 'ml':
      return quantity >= 946.353
        ? { value: (quantity / 946.353).toFixed(2), unit: 'qt' }
        : { value: (quantity / 29.5735).toFixed(1), unit: 'fl oz' };

    default:
      return { value: String(quantity), unit };
  }
};

const Meals = () => {
  const [weeklyMenu, setWeeklyMenu] = useState<MenuDay[]>([]);
  const [shoppingItems, setShoppingItems] = useState<ShoppingItem[]>([]);
  const [finalItems, setFinalItems] = useState<FinalShoppingItem[]>([]);
  const [shelfItems, setShelfItems] = useState<Record<string, number>>({});
  const [childrenCount, setChildrenCount] = useState(20);
  const [staffCount, setStaffCount] = useState(5);
  const [menuConfirmed, setMenuConfirmed] = useState(false);
  const [shelfSaved, setShelfSaved] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error' | 'info'>('info');

  const isBusy = loading !== null;

  const currentStep =
    finalItems.length > 0
      ? 4
      : shelfSaved
        ? 3
        : shoppingItems.length > 0
          ? 2
          : menuConfirmed
            ? 1
            : weeklyMenu.length > 0
              ? 0
              : -1;

  const showMessage = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setMessage(text);
    setMessageType(type);
  };

  const generateMenu = async () => {
    setLoading('menu');
    setMessage('');

    try {
      const res = await axios.get(`${API_BASE_URL}/api/menu/generate`);
      setWeeklyMenu(res.data.data.week || []);
      setShoppingItems([]);
      setFinalItems([]);
      setShelfItems({});
      setMenuConfirmed(false);
      setShelfSaved(false);
      showMessage('Weekly menu generated successfully.', 'success');
    } catch (err) {
      console.error('Failed to generate menu:', err);
      showMessage(getErrorMessage(err, 'Failed to generate menu.'), 'error');
    } finally {
      setLoading(null);
    }
  };

  const confirmMenu = async () => {
    if (weeklyMenu.length === 0) {
      showMessage('Please generate a menu first.', 'error');
      return;
    }

    setLoading('confirm');
    setMessage('');

    try {
      await axios.post(`${API_BASE_URL}/api/menu/confirm`, {
        week: weeklyMenu,
      });

      setMenuConfirmed(true);
      showMessage('Menu confirmed. You can now generate the shopping list.', 'success');
    } catch (err) {
      console.error('Failed to confirm menu:', err);
      showMessage(getErrorMessage(err, 'Failed to confirm menu.'), 'error');
    } finally {
      setLoading(null);
    }
  };

  const generateShoppingList = async () => {
    if (!menuConfirmed) {
      showMessage('Please confirm the menu first.', 'error');
      return;
    }

    setLoading('shopping');
    setMessage('');

    try {
      const res = await axios.post(`${API_BASE_URL}/api/shopping/generate`, {
        childrenCount,
        staffCount,
      });

      const items = res.data.data.items || [];
      setShoppingItems(items);
      setFinalItems([]);
      setShelfSaved(false);

      const initialShelf: Record<string, number> = {};
      items.forEach((item: ShoppingItem) => {
        initialShelf[item.ingredient.id] = 0;
      });

      setShelfItems(initialShelf);
      showMessage('Shopping list generated.', 'success');
    } catch (err) {
      console.error('Failed to generate shopping list:', err);
      showMessage(getErrorMessage(err, 'Failed to generate shopping list.'), 'error');
    } finally {
      setLoading(null);
    }
  };

  const saveShelfCheck = async () => {
    if (shoppingItems.length === 0) {
      showMessage('Generate a shopping list first.', 'error');
      return;
    }

    setLoading('shelf');
    setMessage('');

    try {
      const items: ShelfItemInput[] = Object.entries(shelfItems).map(
        ([ingredientId, quantity]) => ({
          ingredientId,
          quantity: Number(quantity) || 0,
        })
      );

      await axios.post(`${API_BASE_URL}/api/shelf/check`, {
        items,
      });

      setShelfSaved(true);
      showMessage('Shelf check saved. You can now generate the final shopping list.', 'success');
    } catch (err) {
      console.error('Failed to save shelf check:', err);
      showMessage(getErrorMessage(err, 'Failed to save shelf check.'), 'error');
    } finally {
      setLoading(null);
    }
  };

  const generateFinalShoppingList = async () => {
    if (!shelfSaved) {
      showMessage('Please save the shelf check first.', 'error');
      return;
    }

    setLoading('final');
    setMessage('');

    try {
      const res = await axios.get(`${API_BASE_URL}/api/shelf/final`);
      setFinalItems(res.data.data.items || []);
      showMessage('Final shopping list generated.', 'success');
    } catch (err) {
      console.error('Failed to generate final shopping list:', err);
      showMessage(getErrorMessage(err, 'Failed to generate final shopping list.'), 'error');
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 p-8 text-white shadow-xl">
        <div className="absolute right-[-60px] top-[-60px] h-48 w-48 rounded-full bg-white/10" />
        <div className="absolute bottom-[-80px] left-[35%] h-56 w-56 rounded-full bg-white/10" />

        <div className="relative z-10 max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm">
            <Sparkles size={16} />
            Smart Kids Academy Meal Planning
          </div>

          <h2 className="text-4xl font-bold tracking-tight">Meal Planner</h2>
          <p className="mt-3 text-sm leading-6 text-emerald-50">
            Generate weekly menus, confirm meals, calculate shopping needs, check shelf inventory,
            and create the final purchase list using US-friendly measurements.
          </p>
        </div>
      </section>

      <ProgressSteps current={currentStep} />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <StepCard
          icon={<CalendarDays size={22} />}
          step="Step 1"
          title="Generate Menu"
          active={weeklyMenu.length > 0}
          onClick={generateMenu}
          disabled={isBusy}
          loading={loading === 'menu'}
        />

        <StepCard
          icon={<CheckCircle2 size={22} />}
          step="Step 2"
          title="Confirm Menu"
          active={menuConfirmed}
          onClick={confirmMenu}
          disabled={isBusy || weeklyMenu.length === 0}
          loading={loading === 'confirm'}
        />

        <StepCard
          icon={<ShoppingCart size={22} />}
          step="Step 3"
          title="Shopping List"
          active={shoppingItems.length > 0}
          onClick={generateShoppingList}
          disabled={isBusy || !menuConfirmed}
          loading={loading === 'shopping'}
        />

        <StepCard
          icon={<ClipboardCheck size={22} />}
          step="Step 4"
          title="Save Shelf"
          active={shelfSaved}
          onClick={saveShelfCheck}
          disabled={isBusy || shoppingItems.length === 0}
          loading={loading === 'shelf'}
        />

        <StepCard
          icon={<ShoppingCart size={22} />}
          step="Step 5"
          title="Final List"
          active={finalItems.length > 0}
          onClick={generateFinalShoppingList}
          disabled={isBusy || !shelfSaved}
          loading={loading === 'final'}
        />
      </section>

      {message && <MessageBox message={message} type={messageType} />}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className={`rounded-2xl bg-white p-5 shadow-sm border border-gray-100 ${isBusy ? 'opacity-70' : ''}`}>
          <p className="text-sm text-gray-500">Children Count</p>
          <input
            type="number"
            min="0"
            value={childrenCount}
            disabled={isBusy}
            onChange={(e) => setChildrenCount(Number(e.target.value))}
            className="mt-2 w-full rounded-xl border border-gray-200 px-4 py-3 text-lg font-semibold outline-none focus:border-emerald-500 disabled:bg-gray-100"
          />
        </div>

        <div className={`rounded-2xl bg-white p-5 shadow-sm border border-gray-100 ${isBusy ? 'opacity-70' : ''}`}>
          <p className="text-sm text-gray-500">Staff Count</p>
          <input
            type="number"
            min="0"
            value={staffCount}
            disabled={isBusy}
            onChange={(e) => setStaffCount(Number(e.target.value))}
            className="mt-2 w-full rounded-xl border border-gray-200 px-4 py-3 text-lg font-semibold outline-none focus:border-emerald-500 disabled:bg-gray-100"
          />
        </div>
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold text-gray-800">Weekly Menu</h3>
            <p className="text-sm text-gray-500">Generated from backend meal data.</p>
          </div>
          <StatusBadge active={menuConfirmed} label={menuConfirmed ? 'Confirmed' : 'Draft'} />
        </div>

        {weeklyMenu.length === 0 ? (
          <EmptyState
            title="No Menu Yet"
            description="Start by generating a weekly menu."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            {weeklyMenu.map((day) => (
              <div
                key={day.day}
                className="rounded-2xl border border-emerald-100 bg-gradient-to-b from-emerald-50 to-white p-4"
              >
                <h4 className="mb-4 text-lg font-bold text-emerald-700">{day.day}</h4>
                <MealLine label="Breakfast" value={day.menu.breakfast?.name} />
                <MealLine label="Snack" value={day.menu.snack?.name} />
                <MealLine label="Lunch" value={day.menu.lunch?.name} />
                <MealLine label="Afternoon Snack" value={day.menu.afternoonSnack?.name} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-2xl font-bold text-gray-800">Shopping List</h3>
              <p className="mt-1 text-sm text-gray-500">
                Calculated based on confirmed menu and total people.
              </p>
            </div>
            <StatusBadge
              active={shoppingItems.length > 0}
              label={shoppingItems.length > 0 ? 'Ready' : 'Pending'}
            />
          </div>

          {shoppingItems.length === 0 ? (
            <EmptyState
              title="No Shopping List Yet"
              description="Confirm the menu, then generate the shopping list."
            />
          ) : (
            <div className="mt-5 overflow-hidden rounded-2xl border border-gray-100">
              <table className="w-full text-left">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="p-4">Ingredient</th>
                    <th className="p-4">Needed</th>
                    <th className="p-4">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {shoppingItems.map((item) => {
                    const converted = convertToUS(item.quantity, item.ingredient.unit);

                    return (
                      <tr key={item.ingredient.id} className="border-t border-gray-100">
                        <td className="p-4 font-semibold text-gray-800">{item.ingredient.name}</td>
                        <td className="p-4 text-gray-700">{converted.value}</td>
                        <td className="p-4 text-gray-500">{converted.unit}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-2xl font-bold text-gray-800">Shelf Check</h3>
              <p className="mt-1 text-sm text-gray-500">Enter what you already have before buying.</p>
            </div>
            <StatusBadge
              active={shelfSaved}
              label={shelfSaved ? 'Saved' : 'Pending'}
            />
          </div>

          {shoppingItems.length === 0 ? (
            <EmptyState
              title="Shelf Check Not Ready"
              description="Generate a shopping list before entering shelf quantities."
            />
          ) : (
            <div className="mt-5 space-y-3">
              {shoppingItems.map((item) => {
                const converted = convertToUS(item.quantity, item.ingredient.unit);

                return (
                  <div
                    key={item.ingredient.id}
                    className="flex items-center justify-between gap-4 rounded-2xl border border-gray-100 bg-gray-50 p-4"
                  >
                    <div>
                      <p className="font-semibold text-gray-800">{item.ingredient.name}</p>
                      <p className="text-xs text-gray-500">
                        Needed: {converted.value} {converted.unit}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        disabled={isBusy}
                        value={shelfItems[item.ingredient.id] ?? 0}
                        onChange={(e) => {
                          setShelfSaved(false);
                          setFinalItems([]);
                          setShelfItems((prev) => ({
                            ...prev,
                            [item.ingredient.id]: Number(e.target.value),
                          }));
                        }}
                        className="w-28 rounded-xl border border-gray-200 px-3 py-2 text-right font-semibold outline-none focus:border-emerald-500 disabled:bg-gray-100"
                      />
                      <span className="text-sm text-gray-500">{converted.unit}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-3xl bg-slate-950 p-6 text-white shadow-xl">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold">Final Shopping List</h3>
            <p className="mt-1 text-sm text-slate-300">
              Optimized after subtracting shelf inventory.
            </p>
          </div>
          <StatusBadge
            active={finalItems.length > 0}
            label={finalItems.length > 0 ? 'Ready to Purchase' : 'Pending'}
          />
        </div>

        {finalItems.length === 0 ? (
          <div className="rounded-2xl bg-white/10 p-5">
            <p className="font-semibold text-white">Final List Not Ready</p>
            <p className="mt-1 text-sm text-slate-300">
              Save the shelf check first, then generate the final list.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {finalItems.map((item) => {
              const required = convertToUS(item.required, item.ingredient.unit);
              const inStorage = convertToUS(item.inStorage, item.ingredient.unit);
              const toBuy = convertToUS(item.toBuy, item.ingredient.unit);

              return (
                <div
                  key={item.ingredient.id}
                  className="rounded-2xl border border-white/10 bg-white/10 p-5"
                >
                  <p className="text-lg font-bold">{item.ingredient.name}</p>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
                    <MiniStat label="Required" value={`${required.value} ${required.unit}`} />
                    <MiniStat label="Storage" value={`${inStorage.value} ${inStorage.unit}`} />
                    <MiniStat label="Buy" value={`${toBuy.value} ${toBuy.unit}`} highlight />
                  </div>

                  {item.warnings && item.warnings.length > 0 && (
                    <div className="mt-4 rounded-xl bg-amber-400/20 p-3 text-xs text-amber-100">
                      {item.warnings.map((warning, index) => (
                        <p key={index}>{warning}</p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

const ProgressSteps = ({ current }: { current: number }) => {
  const steps = ['Generate', 'Confirm', 'Shopping', 'Shelf', 'Final'];

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm border border-gray-100">
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((step, index) => (
          <div key={step} className="flex items-center gap-2">
            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                index <= current
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-gray-100 text-gray-400'
              }`}
            >
              {step}
            </span>
            {index < steps.length - 1 && <span className="text-gray-300">→</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

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

const StepCard = ({
  icon,
  step,
  title,
  active,
  disabled,
  loading,
  onClick,
}: {
  icon: React.ReactNode;
  step: string;
  title: string;
  active: boolean;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`group rounded-2xl border p-5 text-left shadow-sm transition ${
        disabled
          ? 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-400'
          : active
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:shadow-md'
            : 'border-gray-100 bg-white text-gray-800 hover:-translate-y-0.5 hover:shadow-md'
      }`}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="rounded-xl bg-white p-2 shadow-sm">
          {loading ? <Loader2 className="animate-spin" size={22} /> : icon}
        </div>
        <span className="text-xs font-semibold uppercase tracking-wide">{step}</span>
      </div>
      <p className="text-lg font-bold">{title}</p>
    </button>
  );
};

const MealLine = ({ label, value }: { label: string; value?: string }) => (
  <div className="mb-3 rounded-xl bg-white p-3 shadow-sm">
    <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
    <p className="mt-1 text-sm font-semibold text-gray-800">{value || 'Not assigned'}</p>
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

const StatusBadge = ({ active, label }: { active: boolean; label: string }) => (
  <span
    className={`whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wide ${
      active ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
    }`}
  >
    {label}
  </span>
);

const MiniStat = ({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) => (
  <div className={`rounded-xl p-3 ${highlight ? 'bg-emerald-400 text-slate-950' : 'bg-white/10'}`}>
    <p className="text-xs opacity-80">{label}</p>
    <p className="text-lg font-bold">{value}</p>
  </div>
);

export default Meals;
