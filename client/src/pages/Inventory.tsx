import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Plus, Package, FolderOpen, ArrowLeft, Utensils } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { adjustInventory, compatibleStockUnits, foodUnits, inventoryRequestId, inventoryUnits, inventoryUrl, saveInventory } from '../api/inventory';
import type { InventoryDetails, InventoryFilters, InventoryItem } from '../api/inventory';
import { useInventory } from '../components/inventory/useInventory';
import { InventoryHistory } from '../components/inventory/InventoryHistory';
import { useInventoryGroups } from '../components/inventory/useInventoryGroups';
import { InventoryGroupForm } from '../components/inventory/InventoryGroupForm';
import { PurchaseReceiptForm } from '../components/inventory/PurchaseReceiptForm';
import { PurchaseHistory } from '../components/inventory/PurchaseHistory';
import { AddItemForm } from '../components/inventory/AddItemForm';
import { resultingQuantity, unitNames } from '../components/inventory/quantity';

type Ingredient = { id: string; name: string; unit: string; archived?: boolean };
type Mode = 'create' | 'edit' | 'adjust' | 'receive';
const initial: InventoryFilters = { q: '', groupId: '', location: '', status: 'all', page: 1 };
const empty: InventoryDetails = { name: '', groupId: '', location: '', unit: 'count', ingredientId: null, reorderThreshold: '0' };
const control = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 disabled:bg-slate-100';
const button = 'min-h-11 rounded-lg border bg-white px-4 py-2 disabled:opacity-50';
const primary = 'min-h-11 rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50';
const stockLabel = { available: 'Available', low: 'Low stock', out: 'Out of stock' };
const validAmount = (value: string) => /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value);

export default function Inventory() {
  const { account } = useAuth();
  const canWrite = account?.role === 'admin' || account?.role === 'editor';
  const [showGroups, setShowGroups] = useState(true);
  const [newGroup, setNewGroup] = useState(false);
  const { groups, loading: groupLoading, error: groupError, refresh: refreshGroups, remember } = useInventoryGroups();
  const [filters, setFilters] = useState(initial);
  const [search, setSearch] = useState('');
  const { data, loading, error: loadError, refresh } = useInventory(filters, !showGroups);
  const [mode, setMode] = useState<Mode | null>(null);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [form, setForm] = useState(empty);
  const [reason, setReason] = useState('');
  const [lowStockEnabled, setLowStockEnabled] = useState(false);
  const [newFood, setNewFood] = useState(false);
  const [newFoodName, setNewFoodName] = useState('');
  const [adjustment, setAdjustment] = useState({ type: 'addition', quantity: '' });
  const [historyId, setHistoryId] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [purchasesFor, setPurchasesFor] = useState<{ itemId?: string; itemName?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestKey = useRef('');
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [ingredientLoading, setIngredientLoading] = useState(false);
  const [ingredientError, setIngredientError] = useState('');
  const ingredientRequest = useRef<AbortController | null>(null);
  const selectedGroup = groups.find((group) => group.id === form.groupId);
  const foodForm = selectedGroup?.kind === 'food' && mode === 'edit';
  const selectedFood = ingredients.find((ingredient) => ingredient.id === form.ingredientId) || editing?.ingredient;
  const stockExists = !!editing && Number(editing.quantity) > 0;
  const foodLocked = stockExists && !!editing?.ingredientId;
  const currentGroup = groups.find((group) => group.id === filters.groupId);
  const loadIngredients = useCallback(async () => {
    ingredientRequest.current?.abort();
    const request = new AbortController(); ingredientRequest.current = request;
    setIngredientLoading(true); setIngredientError('');
    try {
      const response = await axios.get<{ data: Ingredient[] }>(API_BASE_URL + '/api/ingredients', { params: { includeArchived: true }, signal: request.signal });
      if (!request.signal.aborted) setIngredients(response.data.data);
    } catch (failure) {
      if (!request.signal.aborted && !axios.isCancel(failure)) setIngredientError(authError(failure, 'Could not load ingredient choices. Use Refresh inventory to try again.'));
    } finally { if (!request.signal.aborted) setIngredientLoading(false); }
  }, []);
  useEffect(() => {
    if (foodForm) void loadIngredients();
    else { ingredientRequest.current?.abort(); setIngredientLoading(false); setIngredientError(''); }
    return () => ingredientRequest.current?.abort();
  }, [foodForm, loadIngredients]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  useEffect(() => {
    if (!loading && data && data.page === filters.page && filters.page > pages) setFilters((current) => ({ ...current, page: pages }));
  }, [loading, data, filters.page, pages]);

  function open(next: Mode, item: InventoryItem | null = null, changeType = 'usage') {
    setShowGroups(false);
    setMode(next); setEditing(item);
    setForm(item ? { name: item.name, groupId: item.groupId, location: item.location, unit: item.unit, ingredientId: item.ingredientId, reorderThreshold: item.reorderThreshold } : { ...empty, groupId: showGroups ? '' : filters.groupId });
    setLowStockEnabled(Number(item?.reorderThreshold || 0) > 0); setNewFood(false); setNewFoodName('');
    setReason(''); setAdjustment({ type: changeType, quantity: '' });
    setFields({}); setError(''); setMessage(''); setConflict(false); requestKey.current = inventoryRequestId();
  }
  function close() { setMode(null); setEditing(null); setFields({}); setError(''); setConflict(false); }
  function failureMessage(failure: unknown) {
    if (axios.isCancel(failure)) return;
    setError(authError(failure, 'Could not save inventory. Your entries are still here; retry the same save.'));
    if (axios.isAxiosError(failure)) {
      setFields(failure.response?.data?.error?.fields || {});
      setConflict(['INVENTORY_CONFLICT', 'INVENTORY_REQUEST_CONFLICT'].includes(failure.response?.data?.error?.code));
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !mode || mode === 'receive' || mode === 'create' || conflict) return;
    const invalid: Record<string, string> = {};
    if (reason.trim().length > 500) invalid.reason = 'Keep notes within 500 characters.';
    if (mode === 'adjust') {
      if (!validAmount(adjustment.quantity) || (adjustment.type !== 'correction' && Number(adjustment.quantity) === 0)) invalid.quantity = 'Enter a valid quantity; additions and usage must be greater than zero.';
    } else {
      for (const [key, max] of [['name', 100], ['location', 200]] as const) {
        if (!form[key].trim() || form[key].trim().length > max) invalid[key] = `Enter ${key} between 1 and ${max} characters.`;
      }
      if (!selectedGroup) invalid.groupId = 'Choose an inventory group.';
      if (form.ingredientId && selectedGroup?.kind !== 'food') invalid.groupId = 'Choose a food stock group for an ingredient-linked item.';
      if (lowStockEnabled && (!validAmount(form.reorderThreshold) || Number(form.reorderThreshold) <= 0)) invalid.reorderThreshold = 'Enter a low-stock level greater than zero.';
      if (foodForm && !form.ingredientId && !newFood) invalid.ingredientId = 'Choose a food or add a new one so Meals can count this stock.';
      if (foodForm && (ingredientLoading || ingredientError)) invalid.ingredientId = 'Wait for the food list to load, or retry loading it.';
      if (foodForm && newFood && (!newFoodName.trim() || newFoodName.trim().length > 100)) invalid.newIngredient = 'Enter a food name between 1 and 100 characters.';
    }
    setFields(invalid);
    if (Object.keys(invalid).length) { setError('Correct the highlighted inventory details.'); return; }
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const saved = mode === 'adjust' && editing
        ? await adjustInventory(editing, { ...adjustment, reason: reason.trim() || (adjustment.type === 'usage' ? 'Used in daily activities' : adjustment.type === 'correction' ? 'Physical count checked' : 'Items added') }, requestKey.current)
        : await saveInventory(editing, { ...form, name: form.name.trim(), location: form.location.trim(), reorderThreshold: lowStockEnabled ? form.reorderThreshold : '0', reason: reason.trim() || 'Inventory details updated', ...(foodForm && newFood ? { newIngredient: { name: newFoodName.trim(), unit: form.unit } } : {}) }, requestKey.current);
      close(); setMessage(mode === 'adjust' ? 'Amount updated.' : 'Details saved.');
      if (mode !== 'adjust') { setFilters({ ...initial, groupId: saved.groupId }); setSearch(''); }
      if (historyId === saved.id) setHistoryRefresh((value) => value + 1);
      await Promise.all([refresh(), refreshGroups()]);
    } catch (failure) { failureMessage(failure); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reloadItem() {
    if (!editing || !mode || busyRef.current || !window.confirm('Replace your unsaved entries with the latest inventory details?')) return;
    busyRef.current = true; setBusy(true);
    try {
      const response = await axios.get<{ data: InventoryItem }>(inventoryUrl + '/' + encodeURIComponent(editing.id));
      open(mode, response.data.data, adjustment.type); setMessage('Latest stock loaded. Review the quantities before saving.');
      await Promise.all([refresh(), refreshGroups(), ...(foodForm ? [loadIngredients()] : [])]);
    } catch (failure) { failureMessage(failure); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const applyFilters = (next: Partial<InventoryFilters>) => setFilters((current) => ({ ...current, ...next, page: 1 }));
  const attributes = (key: string) => ({ 'aria-invalid': !!fields[key], 'aria-describedby': fields[key] ? 'inventory-error-' + key : undefined });
  const fieldError = (key: string) => fields[key] && <p id={'inventory-error-' + key} className="mt-1 text-sm text-red-700">{fields[key]}</p>;
  const browseGroup = (groupId: string) => { setFilters({ ...initial, groupId }); setSearch(''); setHistoryId(''); setMessage(''); setShowGroups(false); };
  const totals = currentGroup?.summary || data?.summary;
  const afterAmount = editing ? resultingQuantity(editing.quantity, adjustment.quantity, adjustment.type) : null;
  return <div className="mx-auto max-w-7xl space-y-6 p-2 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-3xl font-bold text-slate-900">Inventory</h1><p className="mt-2 text-slate-600">See what you have. Add what you bought. Record what you used.</p></div>
      {!mode && !newGroup && <div className="flex items-center gap-3">
        {canWrite && <button disabled={busy || !!mode || newGroup || !groups.length} onClick={() => open('create')} className={primary + ' flex min-h-11 items-center gap-2'}><Plus size={18} />Add item</button>}
        <details className="relative"><summary className={button + ' min-h-11 cursor-pointer'}>More</summary><div className="absolute right-0 z-10 mt-2 grid w-52 gap-2 rounded-xl border bg-white p-3 shadow-lg">
          <button disabled={busy || loading || groupLoading || ingredientLoading || newGroup} onClick={() => void Promise.all([refresh(), refreshGroups(), ...(foodForm ? [loadIngredients()] : [])])} className={button}>Refresh inventory</button>
          <button disabled={busy || !!mode} onClick={() => setPurchasesFor({})} className={button}>Purchase history</button>
          {canWrite && <button disabled={busy || !!mode || newGroup} onClick={() => { setNewGroup(true); setMessage(''); }} className={button}>Add group</button>}
        </div></details>
      </div>}
    </header>
    {groupError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{groupError}</p>}
    {!showGroups && loadError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{loadError}</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    {canWrite && newGroup && <InventoryGroupForm onCancel={() => setNewGroup(false)} onSaved={(group) => {
      remember(group); setNewGroup(false); browseGroup(group.id); setMessage('Group created. Add the items you keep here.'); void refreshGroups();
    }} />}
    {showGroups && !newGroup ? <section aria-label="Inventory groups" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">Your inventory groups</h2>
        {!!groups.length && <button disabled={newGroup} className={button} onClick={() => browseGroup('')}>View all items</button>}</div>
      {groupLoading && <p role="status">Loading inventory groups…</p>}
      {!groupLoading && !groupError && !groups.length && <div className="rounded-2xl border border-dashed bg-white p-8 text-center">
        <FolderOpen className="mx-auto mb-3 text-emerald-700" size={32} /><p className="font-semibold">No inventory groups yet.</p>
        <p className="mt-2 text-slate-600">{canWrite ? 'Create a group first, then add its items.' : 'An administrator or editor can create inventory groups.'}</p>
        <p className="mt-2 text-sm text-slate-500">For example: Food, Toys, or Cleaning Supplies.</p>
        {canWrite && <button className={primary + ' mt-4 min-h-11'} onClick={() => setNewGroup(true)}>Add your first group</button>}
      </div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{groups.map((group) => <button key={group.id} disabled={newGroup}
        aria-label={'Open group ' + group.name} onClick={() => browseGroup(group.id)} className="rounded-2xl border bg-white p-5 text-left shadow-sm hover:border-emerald-400 disabled:opacity-50">
        <div className="flex items-center justify-between gap-2">{group.kind === 'food' ? <Utensils className="text-emerald-700" size={24} /> : <FolderOpen className="text-emerald-700" size={24} />}<span className="text-sm text-slate-500">{group.kind === 'food' ? 'Food stock' : 'Supplies & equipment'}</span></div>
        <h3 className="mt-4 text-lg font-semibold">{group.name}</h3>{group.description && <p className="mt-1 text-sm text-slate-600">{group.description}</p>}
        <p className="mt-4 font-semibold">{group.summary.total} {group.summary.total === 1 ? 'item' : 'items'}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-sm"><span className="text-amber-800">{group.summary.lowStock > 0 ? group.summary.lowStock + ' running low' : ''}</span><span className="text-red-800">{group.summary.outOfStock > 0 ? group.summary.outOfStock + ' empty' : ''}</span></div>
      </button>)}</div>
    </section> : !showGroups && !newGroup ? <div className="flex flex-wrap items-center justify-between gap-3">
      <div><button disabled={busy || !!mode || newGroup} onClick={() => { setShowGroups(true); setFilters(initial); setSearch(''); setHistoryId(''); setMessage(''); }} className="mb-2 flex items-center gap-2 text-emerald-800 disabled:opacity-50"><ArrowLeft size={16} />All groups</button>
        <h2 className="text-2xl font-bold">{currentGroup?.name || 'All inventory items'}</h2>
        {currentGroup?.kind === 'food' && <p className="mt-1 text-sm text-slate-600">What you have here is counted in your meal shopping list.</p>}</div>
    </div> : null}
    {!showGroups && !mode && !newGroup && !loading && totals && <details><summary className="cursor-pointer py-2 text-slate-600">Overview</summary><div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {([[currentGroup ? 'Items in group' : 'All items', totals.total], ['Available', totals.available], ['Low stock', totals.lowStock], ['Out of stock', totals.outOfStock]] as const).map(([label, count]) =>
        <div key={label} className="rounded-xl border bg-white p-4"><p className="text-sm text-slate-600">{label}</p><p className="mt-1 text-2xl font-bold">{count}</p></div>)}
    </div></details>}
    {canWrite && mode === 'create' && <AddItemForm groups={groups} initialGroupId={form.groupId} onCancel={close} onBusy={setBusy} onSaved={(saved) => {
      close(); setFilters({ ...initial, groupId: saved.groupId }); setSearch(''); setMessage('Item added.'); void Promise.all([refresh(), refreshGroups()]);
    }} />}
    {canWrite && mode === 'receive' && editing && <PurchaseReceiptForm key={editing.id + ':' + editing.version} item={editing} onCancel={close}
      onBusy={setBusy} onReload={() => void reloadItem()} onSaved={() => {
        close(); setMessage('Added to what you have.');
        setHistoryRefresh((value) => value + 1); void Promise.all([refresh(), refreshGroups()]);
      }} />}
    {canWrite && (mode === 'edit' || mode === 'adjust') && <form aria-label="Inventory details" onSubmit={(event) => void submit(event)} noValidate className="rounded-2xl border bg-white p-5 shadow-sm">
      <fieldset disabled={busy} className="space-y-4"><h2 className="text-xl font-bold">{mode === 'adjust' ? (adjustment.type === 'usage' ? 'Used some: ' : adjustment.type === 'correction' ? 'Check the amount: ' : 'Add items: ') + editing?.name : 'Edit item details'}</h2>
        {mode === 'adjust' && editing ? <>
          <p>You have <strong>{editing.quantity} {unitNames[editing.unit]}</strong> · {editing.location}</p>
          <div className="max-w-md"><label className="block">{adjustment.type === 'correction' ? 'How much is there now?' : adjustment.type === 'usage' ? 'How much did you use?' : 'How much are you adding?'} ({unitNames[editing.unit]})<input autoFocus className={control} inputMode="decimal" {...attributes('quantity')} value={adjustment.quantity} onChange={(event) => setAdjustment({ ...adjustment, quantity: event.target.value })} /></label>{fieldError('quantity')}</div>
          {afterAmount !== null && <p className="rounded-lg bg-emerald-50 p-3">After saving: <strong>{afterAmount} {unitNames[editing.unit]} left.</strong></p>}
          {adjustment.type === 'correction' && <p className="text-sm text-slate-600">Enter the total you can see, including zero.</p>}
          <details><summary className="cursor-pointer py-2 text-slate-600">Other changes</summary><label className="block max-w-md">Change type<select className={control} value={adjustment.type} onChange={(event) => setAdjustment({ ...adjustment, type: event.target.value })}>
            <option value="usage">Used some</option><option value="correction">Check the amount</option><option value="addition">Added without a purchase</option>
          </select></label></details>
        </> : <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label>Inventory group<select className={control} {...attributes('groupId')} value={form.groupId} onChange={(event) => {
              const group = groups.find((item) => item.id === event.target.value);
              setNewFood(false); setNewFoodName('');
              setForm({ ...form, groupId: event.target.value, ingredientId: group?.kind === 'food' ? form.ingredientId : (foodLocked ? form.ingredientId : null) });
            }}><option value="">Choose a group</option>{groups.map((group) => <option key={group.id} value={group.id} disabled={foodLocked && group.kind !== 'food'}>{group.name}</option>)}</select></label>{fieldError('groupId')}</div>
            {foodForm && <div><label>Food<select className={control} {...attributes('ingredientId')} disabled={foodLocked || ingredientLoading || !!ingredientError} value={newFood ? '__new__' : form.ingredientId || ''} onChange={(event) => {
              const adding = event.target.value === '__new__';
              const selected = ingredients.find((ingredient) => ingredient.id === event.target.value);
              setNewFood(adding);
              setForm({ ...form, ingredientId: selected?.id || null,
                unit: stockExists ? form.unit : selected?.unit || (foodUnits.includes(form.unit) ? form.unit : 'count') });
            }}><option value="">Choose a food</option><option value="__new__" disabled={stockExists && !foodUnits.includes(form.unit)}>+ Add a new food</option>
              {form.ingredientId && !ingredients.some((ingredient) => ingredient.id === form.ingredientId) && <option value={form.ingredientId} disabled>Current food unavailable</option>}
              {ingredients.filter((ingredient) => !ingredient.archived || ingredient.id === form.ingredientId).map((ingredient) => <option key={ingredient.id} value={ingredient.id} disabled={ingredient.archived || (stockExists && !compatibleStockUnits(form.unit, ingredient.unit))}>{ingredient.name} ({ingredient.unit}){ingredient.archived ? ' — archived' : ''}</option>)}
            </select></label>{fieldError('ingredientId')}<p className="mt-1 text-sm text-slate-600">Choose the same food used in your recipes. Meals will subtract this stock from the shopping list.</p></div>}
            {foodForm && newFood && <div><label>New food name<input className={control} maxLength={100} {...attributes('newIngredient')} value={newFoodName} onChange={(event) => {
              setNewFoodName(event.target.value);
            }} /></label>{fieldError('newIngredient')}<p className="mt-1 text-sm text-slate-600">This food will also be available for recipes in Meal Setup.</p></div>}
            {<div><label>Item name<input className={control} maxLength={100} {...attributes('name')} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>{fieldError('name')}</div>}
            <div><label>Unit<select className={control} {...attributes('unit')} disabled={stockExists} value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })}>{(foodForm ? foodUnits : inventoryUnits).map((unit) => <option key={unit} value={unit} disabled={!!foodForm && !newFood && !!form.ingredientId && !!selectedFood && !compatibleStockUnits(unit, selectedFood.unit)}>{unit}</option>)}{foodForm && !foodUnits.includes(form.unit) && <option value={form.unit}>{form.unit}</option>}</select></label>{fieldError('unit')}</div>
            <div><label>Where is it stored?<input className={control} maxLength={200} {...attributes('location')} value={form.location} list="inventory-location-options" placeholder="For example, kitchen pantry" onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>{fieldError('location')}</div>
          </div>
          <datalist id="inventory-location-options">{data?.options.locations.map((location) => <option key={location} value={location} />)}</datalist>
          <label className="flex items-center gap-2"><input type="checkbox" checked={lowStockEnabled} onChange={(event) => setLowStockEnabled(event.target.checked)} />Show a low-stock warning</label>
          {lowStockEnabled && <div><label>Low-stock level<input className={control} type="text" inputMode="decimal" {...attributes('reorderThreshold')} value={form.reorderThreshold} onChange={(event) => setForm({ ...form, reorderThreshold: event.target.value })} /></label>{fieldError('reorderThreshold')}<p className="mt-1 text-sm text-slate-600">Mark this item as Low stock when its quantity reaches this level or less, in {form.unit}. For example, 2 means a warning at 2 {form.unit} or below. This does not place an order.</p></div>}
          {selectedGroup?.kind === 'supplies' && <p className="text-sm text-slate-600">For food used in meals, choose a Food stock group so you can connect it to your recipes.</p>}
          {stockExists && <p className="text-sm text-slate-600">The recorded unit stays the same while stock remains. {foodLocked ? 'The connected food also stays the same.' : 'You can connect this stock to a food without changing its quantity.'} Use Bought more or Used some to change the amount.</p>}
          {foodForm && stockExists && !foodUnits.includes(form.unit) && <p className="text-sm text-amber-800">Meals needs a count, weight or volume. For boxes or packs, count or measure their contents before recording food stock.</p>}
          {<p className="text-sm text-slate-600">Changing the storage location moves this record's entire balance. Its previous location stays in history.</p>}
          {foodForm && ingredientError && <p role="alert" className="text-red-800">{ingredientError} <button type="button" className="underline" onClick={() => void loadIngredients()}>Retry food list</button></p>}
        </>}
        {<details open={fields.reason ? true : undefined}><summary className="cursor-pointer py-2 text-slate-600">Add a note (optional)</summary><label className="block">Notes (optional)<textarea className={control} maxLength={500} rows={2} {...attributes('reason')} value={reason} onChange={(event) => setReason(event.target.value)} />{fieldError('reason')}</label></details>}
        <div className="flex flex-wrap gap-3"><button disabled={conflict || (!!foodForm && (ingredientLoading || !!ingredientError))} className={primary}>{busy ? 'Saving…' : mode === 'adjust' ? 'Save amount' : 'Save details'}</button><button type="button" onClick={close} className={button}>Cancel</button>
          {conflict && editing && <button type="button" onClick={() => void reloadItem()} className={button}>Reload inventory item</button>}</div>
        {conflict && !editing && <p>Cancel this form and refresh inventory to check whether the item was already saved.</p>}
      </fieldset>
    </form>}
    {!showGroups && !mode && !newGroup && <form role="search" aria-label="Filter inventory" onSubmit={(event) => { event.preventDefault(); applyFilters({ q: search.trim() }); }} className="rounded-2xl border bg-white p-4">
      <fieldset disabled={busy || newGroup} className="flex flex-wrap items-end gap-3">
        <label className="min-w-40 flex-1">Search items<input type="search" maxLength={100} className={control} value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className={button}>Search</button>
        <details className="w-full"><summary className="cursor-pointer py-2 text-slate-600">More filters</summary><div className="mt-2 flex flex-wrap items-end gap-3"><label>Filter group<select className={control} value={filters.groupId} onChange={(event) => applyFilters({ groupId: event.target.value })}><option value="">All groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label>Filter location<select className={control} value={filters.location} onChange={(event) => applyFilters({ location: event.target.value })}><option value="">All locations</option>{[...new Set([...(data?.options.locations || []), ...(filters.location ? [filters.location] : [])])].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Stock status<select className={control} value={filters.status} onChange={(event) => applyFilters({ status: event.target.value })}><option value="all">All statuses</option>{Object.entries(stockLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className={button} onClick={() => { setSearch(''); setFilters({ ...initial, groupId: filters.groupId }); }}>Reset filters</button></div></details>
      </fieldset>
    </form>}
    {!showGroups && !mode && !newGroup && loading && <p role="status">Loading inventory…</p>}
    {!showGroups && !mode && !newGroup && !loading && data && <>
      <p className="text-sm text-slate-600">{data.total} {data.total === 1 ? 'item' : 'items'}</p>
      {!data.items.length ? <div className="rounded-2xl border border-dashed bg-white p-8 text-center"><Package className="mx-auto mb-3 text-emerald-700" size={30} /><p>No inventory matches these filters.</p>{canWrite && <p className="mt-2 text-slate-600">Reset filters or add an inventory item with the quantity you have.</p>}</div> :
        <div className="overflow-x-auto rounded-2xl border bg-white"><table className="block w-full text-left sm:table"><caption className="sr-only">Inventory items</caption><thead className="hidden sm:table-header-group bg-slate-50 text-sm text-slate-600"><tr>{['Item', 'Where', 'You have', 'Status', 'Actions'].map((label) => <th scope="col" key={label} className="p-4">{label}</th>)}</tr></thead>
          <tbody className="block sm:table-row-group">{data.items.map((item) => <tr key={item.id} className="block border-t sm:table-row"><th scope="row" className="block p-4 sm:table-cell"><span className="font-semibold">{item.name}</span><p className="mt-1 text-sm font-normal text-slate-500">{item.group.name}{item.ingredient?.archived ? ' · Food archived' : ''}</p>{item.group.kind === 'food' && !item.ingredientId && <p className="mt-1 text-sm font-normal text-amber-800">Choose a food under More to count this in your shopping list.</p>}</th>
            <td className="block px-4 py-1 sm:table-cell sm:p-4">{item.location}</td><td className="block px-4 py-1 font-semibold sm:table-cell sm:p-4">{item.quantity} {unitNames[item.unit]}</td><td className="block px-4 py-2 sm:table-cell sm:p-4"><span className={'rounded-full px-3 py-1 text-sm ' + (item.status === 'available' ? 'bg-emerald-50 text-emerald-800' : item.status === 'low' ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800')}>{stockLabel[item.status]}</span></td>
            <td className="block p-4 sm:table-cell"><div className="flex flex-wrap items-start gap-2 text-sm">
              {canWrite && <><button disabled={busy || newGroup} className={button + ' font-semibold text-emerald-800'} aria-label={'Bought more ' + item.name} onClick={() => open('receive', item)}>Bought more</button>
                <button disabled={busy || newGroup} className={button} aria-label={'Used some ' + item.name} onClick={() => open('adjust', item)}>Used some</button></>}
              <details><summary aria-label={'More for ' + item.name} className={button + ' cursor-pointer'}>More</summary><div className="mt-2 grid gap-2">
                {canWrite && <><button className={button} aria-label={'Check amount for ' + item.name} onClick={() => open('adjust', item, 'correction')}>Check the amount</button>
                  <button className={button} aria-label={item.group.kind === 'food' && !item.ingredientId ? 'Choose food for ' + item.name : 'Edit ' + item.name} onClick={() => open('edit', item)}>{item.group.kind === 'food' && !item.ingredientId ? 'Choose food' : 'Edit details'}</button></>}
                <button className={button} aria-label={'Purchases for ' + item.name} onClick={() => setPurchasesFor({ itemId: item.id, itemName: item.name })}>Purchases</button>
                <button className={button} aria-label={'History for ' + item.name} onClick={() => { setHistoryId(item.id); setHistoryRefresh((value) => value + 1); }}>History</button>
              </div></details>
            </div></td>
          </tr>)}</tbody></table></div>}
      {pages > 1 && <nav aria-label="Inventory pages" className="flex items-center justify-between gap-3"><button className={button} disabled={busy || newGroup || filters.page === 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Previous page</button><span>Page {filters.page} of {pages}</span><button className={button} disabled={busy || newGroup || filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Next page</button></nav>}
    </>}
    {historyId && <InventoryHistory key={historyId + ':' + historyRefresh} itemId={historyId} onClose={() => setHistoryId('')} />}
    {purchasesFor && <PurchaseHistory key={(purchasesFor.itemId || 'all') + ':' + historyRefresh} {...purchasesFor} onClose={() => setPurchasesFor(null)} />}
  </div>;
}
