import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../../lib/api';
import { authError } from '../../auth/transport';
import { compatibleStockUnits, foodUnits, inventoryRequestId, inventoryUnits, saveInventory } from '../../api/inventory';
import type { InventoryGroup, InventoryItem } from '../../api/inventory';
import { unitNames, validQuantity } from './quantity';

type Food = { id: string; name: string; unit: string; archived?: boolean };
const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const defaultUnit = (unit: string) => ['g', 'oz', 'lb'].includes(unit) ? 'lb' : ['ml', 'gal'].includes(unit) ? 'gal' : unit;
const control = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-3 disabled:bg-slate-100';
const button = 'min-h-11 rounded-lg border bg-white px-4 py-2 disabled:opacity-50';

export function AddItemForm({ groups, initialGroupId, onCancel, onSaved, onBusy }: {
  groups: InventoryGroup[]; initialGroupId: string; onCancel: () => void; onSaved: (item: InventoryItem) => void; onBusy: (busy: boolean) => void;
}) {
  const [groupId, setGroupId] = useState(initialGroupId || (groups.length === 1 ? groups[0].id : ''));
  const [name, setName] = useState(''); const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('count'); const [location, setLocation] = useState('');
  const [warning, setWarning] = useState(''); const [foods, setFoods] = useState<Food[]>([]);
  const [chosenFood, setChosenFood] = useState<Food | null>(null);
  const [loading, setLoading] = useState(false); const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0); const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false); const [conflict, setConflict] = useState(false);
  const pending = useRef(false); const [requestId] = useState(inventoryRequestId);
  const group = groups.find((candidate) => candidate.id === groupId);
  const isFood = group?.kind === 'food';
  const sameName = foods.filter((food) => normalized(food.name) === normalized(name));
  const food = chosenFood || (sameName.length === 1 && !sameName[0].archived ? sameName[0] : null);
  const suggestions = isFood && !food && name.trim() ? foods.filter((candidate) => !candidate.archived && normalized(candidate.name).includes(normalized(name))).slice(0, 8) : [];
  useEffect(() => {
    if (!isFood) return;
    const request = new AbortController(); setLoading(true); setLoadError('');
    axios.get<{ data: Food[] }>(API_BASE_URL + '/api/ingredients', { params: { includeArchived: true }, signal: request.signal })
      .then(({ data }) => { if (!request.signal.aborted) setFoods(data.data); })
      .catch((failure) => { if (!request.signal.aborted) setLoadError(authError(failure, 'Could not load food names. Please retry.')); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [isFood, retry]);
  function changeName(value: string) {
    setName(value); setChosenFood(null);
    const matches = foods.filter((candidate) => normalized(candidate.name) === normalized(value));
    if (isFood && matches.length === 1 && !matches[0].archived) setUnit(defaultUnit(matches[0].unit));
  }
  function changeGroup(value: string) {
    setGroupId(value); setChosenFood(null); setName(''); setUnit('count');
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (pending.current || conflict) return;
    const invalid: Record<string, string> = {};
    if (!group) invalid.groupId = 'Choose a group.';
    if (!name.trim() || name.trim().length > 100) invalid.name = 'Enter an item name, up to 100 characters.';
    if (!validQuantity(quantity)) invalid.openingQuantity = 'Enter how much you have. Use 0 if there is none.';
    if (!location.trim() || location.trim().length > 200) invalid.location = 'Enter where you keep it.';
    if (warning !== '' && (!validQuantity(warning) || Number(warning) <= 0)) invalid.reorderThreshold = 'Enter an amount greater than zero, or leave this empty.';
    if (isFood && (loading || loadError)) invalid.name = 'Wait for the food names to load, or retry.';
    if (isFood && !food && sameName.length) invalid.name = sameName.every((candidate) => candidate.archived)
      ? 'This food is archived. Restore it in Meal Setup or use a different name.' : 'Choose the matching food below.';
    if (isFood && food && !compatibleStockUnits(unit, food.unit)) invalid.unit = 'Choose a unit that matches this food.';
    setFields(invalid);
    if (Object.keys(invalid).length) { setError('Check the highlighted answers.'); return; }
    pending.current = true; setSaving(true); onBusy(true); setError('');
    try {
      const saved = await saveInventory(null, { name: name.trim(), groupId, location: location.trim(), unit,
        ingredientId: isFood && food ? food.id : null, openingQuantity: quantity, reorderThreshold: warning || '0',
        reason: 'Initial quantity recorded', ...(isFood && !food ? { newIngredient: { name: name.trim(), unit } } : {}),
      }, requestId);
      onSaved(saved);
    } catch (failure) {
      setError(authError(failure, 'Could not confirm the save. Your answers are still here; try Save item again.'));
      if (axios.isAxiosError(failure)) {
        const errors = failure.response?.data?.error?.fields || {};
        setFields({ ...errors, name: errors.name || errors.ingredientId || errors.newIngredient });
        setConflict(['INVENTORY_CONFLICT', 'INVENTORY_REQUEST_CONFLICT'].includes(failure.response?.data?.error?.code));
      }
    } finally { pending.current = false; setSaving(false); onBusy(false); }
  }
  const attributes = (key: string) => ({ 'aria-invalid': !!fields[key], 'aria-describedby': fields[key] ? 'add-item-' + key : undefined });
  const fieldError = (key: string) => fields[key] && <p id={'add-item-' + key} className="mt-1 text-sm text-red-700">{fields[key]}</p>;
  const groupSelect = <div><label>Group<select className={control} value={groupId} {...attributes('groupId')} onChange={(event) => changeGroup(event.target.value)}>
    <option value="">Choose a group</option>{groups.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
  </select></label>{fieldError('groupId')}</div>;
  return <form aria-label="Add item" noValidate onSubmit={(event) => void save(event)} className="max-w-2xl rounded-2xl border bg-white p-5 shadow-sm">
    <fieldset disabled={saving} className="space-y-5">
      <h2 className="text-xl font-bold">Add an item</h2>
      {initialGroupId && group && <p className="text-slate-600">Adding to {group.name}</p>}
      {error && <p role="alert" className="text-red-800">{error}</p>}
      {!initialGroupId && groupSelect}
      {loading && <p role="status">Loading food names…</p>}
      {loadError && <p role="alert">{loadError} <button type="button" className={button} onClick={() => setRetry(retry + 1)}>Retry food names</button></p>}
      <div><label>1. What is it?<input autoFocus className={control} maxLength={100} disabled={isFood && (loading || !!loadError)} {...attributes('name')} value={name} onChange={(event) => changeName(event.target.value)} /></label>{fieldError('name')}
        {!!suggestions.length && <div className="mt-2 flex flex-wrap gap-2" aria-label="Matching foods">{suggestions.map((candidate) => <button type="button" key={candidate.id} className={button} onClick={() => {
          setChosenFood(candidate); setName(candidate.name.slice(0, 100)); setUnit(defaultUnit(candidate.unit));
        }}>{candidate.name}{sameName.length > 1 ? ' (' + unitNames[candidate.unit] + ')' : ''}</button>)}</div>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label>2. How much do you have?<input className={control} inputMode="decimal" {...attributes('openingQuantity')} value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>{fieldError('openingQuantity')}</div>
        <div><label>Measured in<select className={control} {...attributes('unit')} value={unit} onChange={(event) => setUnit(event.target.value)}>{(isFood ? foodUnits : inventoryUnits).filter((candidate) => !isFood || !food || compatibleStockUnits(candidate, food.unit)).map((candidate) => <option key={candidate} value={candidate}>{unitNames[candidate]}</option>)}</select></label>{fieldError('unit')}</div>
      </div>
      <div><label>3. Where do you keep it?<input className={control} maxLength={200} {...attributes('location')} value={location} onChange={(event) => setLocation(event.target.value)} /></label>{fieldError('location')}
        <div className="mt-2 flex flex-wrap gap-2">{(isFood ? ['Kitchen pantry', 'Refrigerator', 'Freezer'] : ['Classroom', 'Supply closet', 'Office']).map((place) => <button type="button" key={place} className={button} onClick={() => setLocation(place)}>{place}</button>)}</div>
      </div>
      <details open={fields.groupId || fields.reorderThreshold ? true : undefined} className="rounded-lg border p-3"><summary className="cursor-pointer py-1">Optional details</summary><div className="mt-3 space-y-4">
        {initialGroupId && groupSelect}
        <div><label>Show a warning when this much is left<input className={control} inputMode="decimal" {...attributes('reorderThreshold')} value={warning} onChange={(event) => setWarning(event.target.value)} /></label>{fieldError('reorderThreshold')}<p className="mt-1 text-sm text-slate-500">Leave empty if you do not need a warning.</p></div>
      </div></details>
      {name.trim() && location.trim() && validQuantity(quantity) && <p className="rounded-lg bg-emerald-50 p-3">You have {quantity} {unitNames[unit]} of {name.trim()} in {location.trim()}.</p>}
      {conflict && <p>Cancel and check the item list before adding this again. It may already be saved.</p>}
      <div className="flex gap-3"><button disabled={conflict || (isFood && (loading || !!loadError))} className="min-h-11 rounded-lg bg-emerald-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save item'}</button><button type="button" className={button} onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>;
}
