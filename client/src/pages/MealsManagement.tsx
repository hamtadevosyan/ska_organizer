import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Plus, Utensils, PackagePlus, Link2, ArrowRight } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';

type Meal = {
  id: string;
  name: string;
  type: string;
  description?: string;
};

type Ingredient = {
  id: string;
  name: string;
  unit: string;
  shelfLifeDays?: number;
};

type MealIngredient = {
  id: string;
  mealId: string;
  ingredientId: string;
  quantity: number;
};

const emptyMeal = {
  name: '',
  type: 'breakfast',
  description: '',
};

const emptyIngredient = {
  name: '',
  unit: 'count',
};

const MealsManagement = () => {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [selectedMeal, setSelectedMeal] = useState<Meal | null>(null);
  const [mealIngredients, setMealIngredients] = useState<MealIngredient[]>([]);

  const [mealForm, setMealForm] = useState(emptyMeal);
  const [ingredientForm, setIngredientForm] = useState(emptyIngredient);
  const [assignForm, setAssignForm] = useState({
    ingredientId: '',
    quantity: 1,
  });

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const ingredientById = useMemo(() => {
    const map: Record<string, Ingredient> = {};
    ingredients.forEach((ingredient) => {
      map[ingredient.id] = ingredient;
    });
    return map;
  }, [ingredients]);

  const loadMeals = async () => {
    const res = await axios.get(`${API_BASE_URL}/api/meals`);
    setMeals(res.data.data || []);
  };

  const loadIngredients = async () => {
    const res = await axios.get(`${API_BASE_URL}/api/ingredients`);
    setIngredients(res.data.data || []);
  };

  const loadMealIngredients = async (mealId: string) => {
    const res = await axios.get(`${API_BASE_URL}/api/meals/${mealId}/ingredients`);
    setMealIngredients(res.data.data || []);
  };

  const loadInitialData = async () => {
    try {
      setLoading(true);
      await Promise.all([loadMeals(), loadIngredients()]);
    } catch (err) {
      console.error('Failed to load meals management data:', err);
      setMessage('Failed to load data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  const createMeal = async () => {
    if (!mealForm.name.trim()) {
      setMessage('Meal name is required.');
      return;
    }

    setLoading(true);

    try {
      await axios.post(`${API_BASE_URL}/api/meals`, mealForm);
      setMealForm(emptyMeal);
      setMessage('Meal added. Select it below to assign ingredients.');
      await loadMeals();
    } catch (err) {
      console.error('Failed to create meal:', err);
      setMessage('Failed to create meal.');
    } finally {
      setLoading(false);
    }
  };

  const createIngredient = async () => {
    if (!ingredientForm.name.trim()) {
      setMessage('Ingredient name is required.');
      return;
    }

    if (!ingredientForm.unit.trim()) {
      setMessage('Ingredient unit is required.');
      return;
    }

    setLoading(true);

    try {
      await axios.post(`${API_BASE_URL}/api/ingredients`, {
        ...ingredientForm,
        shelfLifeDays: null,
      });

      setIngredientForm(emptyIngredient);
      setMessage('Ingredient added to catalog. You can now assign it to meals.');
      await loadIngredients();
    } catch (err) {
      console.error('Failed to create ingredient:', err);
      setMessage('Failed to create ingredient.');
    } finally {
      setLoading(false);
    }
  };

  const selectMeal = async (meal: Meal) => {
    setSelectedMeal(meal);
    setAssignForm({ ingredientId: '', quantity: 1 });

    try {
      await loadMealIngredients(meal.id);
    } catch (err) {
      console.error('Failed to load meal ingredients:', err);
      setMessage('Failed to load meal ingredients.');
    }
  };

  const addIngredientToMeal = async () => {
    if (!selectedMeal) {
      setMessage('Select a meal first.');
      return;
    }

    if (!assignForm.ingredientId) {
      setMessage('Select an ingredient first.');
      return;
    }

    if (Number(assignForm.quantity) <= 0) {
      setMessage('Quantity must be greater than 0.');
      return;
    }

    setLoading(true);

    try {
      await axios.post(`${API_BASE_URL}/api/meals/${selectedMeal.id}/ingredients`, {
        ingredientId: assignForm.ingredientId,
        quantity: Number(assignForm.quantity),
      });

      setAssignForm({ ingredientId: '', quantity: 1 });
      setMessage('Ingredient connected to selected meal.');
      await loadMealIngredients(selectedMeal.id);
    } catch (err) {
      console.error('Failed to assign ingredient:', err);
      setMessage('Failed to assign ingredient.');
    } finally {
      setLoading(false);
    }
  };

  const getIngredientName = (ingredientId: string) => {
    return ingredientById[ingredientId]?.name || ingredientId;
  };

  const getIngredientUnit = (ingredientId: string) => {
    return ingredientById[ingredientId]?.unit || '';
  };

  return (
    <div className="p-6 space-y-6">
      <section className="rounded-3xl bg-gradient-to-br from-orange-500 via-amber-500 to-yellow-500 p-8 text-white shadow-xl">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div className="rounded-2xl bg-white/20 p-4">
              <Utensils size={32} />
            </div>
            <div>
              <h2 className="text-4xl font-bold">Meals Management</h2>
              <p className="mt-2 text-sm text-orange-50">
                Build meals by connecting ingredients and quantities.
              </p>
            </div>
          </div>

          <div className="rounded-2xl bg-white/15 px-5 py-4 text-sm">
            <p className="font-semibold">Current setup</p>
            <p className="text-orange-50">
              {meals.length} meals · {ingredients.length} catalog ingredients
            </p>
          </div>
        </div>
      </section>

      {message && (
        <div className="rounded-2xl border border-blue-100 bg-blue-50 px-5 py-4 text-sm text-blue-700">
          {message}
        </div>
      )}

      <section className="rounded-3xl bg-white p-5 shadow-sm border border-gray-100">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-xl font-bold text-gray-800">Meal Building Flow</h3>
            <p className="text-sm text-gray-500">
              Create a meal, add ingredients to the catalog if needed, then connect ingredients to the selected meal.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <FlowPill label="Create Meal" active />
            <ArrowRight size={16} className="text-gray-300" />
            <FlowPill label="Ingredient Catalog" active={ingredients.length > 0} />
            <ArrowRight size={16} className="text-gray-300" />
            <FlowPill label="Connect to Meal" active={!!selectedMeal} />
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <FormHeader
            icon={<Plus size={20} />}
            title="Create Meal"
            description="Meals are used by the weekly planner."
            color="orange"
          />

          <div className="space-y-4">
            <input
              value={mealForm.name}
              onChange={(e) => setMealForm({ ...mealForm, name: e.target.value })}
              placeholder="Meal name"
              className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-orange-500"
            />

            <select
              value={mealForm.type}
              onChange={(e) => setMealForm({ ...mealForm, type: e.target.value })}
              className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-orange-500"
            >
              <option value="breakfast">Breakfast</option>
              <option value="snack">Snack</option>
              <option value="lunch">Lunch</option>
              <option value="afternoonSnack">Afternoon Snack</option>
            </select>

            <textarea
              value={mealForm.description}
              onChange={(e) => setMealForm({ ...mealForm, description: e.target.value })}
              placeholder="Description"
              className="min-h-28 w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-orange-500"
            />

            <button
              onClick={createMeal}
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-3 font-bold text-white hover:bg-orange-600 disabled:opacity-50"
            >
              <Plus size={18} />
              Add Meal
            </button>
          </div>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <FormHeader
            icon={<PackagePlus size={20} />}
            title="Ingredient Catalog"
            description="Reusable pantry items used across meals."
            color="emerald"
          />

          <div className="space-y-4">
            <input
              value={ingredientForm.name}
              onChange={(e) =>
                setIngredientForm({ ...ingredientForm, name: e.target.value })
              }
              placeholder="Ingredient name"
              className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-emerald-500"
            />

            <select
              value={ingredientForm.unit}
              onChange={(e) =>
                setIngredientForm({ ...ingredientForm, unit: e.target.value })
              }
              className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-emerald-500"
            >
              <option value="count">Count</option>
              <option value="g">Grams</option>
              <option value="ml">Milliliters</option>
              <option value="oz">Ounces</option>
              <option value="lb">Pounds</option>
              <option value="gal">Gallons</option>
            </select>

            <button
              onClick={createIngredient}
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 font-bold text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              <PackagePlus size={18} />
              Add to Catalog
            </button>
          </div>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <FormHeader
            icon={<Link2 size={20} />}
            title="Connect Ingredient to Meal"
            description="This is what drives shopping calculations."
            color="sky"
          />

          {!selectedMeal ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-5 text-sm text-gray-500">
              Select a meal below before assigning ingredients.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl bg-sky-50 p-4">
                <p className="text-xs uppercase tracking-wide text-sky-600">Selected Meal</p>
                <p className="mt-1 font-bold text-gray-800">{selectedMeal.name}</p>
                <p className="text-xs text-gray-500">{selectedMeal.type}</p>
              </div>

              <select
                value={assignForm.ingredientId}
                onChange={(e) =>
                  setAssignForm({ ...assignForm, ingredientId: e.target.value })
                }
                className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-sky-500"
              >
                <option value="">Select ingredient from catalog</option>
                {ingredients.map((ingredient) => (
                  <option key={ingredient.id} value={ingredient.id}>
                    {ingredient.name} ({ingredient.unit})
                  </option>
                ))}
              </select>

              <input
                type="number"
                min="0"
                value={assignForm.quantity}
                onChange={(e) =>
                  setAssignForm({ ...assignForm, quantity: Number(e.target.value) })
                }
                placeholder="Quantity per person"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-sky-500"
              />

              <button
                onClick={addIngredientToMeal}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-3 font-bold text-white hover:bg-sky-600 disabled:opacity-50"
              >
                <Link2 size={18} />
                Connect to Meal
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-3xl bg-white p-6 shadow-sm border border-gray-100">
          <h3 className="text-xl font-bold text-gray-800">Meals</h3>
          <p className="mt-1 text-sm text-gray-500">
            Click a meal to manage its ingredients.
          </p>

          {meals.length === 0 ? (
            <EmptyState
              title="No Meals Yet"
              description="Create a meal first, then connect ingredients to it."
            />
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-4">
              {meals.map((meal) => (
                <button
                  key={meal.id}
                  onClick={() => selectMeal(meal)}
                  className={`rounded-2xl border p-5 text-left transition ${
                    selectedMeal?.id === meal.id
                      ? 'border-orange-300 bg-orange-50 shadow-sm'
                      : 'border-gray-100 bg-gray-50 hover:border-orange-200 hover:bg-orange-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-lg font-bold text-gray-800">{meal.name}</p>
                      <p className="mt-1 inline-block rounded-full bg-orange-100 px-3 py-1 text-xs font-bold uppercase text-orange-700">
                        {meal.type}
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-gray-400">Select</span>
                  </div>

                  {meal.description && (
                    <p className="mt-3 text-sm text-gray-600">{meal.description}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-3xl bg-slate-950 p-6 text-white shadow-xl">
          <h3 className="text-xl font-bold">Selected Meal Recipe</h3>
          <p className="mt-1 text-sm text-slate-300">
            Ingredients connected to this meal. These quantities are used for the shopping list.
          </p>

          {!selectedMeal ? (
            <div className="mt-5 rounded-2xl bg-white/10 p-6 text-sm text-slate-300">
              Select a meal to view its recipe.
            </div>
          ) : (
            <div className="mt-5">
              <div className="mb-5 rounded-2xl bg-white/10 p-5">
                <p className="text-xs uppercase tracking-wide text-slate-400">Selected Meal</p>
                <p className="mt-1 text-2xl font-bold">{selectedMeal.name}</p>
                <p className="text-sm text-slate-300">{selectedMeal.type}</p>
              </div>

              {mealIngredients.length === 0 ? (
                <div className="rounded-2xl bg-white/10 p-6 text-sm text-slate-300">
                  No ingredients connected yet. Use “Connect Ingredient to Meal” above.
                </div>
              ) : (
                <div className="space-y-3">
                  {mealIngredients.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/10 p-4"
                    >
                      <div>
                        <p className="font-semibold text-white">
                          {getIngredientName(item.ingredientId)}
                        </p>
                        <p className="text-xs text-slate-400">
                          Used in {selectedMeal.name}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="text-lg font-bold text-emerald-300">
                          {item.quantity} {getIngredientUnit(item.ingredientId)}
                        </p>
                        <p className="text-xs text-slate-400">per person</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

const FlowPill = ({ label, active }: { label: string; active: boolean }) => (
  <span
    className={`rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wide ${
      active ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-400'
    }`}
  >
    {label}
  </span>
);

const FormHeader = ({
  icon,
  title,
  description,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: 'orange' | 'emerald' | 'sky';
}) => {
  const colors = {
    orange: 'bg-orange-100 text-orange-600',
    emerald: 'bg-emerald-100 text-emerald-600',
    sky: 'bg-sky-100 text-sky-600',
  };

  return (
    <div className="mb-5 flex items-center gap-3">
      <div className={`rounded-xl p-2 ${colors[color]}`}>{icon}</div>
      <div>
        <h3 className="text-xl font-bold text-gray-800">{title}</h3>
        <p className="text-sm text-gray-500">{description}</p>
      </div>
    </div>
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

export default MealsManagement;
