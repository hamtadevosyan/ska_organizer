import React, { useState } from 'react';
import { Utensils, CalendarDays, Settings } from 'lucide-react';
import MealPlanner from '../components/meals/MealPlanner';
import MealSetup from '../components/meals/MealSetup';

const Meals = () => {
  const [activeTab, setActiveTab] = useState<'planner' | 'setup'>('planner');

  return (
    <div className="p-6 space-y-6">
      <section className="rounded-3xl bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 p-8 text-white shadow-xl">
        <div className="flex items-center gap-4">
          <div className="rounded-2xl bg-white/20 p-4">
            <Utensils size={32} />
          </div>
          <div>
            <h2 className="text-4xl font-bold">Meals</h2>
            <p className="mt-2 text-sm text-emerald-50">
              Manage meals, build recipes, generate menus, and prepare shopping lists.
            </p>
          </div>
        </div>
      </section>

      <div className="rounded-2xl bg-white p-2 shadow-sm border border-gray-100 flex gap-2 w-fit">
        <button
          onClick={() => setActiveTab('planner')}
          className={`flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold ${
            activeTab === 'planner'
              ? 'bg-emerald-500 text-white'
              : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          <CalendarDays size={18} />
          Planner
        </button>

        <button
          onClick={() => setActiveTab('setup')}
          className={`flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold ${
            activeTab === 'setup'
              ? 'bg-orange-500 text-white'
              : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          <Settings size={18} />
          Meal Setup
        </button>
      </div>

      {activeTab === 'planner' ? <MealPlanner /> : <MealSetup />}
    </div>
  );
};

export default Meals;
