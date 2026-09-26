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
    <div className="ska-page ska-core-page space-y-6">
      <header className="ska-page-head print:hidden"><div>
        <h1><span className="ska-heading-icon is-yellow"><Utensils size={24} aria-hidden="true" /></span>Meals</h1>
        <p>Plan the week’s meals and see what to buy.</p>
      </div></header>

      <div className="ska-meal-tabs print:hidden" role="group" aria-label="Meal views">
        <button
          disabled={catalogBusy}
          onClick={() => setActiveTab('planner')}
          aria-pressed={activeTab === 'planner'}
        >
          <CalendarDays size={18} />
          Planner
        </button>

        <button
          disabled={catalogBusy || !canWrite}
          onClick={() => { setRecipeMealId(undefined); setActiveTab('setup'); }}
          aria-pressed={activeTab === 'setup'}
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
