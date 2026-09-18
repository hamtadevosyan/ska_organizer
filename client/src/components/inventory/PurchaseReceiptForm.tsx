import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { authError } from '../../auth/transport';
import { inventoryRequestId, inventoryUrl, receivePurchase } from '../../api/inventory';
import type { InventoryItem } from '../../api/inventory';
import { resultingQuantity, unitNames } from './quantity';

const control = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 disabled:bg-slate-100';
const button = 'min-h-11 rounded-lg border bg-white px-4 py-2 disabled:opacity-50';
export function PurchaseReceiptForm({ item, onCancel, onSaved, onBusy, onReload }: {
  item: InventoryItem; onCancel: () => void; onSaved: (item: InventoryItem) => void;
  onBusy: (busy: boolean) => void; onReload: () => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [supplier, setSupplier] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [config, setConfig] = useState<{ today: string; timeZone: string }>();
  const [configError, setConfigError] = useState('');
  const [retryConfig, setRetryConfig] = useState(0);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const busy = useRef(false);
  const requestId = useRef(inventoryRequestId());
  useEffect(() => {
    const controller = new AbortController(); setConfigError('');
    axios.get<{ today: string; timeZone: string }>(inventoryUrl + '/purchase-config', { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) { setConfig(data); setReceivedOn((old) => old || data.today); } })
      .catch((failure) => { if (!controller.signal.aborted) setConfigError(authError(failure, 'Could not read the facility date. Retry before recording a purchase.')); });
    return () => controller.abort();
  }, [retryConfig]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !config || conflict) return;
    const invalid: Record<string, string> = {};
    if (!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(quantity) || Number(quantity) <= 0) invalid.quantity = 'Enter a positive quantity with up to six decimal places.';
    if (!receivedOn || receivedOn > config.today || receivedOn < '1900-01-01') invalid.receivedOn = 'Enter the date this purchase was received, no later than today at the facility.';
    if (cost !== '' && !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(cost)) invalid.totalCost = 'Enter a non-negative total cost with at most two decimal places, or leave it empty.';
    if (supplier.trim().length > 200) invalid.supplier = 'Keep the supplier within 200 characters.';
    if (notes.trim().length > 500) invalid.reason = 'Keep notes within 500 characters.';
    setFields(invalid);
    if (Object.keys(invalid).length) { setError('Correct the highlighted purchase details.'); return; }
    busy.current = true; setSaving(true); onBusy(true); setError('');
    try {
      const result = await receivePurchase(item, { quantity, receivedOn, supplier: supplier.trim(),
        totalCost: cost === '' ? null : cost, reason: notes.trim() || 'Purchase received' }, requestId.current);
      onSaved(result.item);
    } catch (failure) {
      setError(authError(failure, 'Could not confirm receipt. Your entries are still here; retry the same purchase.'));
      if (axios.isAxiosError(failure)) {
        setFields(failure.response?.data?.error?.fields || {});
        setConflict(['INVENTORY_CONFLICT', 'INVENTORY_REQUEST_CONFLICT'].includes(failure.response?.data?.error?.code));
      }
    } finally { busy.current = false; setSaving(false); onBusy(false); }
  }
  const attributes = (key: string) => ({ 'aria-invalid': !!fields[key], 'aria-describedby': fields[key] ? 'purchase-error-' + key : undefined });
  const fieldError = (key: string) => fields[key] && <p id={'purchase-error-' + key} className="mt-1 text-sm text-red-700">{fields[key]}</p>;
  return <form aria-label="Bought more" onSubmit={(event) => void submit(event)} noValidate className="rounded-2xl border bg-white p-5 shadow-sm">
    <h2 className="text-xl font-bold">Bought more: {item.name}</h2>
    <p className="mt-2 text-slate-600">{item.location} · You have {item.quantity} {unitNames[item.unit]}.</p>
    {configError && <div role="alert" className="my-3 text-red-800">{configError} <button type="button" className={button} onClick={() => setRetryConfig((n) => n + 1)}>Retry facility date</button></div>}
    {error && <p role="alert" className="my-3 text-red-800">{error}</p>}
    <fieldset disabled={saving || !config} className="mt-4 space-y-4">
      <div><label>How much did you buy? ({unitNames[item.unit]})<input autoFocus className={control} inputMode="decimal" {...attributes('quantity')} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>{fieldError('quantity')}</div>
      {resultingQuantity(item.quantity, quantity, 'addition') !== null && <p className="rounded-lg bg-emerald-50 p-3">After saving: <strong>{resultingQuantity(item.quantity, quantity, 'addition')} {unitNames[item.unit]}.</strong></p>}
      <details open={fields.receivedOn || fields.supplier || fields.totalCost || fields.reason ? true : undefined}><summary className="cursor-pointer py-2 text-slate-600">Date, cost or notes (optional)</summary><div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div><label>Received date<input className={control} type="date" min="1900-01-01" max={config?.today} {...attributes('receivedOn')} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} /></label>{fieldError('receivedOn')}</div>
        <div><label>Supplier (optional)<input className={control} maxLength={200} {...attributes('supplier')} value={supplier} onChange={(e) => setSupplier(e.target.value)} /></label>{fieldError('supplier')}</div>
        <div><label>Total cost (USD, optional)<input className={control} inputMode="decimal" {...attributes('totalCost')} value={cost} onChange={(e) => setCost(e.target.value)} /></label>{fieldError('totalCost')}</div>
      </div>
      <div><label className="block">Notes (optional)<textarea className={control} rows={2} maxLength={500} {...attributes('reason')} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>{fieldError('reason')}</div></details>
      <button disabled={conflict} className="min-h-11 rounded-lg bg-emerald-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save amount'}</button>
      {conflict && <div className="space-y-2 text-sm"><p>Check Purchase history before recording again: the purchase may already have been received. Reloading starts a new form.</p><button type="button" className={button} onClick={onReload}>Reload inventory item</button></div>}
    </fieldset>
    <button type="button" disabled={saving} className={button + ' mt-3'} onClick={onCancel}>Cancel</button>
  </form>;
}
