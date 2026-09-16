import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Plus, Package, FolderOpen, ArrowLeft, Utensils } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { adjustInventory, inventoryRequestId, inventoryUnits, inventoryUrl, saveInventory } from '../api/inventory';
import type { InventoryDetails, InventoryFilters, InventoryItem } from '../api/inventory';
import { useInventory } from '../components/inventory/useInventory';
import { InventoryHistory } from '../components/inventory/InventoryHistory';
import { useInventoryGroups } from '../components/inventory/useInventoryGroups';
import { InventoryGroupForm } from '../components/inventory/InventoryGroupForm';

type Ingredient = { id: string; name: string; unit: string; archived?: boolean };
type Mode = 'create' | 'edit' | 'adjust';
const initial: InventoryFilters = { q: '', groupId: '', location: '', status: 'all', page: 1 };
const empty: InventoryDetails = { name: '', groupId: '', location: '', unit: 'count', ingredientId: null, reorderThreshold: '0' };
const control = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 disabled:bg-slate-100';
const button = 'rounded-lg border bg-white px-4 py-2 disabled:opacity-50';
const primary = 'rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50';
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
  const [openingQuantity, setOpeningQuantity] = useState('0');
  const [reason, setReason] = useState('');
  const [adjustment, setAdjustment] = useState({ type: 'addition', quantity: '' });
  const [historyId, setHistoryId] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
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
  const foodForm = selectedGroup?.kind === 'food' && (mode === 'create' || mode === 'edit');
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

  function open(next: Mode, item: InventoryItem | null = null) {
    setShowGroups(false);
    setMode(next); setEditing(item);
    setForm(item ? { name: item.name, groupId: item.groupId, location: item.location, unit: item.unit, ingredientId: item.ingredientId, reorderThreshold: item.reorderThreshold } : { ...empty, groupId: showGroups ? '' : filters.groupId });
    setOpeningQuantity('0'); setReason(''); setAdjustment({ type: 'addition', quantity: '' });
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
    if (busyRef.current || !mode || conflict) return;
    const invalid: Record<string, string> = {};
    if (!reason.trim() || reason.trim().length > 500) invalid.reason = 'Enter a reason between 1 and 500 characters.';
    if (mode === 'adjust') {
      if (!validAmount(adjustment.quantity) || (adjustment.type !== 'correction' && Number(adjustment.quantity) === 0)) invalid.quantity = 'Enter a valid quantity; additions and usage must be greater than zero.';
    } else {
      for (const [key, max] of [['name', 100], ['location', 200]] as const) {
        if (!form[key].trim() || form[key].trim().length > max) invalid[key] = `Enter ${key} between 1 and ${max} characters.`;
      }
      if (!selectedGroup) invalid.groupId = 'Choose an inventory group.';
      if (form.ingredientId && selectedGroup?.kind !== 'food') invalid.groupId = 'Choose a food stock group for an ingredient-linked item.';
      if (!validAmount(form.reorderThreshold)) invalid.reorderThreshold = 'Enter a non-negative threshold with up to six decimal places.';
      if (mode === 'create' && !validAmount(openingQuantity)) invalid.openingQuantity = 'Enter a non-negative opening count with up to six decimal places.';
    }
    setFields(invalid);
    if (Object.keys(invalid).length) { setError('Correct the highlighted inventory details.'); return; }
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const saved = mode === 'adjust' && editing
        ? await adjustInventory(editing, { ...adjustment, reason: reason.trim() }, requestKey.current)
        : await saveInventory(editing, { ...form, name: form.name.trim(), location: form.location.trim(), reason: reason.trim(), ...(mode === 'create' ? { openingQuantity } : {}) }, requestKey.current);
      close(); setMessage(mode === 'adjust' ? 'Stock change recorded.' : mode === 'create' ? 'Inventory item created with its opening count.' : 'Inventory details updated and recorded in history.');
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
      open(mode, response.data.data); setMessage('Latest stock loaded. Review the quantities before saving.');
      await Promise.all([refresh(), refreshGroups(), ...(foodForm ? [loadIngredients()] : [])]);
    } catch (failure) { failureMessage(failure); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const applyFilters = (next: Partial<InventoryFilters>) => setFilters((current) => ({ ...current, ...next, page: 1 }));
  const attributes = (key: string) => ({ 'aria-invalid': !!fields[key], 'aria-describedby': fields[key] ? 'inventory-error-' + key : undefined });
  const fieldError = (key: string) => fields[key] && <p id={'inventory-error-' + key} className="mt-1 text-sm text-red-700">{fields[key]}</p>;
  const stockExists = editing && editing.quantity !== '0';
  const browseGroup = (groupId: string) => { setFilters({ ...initial, groupId }); setSearch(''); setHistoryId(''); setMessage(''); setShowGroups(false); };
  const totals = currentGroup?.summary || data?.summary;
  return <div className="mx-auto max-w-7xl space-y-6 p-2 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-3xl font-bold text-slate-900">Inventory</h1><p className="mt-2 text-slate-600">Find physical stock by group, then track its quantity and storage location.</p></div>
      <div className="flex flex-wrap gap-3"><button disabled={busy || loading || groupLoading || ingredientLoading || newGroup} onClick={() => void Promise.all([refresh(), refreshGroups(), ...(foodForm ? [loadIngredients()] : [])])} className={button}>Refresh inventory</button>
        {canWrite && <><button disabled={busy || !!mode || newGroup} onClick={() => { setNewGroup(true); setMessage(''); }} className={button + ' flex items-center gap-2'}><Plus size={18} />Add group</button>
        <button disabled={busy || !!mode || newGroup || !groups.length} onClick={() => open('create')} className={primary + ' flex items-center gap-2'}><Plus size={18} />Add inventory item</button></>}</div>
    </header>
    {groupError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{groupError}</p>}
    {!showGroups && loadError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{loadError}</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    {canWrite && newGroup && <InventoryGroupForm onCancel={() => setNewGroup(false)} onSaved={(group) => {
      remember(group); setNewGroup(false); browseGroup(group.id); setMessage('Group created. Add the items you keep here.'); void refreshGroups();
    }} />}
    {showGroups ? <section aria-label="Inventory groups" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">Your inventory groups</h2>
        {!!groups.length && <button disabled={newGroup} className={button} onClick={() => browseGroup('')}>View all items</button>}</div>
      {groupLoading && <p role="status">Loading inventory groups…</p>}
      {!groupLoading && !groupError && !groups.length && <div className="rounded-2xl border border-dashed bg-white p-8 text-center">
        <FolderOpen className="mx-auto mb-3 text-emerald-700" size={32} /><p className="font-semibold">No inventory groups yet.</p>
        <p className="mt-2 text-slate-600">{canWrite ? 'Create a group first, then add its items.' : 'An administrator or editor can create inventory groups.'}</p>
        <p className="mt-2 text-sm text-slate-500">For example: Food Stock, Classroom Materials, Toys, Decorations, or Cleaning Supplies.</p>
      </div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{groups.map((group) => <button key={group.id} disabled={newGroup}
        aria-label={'Open group ' + group.name} onClick={() => browseGroup(group.id)} className="rounded-2xl border bg-white p-5 text-left shadow-sm hover:border-emerald-400 disabled:opacity-50">
        <div className="flex items-center justify-between gap-2">{group.kind === 'food' ? <Utensils className="text-emerald-700" size={24} /> : <FolderOpen className="text-emerald-700" size={24} />}<span className="text-sm text-slate-500">{group.kind === 'food' ? 'Food stock' : 'Supplies & equipment'}</span></div>
        <h3 className="mt-4 text-lg font-semibold">{group.name}</h3>{group.description && <p className="mt-1 text-sm text-slate-600">{group.description}</p>}
        <p className="mt-4 font-semibold">{group.summary.total} {group.summary.total === 1 ? 'item' : 'items'}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-sm"><span className="text-amber-800">{group.summary.lowStock} low stock</span><span className="text-red-800">{group.summary.outOfStock} out of stock</span></div>
      </button>)}</div>
      <p className="text-sm text-slate-600">Meals is where you manage recipes and weekly menus. A food stock group tracks ingredients physically in storage.</p>
    </section> : <div className="flex flex-wrap items-center justify-between gap-3">
      <div><button disabled={busy || !!mode || newGroup} onClick={() => { setShowGroups(true); setFilters(initial); setSearch(''); setHistoryId(''); setMessage(''); }} className="mb-2 flex items-center gap-2 text-emerald-800 disabled:opacity-50"><ArrowLeft size={16} />All groups</button>
        <h2 className="text-2xl font-bold">{currentGroup?.name || 'All inventory items'}</h2>
        {currentGroup?.kind === 'food' && <p className="mt-1 text-sm text-slate-600">Food physically in storage. Manage recipes and weekly menus in Meals.</p>}</div>
    </div>}
    {!showGroups && mode !== 'create' && !loading && totals && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {([[currentGroup ? 'Items in group' : 'All items', totals.total], ['Available', totals.available], ['Low stock', totals.lowStock], ['Out of stock', totals.outOfStock]] as const).map(([label, count]) =>
        <div key={label} className="rounded-xl border bg-white p-4"><p className="text-sm text-slate-600">{label}</p><p className="mt-1 text-2xl font-bold">{count}</p></div>)}
    </div>}
    {canWrite && mode && <form aria-label="Inventory details" onSubmit={(event) => void submit(event)} noValidate className="rounded-2xl border bg-white p-5 shadow-sm">
      <fieldset disabled={busy} className="space-y-4"><h2 className="text-xl font-bold">{mode === 'adjust' ? 'Adjust stock: ' + editing?.name : mode === 'edit' ? 'Edit inventory item' : 'Create inventory item'}</h2>
        {mode === 'adjust' && editing ? <>
          <p>Current stock: <strong>{editing.quantity} {editing.unit}</strong> · {editing.location}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>Change type<select className={control} value={adjustment.type} onChange={(event) => setAdjustment({ ...adjustment, type: event.target.value })}>
              <option value="addition">Stock addition</option><option value="usage">Usage</option><option value="correction">Count correction</option>
            </select></label>
            <label>{adjustment.type === 'correction' ? 'Count observed' : 'Quantity'} ({editing.unit})<input className={control} type="text" inputMode="decimal" {...attributes('quantity')} value={adjustment.quantity} onChange={(event) => setAdjustment({ ...adjustment, quantity: event.target.value })} />{fieldError('quantity')}</label>
          </div>
          <p className="text-sm text-slate-600">{adjustment.type === 'correction' ? 'Enter the total you counted, including zero. A new correction records the difference and keeps earlier history.' : 'Enter the amount added or used, in the displayed unit. Stock cannot fall below zero.'}</p>
        </> : <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>Inventory group<select className={control} {...attributes('groupId')} value={form.groupId} onChange={(event) => {
              const group = groups.find((item) => item.id === event.target.value);
              setForm({ ...form, groupId: event.target.value, ingredientId: group?.kind === 'food' ? form.ingredientId : (stockExists ? form.ingredientId : null) });
            }}><option value="">Choose a group</option>{groups.map((group) => <option key={group.id} value={group.id} disabled={!!stockExists && !!form.ingredientId && group.kind !== 'food'}>{group.name}</option>)}</select>{fieldError('groupId')}</label>
            {([['name', 'Item name', 100], ['location', 'Exact storage location', 200]] as const).map(([key, label, max]) => <label key={key}>{label}
              <input className={control} maxLength={max} {...attributes(key)} value={form[key]} list={key === 'name' ? undefined : 'inventory-' + key + '-options'} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />{fieldError(key)}
            </label>)}
            {foodForm && <label>Ingredient link (optional)<select className={control} {...attributes('ingredientId')} disabled={!!stockExists || ingredientLoading || !!ingredientError} value={form.ingredientId || ''} onChange={(event) => {
              const selected = ingredients.find((ingredient) => ingredient.id === event.target.value);
              setForm({ ...form, ingredientId: selected?.id || null, unit: selected?.unit || form.unit });
            }}><option value="">No ingredient link</option>
              {form.ingredientId && !ingredients.some((ingredient) => ingredient.id === form.ingredientId) && <option value={form.ingredientId} disabled>Current ingredient unavailable</option>}
              {ingredients.filter((ingredient) => !ingredient.archived || ingredient.id === form.ingredientId).map((ingredient) => <option key={ingredient.id} value={ingredient.id} disabled={ingredient.archived}>{ingredient.name} ({ingredient.unit}){ingredient.archived ? ' — archived' : ''}</option>)}
            </select>{fieldError('ingredientId')}</label>}
            <label>Unit<select className={control} {...attributes('unit')} disabled={!!stockExists || !!form.ingredientId} value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })}>{inventoryUnits.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>{fieldError('unit')}</label>
            <label>Reorder threshold<input className={control} type="text" inputMode="decimal" {...attributes('reorderThreshold')} value={form.reorderThreshold} onChange={(event) => setForm({ ...form, reorderThreshold: event.target.value })} />{fieldError('reorderThreshold')}</label>
            {mode === 'create' && <label>Opening count<input className={control} type="text" inputMode="decimal" {...attributes('openingQuantity')} value={openingQuantity} onChange={(event) => setOpeningQuantity(event.target.value)} />{fieldError('openingQuantity')}</label>}
          </div>
          <datalist id="inventory-location-options">{data?.options.locations.map((location) => <option key={location} value={location} />)}</datalist>
          <p className="text-sm text-slate-600">Use a precise location, such as Kitchen / Pantry / Shelf 2. Each record represents stock at one location. Low stock means the quantity is at or below its reorder threshold; zero means out of stock.</p>
          {stockExists && <p className="text-sm text-slate-600">{foodForm ? 'Unit and ingredient link can change when stock is zero.' : 'Unit can change when stock is zero.'} Use Adjust stock to record quantities.</p>}
          {foodForm && <p className="text-sm text-slate-600">An optional ingredient link connects this food stock to the ingredient catalog. Add recipes and plan menus in Meals.</p>}
          {mode === 'edit' && <p className="text-sm text-slate-600">Changing the storage location moves this record's entire balance. Its previous location stays in history.</p>}
          {foodForm && ingredientError && <p role="alert" className="text-red-800">{ingredientError} Food stock without a link can still be saved.</p>}
        </>}
        <label className="block">Reason<textarea className={control} maxLength={500} rows={2} {...attributes('reason')} value={reason} onChange={(event) => setReason(event.target.value)} />{fieldError('reason')}</label>
        <div className="flex flex-wrap gap-3"><button disabled={conflict} className={primary}>{mode === 'adjust' ? 'Record stock change' : 'Save inventory item'}</button><button type="button" onClick={close} className={button}>Cancel</button>
          {conflict && editing && <button type="button" onClick={() => void reloadItem()} className={button}>Reload inventory item</button>}</div>
        {conflict && !editing && <p>Cancel this form and refresh inventory to check whether the item was already saved.</p>}
      </fieldset>
    </form>}
    {!showGroups && mode !== 'create' && <form role="search" aria-label="Filter inventory" onSubmit={(event) => { event.preventDefault(); applyFilters({ q: search.trim() }); }} className="rounded-2xl border bg-white p-4">
      <fieldset disabled={busy || newGroup} className="flex flex-wrap items-end gap-3">
        <label className="min-w-40 flex-1">Search items<input type="search" maxLength={100} className={control} value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className={button}>Search</button>
        <label>Filter group<select className={control} value={filters.groupId} onChange={(event) => applyFilters({ groupId: event.target.value })}><option value="">All groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label>Filter location<select className={control} value={filters.location} onChange={(event) => applyFilters({ location: event.target.value })}><option value="">All locations</option>{[...new Set([...(data?.options.locations || []), ...(filters.location ? [filters.location] : [])])].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Stock status<select className={control} value={filters.status} onChange={(event) => applyFilters({ status: event.target.value })}><option value="all">All statuses</option>{Object.entries(stockLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className={button} onClick={() => { setSearch(''); setFilters({ ...initial, groupId: filters.groupId }); }}>Reset filters</button>
      </fieldset>
    </form>}
    {!showGroups && mode !== 'create' && loading && <p role="status">Loading inventory…</p>}
    {!showGroups && mode !== 'create' && !loading && data && <>
      <p className="text-sm text-slate-600">{data.total} matching {data.total === 1 ? 'item' : 'items'} · totals above include all locations and pages{currentGroup ? ' in this group' : ''}.</p>
      {!data.items.length ? <div className="rounded-2xl border border-dashed bg-white p-8 text-center"><Package className="mx-auto mb-3 text-emerald-700" size={30} /><p>No inventory matches these filters.</p>{canWrite && <p className="mt-2 text-slate-600">Reset filters or add an inventory item with its opening count.</p>}</div> :
        <div className="overflow-x-auto rounded-2xl border bg-white"><table className="w-full text-left"><caption className="sr-only">Inventory items</caption><thead className="bg-slate-50 text-sm text-slate-600"><tr>{['Item', 'Location', 'Stock', 'Reorder at', 'Status', 'Actions'].map((label) => <th scope="col" key={label} className="p-4">{label}</th>)}</tr></thead>
          <tbody>{data.items.map((item) => <tr key={item.id} className="border-t"><th scope="row" className="p-4"><span className="font-semibold">{item.name}</span><p className="mt-1 text-sm font-normal text-slate-500">{item.group.name}{item.ingredient ? ' · Ingredient: ' + item.ingredient.name + (item.ingredient.archived ? ' (archived)' : '') : ''}</p></th>
            <td className="p-4">{item.location}</td><td className="p-4 font-semibold">{item.quantity} {item.unit}</td><td className="p-4">{item.reorderThreshold} {item.unit}</td><td className="p-4"><span className={'rounded-full px-3 py-1 text-sm ' + (item.status === 'available' ? 'bg-emerald-50 text-emerald-800' : item.status === 'low' ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800')}>{stockLabel[item.status]}</span></td>
            <td className="p-4"><div className="flex flex-wrap gap-3 text-sm">{canWrite && <><button disabled={busy || !!mode || newGroup} className="font-semibold text-emerald-800 disabled:opacity-50" aria-label={'Adjust ' + item.name} onClick={() => open('adjust', item)}>Adjust stock</button><button disabled={busy || !!mode || newGroup} className="text-slate-600 disabled:opacity-50" aria-label={'Edit ' + item.name} onClick={() => open('edit', item)}>Edit</button></>}
              <button disabled={busy || newGroup} className="text-slate-600" aria-label={'History for ' + item.name} onClick={() => { setHistoryId(item.id); setHistoryRefresh((value) => value + 1); }}>History</button></div></td>
          </tr>)}</tbody></table></div>}
      {pages > 1 && <nav aria-label="Inventory pages" className="flex items-center justify-between gap-3"><button className={button} disabled={busy || newGroup || filters.page === 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Previous page</button><span>Page {filters.page} of {pages}</span><button className={button} disabled={busy || newGroup || filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Next page</button></nav>}
    </>}
    {historyId && <InventoryHistory key={historyId + ':' + historyRefresh} itemId={historyId} onClose={() => setHistoryId('')} />}
  </div>;
}
