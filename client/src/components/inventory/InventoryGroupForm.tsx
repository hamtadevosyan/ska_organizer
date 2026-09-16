import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { inventoryRequestId, inventoryUrl } from '../../api/inventory';
import type { InventoryGroup } from '../../api/inventory';
import { authError } from '../../auth/transport';

export function InventoryGroupForm({ onSaved, onCancel }: { onSaved: (group: InventoryGroup) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'food' | 'supplies'>('supplies');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [requestId] = useState(inventoryRequestId);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    if (!name.trim() || name.trim().length > 80) { setError('Enter a group name between 1 and 80 characters.'); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await axios.post<{ data: Omit<InventoryGroup, 'summary'> }>(inventoryUrl + '/groups', { name: name.trim(), kind, description: description.trim(), requestId });
      onSaved({ ...response.data.data, summary: { total: 0, available: 0, lowStock: 0, outOfStock: 0 } });
    } catch (failure) { setError(authError(failure, 'Could not save the group. Your entries are still here; retry the same save.')); }
    finally { pending.current = false; setBusy(false); }
  }
  const control = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2';
  return <form aria-label="New inventory group" noValidate onSubmit={(event) => void save(event)} className="rounded-2xl border bg-white p-5 shadow-sm">
    <fieldset disabled={busy} className="space-y-4"><h2 className="text-xl font-bold">Create inventory group</h2>
      {error && <p role="alert" className="text-red-800">{error}</p>}
      <label className="block">Group name<input autoFocus className={control} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="block">Group type<select className={control} value={kind} onChange={(event) => setKind(event.target.value as 'food' | 'supplies')}>
        <option value="supplies">Supplies and equipment</option><option value="food">Food stock</option>
      </select></label>
      <p className="text-sm text-slate-600">{kind === 'food' ? 'Track food physically in storage. Recipes and weekly menus are managed in Meals.' : 'For materials, toys, decorations, cleaning supplies and equipment.'}</p>
      <label className="block">Description (optional)<textarea className={control} maxLength={240} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="flex gap-3"><button className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Save group</button><button type="button" className="rounded-lg border px-4 py-2" onClick={onCancel}>Cancel group</button></div>
    </fieldset>
  </form>;
}
