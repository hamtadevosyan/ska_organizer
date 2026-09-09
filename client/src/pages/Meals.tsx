import { useAuth } from '../auth/context';
import { useState } from 'react';
import { Utensils, CalendarDays, Settings } from 'lucide-react';
import MealPlanner from '../components/meals/MealPlanner';
import MealSetup from '../components/meals/MealSetup';

const Meals = () => {
  const { account } = useAuth();
  const canWrite = account?.role === 'admin' || account?.role === 'editor';
  const [activeTab, setActiveTab] = useState<'planner' | 'setup'>('planner');
  const [recipeMealId, setRecipeMealId] = useState<string>();
  const [catalogBusy, setCatalogBusy] = useState(false);

  return (
    <div className="p-6 space-y-6">
      <section className="print:hidden rounded-3xl bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 p-8 text-white shadow-xl">
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

      <div className="print:hidden rounded-2xl bg-white p-2 shadow-sm border border-gray-100 flex gap-2 w-fit">
        <button
          disabled={catalogBusy}
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
          disabled={catalogBusy || !canWrite}
          onClick={() => { setRecipeMealId(undefined); setActiveTab('setup'); }}
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

      {!canWrite && <p className="text-sm text-slate-600">Read-only access: you can review and print menus. Ask an editor to save changes or update recipes.</p>}
      <div hidden={activeTab !== 'planner'}><MealPlanner active={activeTab === 'planner'} canWrite={canWrite}
        onEditRecipe={canWrite ? (id) => { setRecipeMealId(id); setActiveTab('setup'); } : undefined} /></div>
      {canWrite && activeTab === 'setup' && <MealSetup initialMealId={recipeMealId} onBusyChange={setCatalogBusy} />}
    </div>
  );
};

export default Meals;
