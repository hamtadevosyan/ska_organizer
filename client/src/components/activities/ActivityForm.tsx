import { useEffect, useRef, useState } from 'react';
import type { FormEvent, Ref } from 'react';
import { authError } from '../../auth/transport';
import { dayLabel, materialOptions, materialUnitLabel, saveActivity, suitable } from '../../api/activities';
import type { Activity, ActivityDetails, Material } from '../../api/activities';
import type { Room } from '../../api/rooms';
import type { InventoryItem } from '../../api/inventory';

type Props = { activity: Activity | null; room?: Room; scheduleDate?: string; nameInputRef?: Ref<HTMLInputElement>;
  onBusyChange: (busy: boolean) => void; onSaved: (activity: Activity) => void; onClose: () => void };
const input = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2.5';
export function ActivityForm({ activity, room, scheduleDate, nameInputRef, onBusyChange, onSaved, onClose }: Props) {
  // Older rooms can have equal age bounds. Do not copy an invalid range into a new activity.
  const roomHasAges = room?.ageMinMonths != null && room?.ageMaxMonths != null &&
    Number.isInteger(room.ageMinMonths) && Number.isInteger(room.ageMaxMonths) &&
    room.ageMinMonths >= 0 && room.ageMaxMonths > room.ageMinMonths && room.ageMaxMonths <= 216;
  const [name, setName] = useState(activity?.name || '');
  const [duration, setDuration] = useState(activity ? String(activity.durationMinutes ?? '') : '20');
  const [description, setDescription] = useState(activity?.description || '');
  const [minAge, setMinAge] = useState(String(activity ? activity.ageMinMonths ?? '' : roomHasAges ? room.ageMinMonths : ''));
  const [maxAge, setMaxAge] = useState(String(activity ? activity.ageMaxMonths ?? '' : roomHasAges ? room.ageMaxMonths : ''));
  const [materials, setMaterials] = useState<Material[]>(activity?.materials || []);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [inventoryError, setInventoryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [itemId, setItemId] = useState('');
  const [query, setQuery] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reusable, setReusable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setInventoryError('');
    void materialOptions(controller.signal).then((result) => { if (!controller.signal.aborted) setItems(result); })
      .catch((failure) => { if (!controller.signal.aborted) setInventoryError(authError(failure, 'Could not load Inventory.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);
  function addMaterial() {
    const item = items.find((value) => value.id === itemId);
    if (!item || !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(quantity) || Number(quantity) <= 0) { setError('Choose a material and enter a quantity greater than zero.'); return; }
    if (materials.some((row) => row.itemId === itemId)) { setError('That material is already listed. Remove it before changing its amount.'); return; }
    setMaterials([...materials, { itemId, name: item.name, location: item.location, unit: item.unit, quantity, reusable }]);
    setItemId(''); setQuantity('1'); setReusable(false); setError(''); setChanged(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setError('');
    if (!name.trim() || name.trim().length > 100 || !/^\d+$/.test(duration) || Number(duration) < 1 || Number(duration) > 1440) { setError('Enter an activity name of up to 100 characters and a duration from 1 to 1440 minutes.'); return; }
    if (description.length > 4000) { setDetailsOpen(true); setError('Keep the description within 4,000 characters.'); return; }
    if (minAge !== '' || maxAge !== '') {
      if (![minAge, maxAge].every((value) => /^\d+$/.test(value) && Number(value) <= 216) || Number(maxAge) <= Number(minAge)) {
        setDetailsOpen(true);
        setError('Enter both ages in months, with maximum greater than minimum, or leave both empty for all ages.'); return;
      }
    }
    if (itemId) { setDetailsOpen(true); setError('Click Add material for the selected item, or clear the selection before saving.'); return; }
    const details: ActivityDetails = { name: name.trim(), durationMinutes: Number(duration), description: description.trim(),
      ageMinMonths: minAge === '' ? null : Number(minAge), ageMaxMonths: maxAge === '' ? null : Number(maxAge),
      materials, roomId: activity?.roomId || null };
    if (scheduleDate && room && !suitable(details, room)) {
      setDetailsOpen(true);
      setError(`This activity must include the room’s age range (${room.ageMinMonths}–${room.ageMaxMonths} months), or leave both ages empty for all ages.`); return;
    }
    setBusy(true); onBusyChange(true);
    try {
      onSaved(await saveActivity(activity, details));
    } catch (failure) { setError(authError(failure, 'Could not save this activity. Your details are still here.')); }
    finally { setBusy(false); onBusyChange(false); }
  }
  // Validate in submit so an invalid field inside closed More details cannot silently block the button.
  return <form noValidate onSubmit={(event) => void submit(event)} onChange={() => { setChanged(true); setConfirmCancel(false); }} className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm print:hidden" aria-label={activity ? 'Edit activity' : 'New activity'}>
    <h2 className="text-xl font-bold">{activity ? 'Edit activity' : scheduleDate ? 'Add activity to ' + dayLabel(scheduleDate) : 'Add activity'}</h2>
    {scheduleDate && <p className="mt-1 text-sm text-slate-600">This will be added to {dayLabel(scheduleDate)}. Save the week when your schedule is ready.</p>}
    <fieldset disabled={busy} className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <label>Activity name<input ref={nameInputRef} autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={input} /></label>
        <label>Minutes<input type="number" min="1" max="1440" step="1" value={duration} onChange={(e) => setDuration(e.target.value)} className={input} /></label>
      </div>
      <details open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}><summary className="cursor-pointer font-semibold text-emerald-800">More details</summary>
        <div className="mt-4 space-y-4">
          <label className="block">Description<textarea rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} className={input} /></label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>Minimum age (months)<input type="number" min="0" max="215" step="1" value={minAge} onChange={(e) => setMinAge(e.target.value)} className={input} /></label>
            <label>Maximum age (months)<input type="number" min="1" max="216" step="1" value={maxAge} onChange={(e) => setMaxAge(e.target.value)} className={input} /></label>
          </div>
          <p className="text-sm text-slate-600">Leave both ages empty for all ages.{!activity && roomHasAges ? ' These ages start with your selected room’s age range.' : ''}</p>
          <section aria-label="Activity materials" className="space-y-3 rounded-xl bg-slate-50 p-4">
            <h3 className="font-bold">Materials (optional)</h3><p className="text-sm text-slate-600">Enter enough for the whole activity, for all children together.</p>
            {materials.length > 0 && <ul className="space-y-2">{materials.map((material) => <li key={material.itemId} className="flex items-center justify-between gap-4">
              <span>{material.name || 'Inventory item'} — {material.quantity} {materialUnitLabel(material.unit)}{material.reusable ? ' · reusable' : ''}</span>
              <button type="button" aria-label={'Remove ' + (material.name || 'material')} className="text-red-700" onClick={() => { setMaterials(materials.filter((row) => row.itemId !== material.itemId)); setChanged(true); }}>Remove</button>
            </li>)}</ul>}
            {loading ? <p>Loading materials…</p> : inventoryError ? <p role="alert">{inventoryError} <button type="button" className="underline" onClick={() => setRetry((v) => v + 1)}>Retry materials</button></p>
              : !items.length ? <p>No items in Inventory yet. You can save this activity and add materials later.</p> : <>
                <label className="block">Find a material<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} className={input} /></label>
                <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                  <label>Material<select value={itemId} onChange={(e) => setItemId(e.target.value)} className={input}>
                    <option value="">Choose from Inventory</option>
                    {items.filter((item) => item.id === itemId || item.name.toLowerCase().includes(query.toLowerCase())).map((item) => <option value={item.id} key={item.id}>{item.name} — {item.location} ({materialUnitLabel(item.unit)})</option>)}
                  </select></label>
                  <label>Amount<input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={input} /></label>
                </div>
                <label className="flex gap-2"><input type="checkbox" checked={reusable} onChange={(e) => setReusable(e.target.checked)} />Can be reused after the activity</label>
                <button type="button" onClick={addMaterial} disabled={!itemId || materials.length >= 30} className="rounded-lg border bg-white px-4 py-2 disabled:opacity-50">Add material</button>
              </>}
          </section>
        </div>
      </details>
      {error && <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
      <div className="flex gap-3"><button type="submit" className="rounded-lg bg-emerald-700 px-5 py-2.5 font-semibold text-white">{busy ? 'Saving…' : scheduleDate ? 'Add to day' : 'Save activity'}</button>
        <button type="button" onClick={() => { if (changed) setConfirmCancel(true); else onClose(); }} className="rounded-lg border px-4 py-2">Cancel</button></div>
      {confirmCancel && <div role="group" aria-label="Discard activity changes" className="rounded-lg bg-amber-50 p-3">
        <p>Discard the activity details you entered?</p>
        <div className="mt-2 flex gap-3"><button type="button" onClick={onClose} className="rounded-lg bg-red-700 px-4 py-2 font-semibold text-white">Discard activity</button>
          <button type="button" onClick={() => setConfirmCancel(false)} className="rounded-lg border bg-white px-4 py-2">Keep editing</button></div>
      </div>}
    </fieldset>
  </form>;
}
