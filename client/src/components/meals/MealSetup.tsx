import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Plus, PackagePlus, Link2 } from 'lucide-react';
import { API_BASE_URL } from '../../lib/api';

const MealSetup = () => {
  const [meals, setMeals] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [selectedMeal, setSelectedMeal] = useState(null);
  const [mealIngredients, setMealIngredients] = useState([]);

  const [mealForm, setMealForm] = useState({
    name: '',
    type: 'breakfast',
    description: '',
  });

  const [ingredientForm, setIngredientForm] = useState({
    name: '',
    unit: 'count',
  });

  const [assignForm, setAssignForm] = useState({
    ingredientId: '',
    quantity: 1,
  });

  const ingredientMap = useMemo(() => {
    const map = {};
    ingredients.forEach(i => (map[i.id] = i));
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

  const loadMealIngredients = async (mealId) => {
    const res = await axios.get(`${API_BASE_URL}/api/meals/${mealId}/ingredients`);
    setMealIngredients(res.data.data || []);
  };

  useEffect(() => {
    loadMeals();
    loadIngredients();
  }, []);

  const createMeal = async () => {
    await axios.post(`${API_BASE_URL}/api/meals`, mealForm);
    setMealForm({ name: '', type: 'breakfast', description: '' });
    loadMeals();
  };

  const createIngredient = async () => {
    await axios.post(`${API_BASE_URL}/api/ingredients`, {
      ...ingredientForm,
      shelfLifeDays: null,
    });
    setIngredientForm({ name: '', unit: 'count' });
    loadIngredients();
  };

  const selectMeal = async (meal) => {
    setSelectedMeal(meal);
    await loadMealIngredients(meal.id);
  };

  const assignIngredient = async () => {
    await axios.post(
      `${API_BASE_URL}/api/meals/${selectedMeal.id}/ingredients`,
      assignForm
    );

    setAssignForm({ ingredientId: '', quantity: 1 });
    loadMealIngredients(selectedMeal.id);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* CREATE MEAL */}
        <div className="bg-white p-5 rounded-2xl border">
          <h3 className="font-bold mb-3">Create Meal</h3>

          <input
            placeholder="Meal name"
            value={mealForm.name}
            onChange={(e) => setMealForm({ ...mealForm, name: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 mb-2"
          />

          <select
            value={mealForm.type}
            onChange={(e) => setMealForm({ ...mealForm, type: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 mb-2"
          >
            <option value="breakfast">Breakfast</option>
            <option value="snack">Snack</option>
            <option value="lunch">Lunch</option>
            <option value="afternoonSnack">Afternoon Snack</option>
          </select>

          <button
            onClick={createMeal}
            className="w-full bg-orange-500 text-white py-2 rounded-lg"
          >
            <Plus size={16} /> Add Meal
          </button>
        </div>

        {/* INGREDIENT CATALOG */}
        <div className="bg-white p-5 rounded-2xl border">
          <h3 className="font-bold mb-3">Ingredient Catalog</h3>

          <input
            placeholder="Ingredient name"
            value={ingredientForm.name}
            onChange={(e) =>
              setIngredientForm({ ...ingredientForm, name: e.target.value })
            }
            className="w-full border rounded-lg px-3 py-2 mb-2"
          />

          <select
            value={ingredientForm.unit}
            onChange={(e) =>
              setIngredientForm({ ...ingredientForm, unit: e.target.value })
            }
            className="w-full border rounded-lg px-3 py-2 mb-2"
          >
            <option value="count">Count</option>
            <option value="g">g</option>
            <option value="ml">ml</option>
            <option value="oz">oz</option>
            <option value="lb">lb</option>
            <option value="gal">gal</option>
          </select>

          <button
            onClick={createIngredient}
            className="w-full bg-emerald-500 text-white py-2 rounded-lg"
          >
            <PackagePlus size={16} /> Add Ingredient
          </button>
        </div>

        {/* ASSIGN */}
        <div className="bg-white p-5 rounded-2xl border">
          <h3 className="font-bold mb-3">Assign Ingredient</h3>

          {!selectedMeal ? (
            <p className="text-sm text-gray-500">Select meal first</p>
          ) : (
            <>
              <select
                value={assignForm.ingredientId}
                onChange={(e) =>
                  setAssignForm({ ...assignForm, ingredientId: e.target.value })
                }
                className="w-full border rounded-lg px-3 py-2 mb-2"
              >
                <option value="">Select ingredient</option>
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>

              <input
                type="number"
                value={assignForm.quantity}
                onChange={(e) =>
                  setAssignForm({ ...assignForm, quantity: Number(e.target.value) })
                }
                className="w-full border rounded-lg px-3 py-2 mb-2"
              />

              <button
                onClick={assignIngredient}
                className="w-full bg-sky-500 text-white py-2 rounded-lg"
              >
                <Link2 size={16} /> Assign
              </button>
            </>
          )}
        </div>
      </div>

      {/* MEALS LIST */}
      <div className="bg-white p-5 rounded-2xl border">
        <h3 className="font-bold mb-3">Meals</h3>

        <div className="grid grid-cols-2 gap-3">
          {meals.map((meal) => (
            <button
              key={meal.id}
              onClick={() => selectMeal(meal)}
              className="border p-3 rounded-lg text-left"
            >
              {meal.name}
            </button>
          ))}
        </div>
      </div>

      {/* RECIPE */}
      {selectedMeal && (
        <div className="bg-gray-900 text-white p-5 rounded-2xl">
          <h3 className="font-bold mb-3">{selectedMeal.name}</h3>

          {mealIngredients.map((mi) => (
            <div key={mi.id} className="flex justify-between mb-2">
              <span>{ingredientMap[mi.ingredientId]?.name}</span>
              <span>
                {mi.quantity} {ingredientMap[mi.ingredientId]?.unit}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MealSetup;
