import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, PackageCheck, Plus, Search, ShoppingBasket } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { compatibleStockUnits, inventoryRequestId, inventoryUnits, type InventoryItem } from '../api/inventory';
import { getBatchByRequest, getBatchReceipt, getPurchasingFulfillment, getReceivingHistory, getReceivingItems, previewBatchReceipt, recordBatchReceipt } from '../api/batchPurchases';
import type { BatchLine, BatchReceipt, BatchRequest, BatchReview, PurchasingFulfillment, ReceivingHistory } from '../api/batchPurchases';
import { mondayOf } from '../components/meals/weeklyPlan';
import { validQuantity } from '../components/inventory/quantity';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import './receiving.css';

// Preserve an uncertain receipt through an authentication screen in this tab.
// Keep this in memory only, scoped to its account; no operational data is cached on disk.
const uncertainReceipts = new Map<string, { request: BatchRequest; review: BatchReview | null }>();
type DraftLine = { item: InventoryItem; quantity: string; unit: string; cost: string; purchasingLineId?: string };
const labelOf = (item: { name: string; location: string }) => item.name + ' at ' + item.location;
const money = (value: string | null) => value === null ? 'Not recorded' : '$' + value;
const definitive = (failure: unknown) => axios.isAxiosError(failure) && !!failure.response
  && failure.response.status >= 400 && failure.response.status < 500 && failure.response.status !== 408;

function ReceiptLines({ lines }: { lines: BatchLine[] }) {
  return <div className="receiving-lines">{lines.map(line => <article className="receiving-card" key={line.itemId} aria-label={labelOf(line)}>
    <h3>{line.name}</h3><p>{line.location}</p>
    <dl className="receiving-math"><div><dt>Actually received</dt><dd>{line.quantity} {line.unit}</dd></div>
      <div><dt>Stock before</dt><dd>{line.beforeQuantity} {line.stockUnit}</dd></div><div><dt>Stock after</dt><dd>{line.afterQuantity} {line.stockUnit}</dd></div></dl>
    <p>Stock added: <strong>{line.stockDelta} {line.stockUnit}</strong> · Total cost: {money(line.totalCost)}</p>
    {line.purchasingLineId && <p>Linked buying quantity: {line.plannedQuantity} {line.stockUnit} · Previously received: {line.previouslyReceived} {line.stockUnit} · Remaining before this receipt: {line.remainingQuantity} {line.stockUnit}</p>}
    {line.notes.map((note, index) => <p className="receiving-note" key={index}>{note}</p>)}
  </article>)}</div>;
}

export default function Receiving() {
  const { account } = useAuth();
  const canWrite = account?.role === 'admin' || account?.role === 'editor';
  const [params, setParams] = useSearchParams();
  const week = mondayOf(params.get('week') || '') || '';
  const receiptId = params.get('receipt') || '';
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(canWrite);
  const [itemsError, setItemsError] = useState('');
  const [itemsRetry, setItemsRetry] = useState(0);
  const [history, setHistory] = useState<ReceivingHistory | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [fulfillment, setFulfillment] = useState<PurchasingFulfillment | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [sourceLoading, setSourceLoading] = useState(!!week);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [detail, setDetail] = useState<BatchReceipt | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [receivedOn, setReceivedOn] = useState(() => account ? uncertainReceipts.get(account.id)?.request.receivedOn || '' : '');
  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState('');
  const [review, setReview] = useState<BatchReview | null>(() => account ? uncertainReceipts.get(account.id)?.review || null : null);
  const [pending, setPending] = useState<BatchRequest | null>(() => account ? uncertainReceipts.get(account.id)?.request || null : null);
  const [success, setSuccess] = useState<BatchReceipt | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const reportUnsaved = useUnsavedChanges();
  const hasUnsaved = !!pending || (canWrite && dirty);
  const frozen = busy || !!pending;

  useEffect(() => {
    if (!canWrite) return;
    const controller = new AbortController(); setItemsLoading(true); setItemsError('');
    void getReceivingItems(controller.signal).then(value => { if (!controller.signal.aborted) setItems(value); })
      .catch(failure => { if (!controller.signal.aborted && !axios.isCancel(failure)) setItemsError(authError(failure, 'Could not load inventory destinations.')); })
      .finally(() => { if (!controller.signal.aborted) setItemsLoading(false); });
    return () => controller.abort();
  }, [canWrite, itemsRetry]);
  useEffect(() => {
    const controller = new AbortController(); setHistoryLoading(true); setHistoryError('');
    void getReceivingHistory(historyPage, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setHistory(value); setReceivedOn(previous => previous || value.today);
    }).catch(failure => { if (!controller.signal.aborted && !axios.isCancel(failure)) setHistoryError(authError(failure, 'Could not open receiving history or the facility date.')); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [historyPage, historyRetry]);
  useEffect(() => {
    const controller = new AbortController(); setFulfillment(null); setSourceError(''); setSourceLoading(!!week);
    if (week) void getPurchasingFulfillment(week, controller.signal).then(value => { if (!controller.signal.aborted) setFulfillment(value); })
      .catch(failure => { if (!controller.signal.aborted && !axios.isCancel(failure)) setSourceError(authError(failure, 'Could not open this week’s saved purchasing list.')); })
      .finally(() => { if (!controller.signal.aborted) setSourceLoading(false); });
    return () => controller.abort();
  }, [week, sourceRetry]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setDetailError(''); setDetailLoading(!!receiptId);
    if (receiptId) void getBatchReceipt(receiptId, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(failure => { if (!controller.signal.aborted && !axios.isCancel(failure)) setDetailError(authError(failure, 'Could not open this recorded receipt.')); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [receiptId, detailRetry]);
  useEffect(() => { reportUnsaved(hasUnsaved, busy || !!pending); }, [reportUnsaved, hasUnsaved, busy, pending]);
  useEffect(() => () => { reportUnsaved(false, false); operation.current?.abort(); }, [reportUnsaved]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (hasUnsaved || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [hasUnsaved, busy]);

  function changed() { setDirty(true); setReview(null); setSuccess(null); setError(''); setMessage(''); setInvalid({}); }
  function changeLine(id: string, value: Partial<DraftLine>) {
    if (!canWrite || busyRef.current || pending || review) return;
    setLines(previous => previous.map(line => line.item.id === id ? { ...line, ...value } : line)); changed();
  }
  function addItem() {
    if (!canWrite || busyRef.current || pending || review || conflict || lines.length >= 50) return;
    const item = items.find(value => value.id === chosen);
    if (!item || lines.some(line => line.item.id === item.id)) return;
    setLines(previous => [...previous, { item, quantity: '', unit: item.unit, cost: '' }]); setChosen(''); changed();
  }
  function addPlanned() {
    if (!canWrite || busyRef.current || pending || review || conflict || !fulfillment) return;
    const additions: DraftLine[] = [];
    const failures: string[] = [];
    for (const planned of fulfillment.lines.filter(line => line.selected)) {
      if (lines.some(line => line.item.id === planned.itemId)) continue;
      const item = items.find(value => value.id === planned.itemId);
      if (!item || item.unit !== planned.unit) { failures.push(planned.name); continue; }
      if (lines.length + additions.length >= 50) { failures.push(planned.name); continue; }
      additions.push({ item, quantity: '', unit: item.unit, cost: '', purchasingLineId: planned.id });
    }
    setLines(previous => [...previous, ...additions]); if (additions.length) changed();
    if (failures.length) setError('Some planned items could not be added: ' + failures.join(', ') + '. Check their inventory record and units, or keep this receipt within 50 items.');
    else setMessage('Selected items added with empty received quantities. Enter only what actually arrived.');
  }
  function validate() {
    const fields: Record<string, string> = {};
    if (!lines.length) fields.lines = 'Add at least one inventory item.';
    if (!receivedOn || !history || receivedOn > history.today || receivedOn < '1900-01-01') fields.date = 'Choose a received date no later than today at the facility.';
    for (const line of lines) {
      if (!validQuantity(line.quantity) || Number(line.quantity) <= 0) fields[line.item.id + ':quantity'] = 'Enter the positive amount that actually arrived, with up to six decimal places.';
      if (line.cost && !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(line.cost)) fields[line.item.id + ':cost'] = 'Enter a non-negative cost with up to two decimal places, or leave it blank.';
    }
    setInvalid(fields); return !Object.keys(fields).length;
  }
  async function preview() {
    if (!canWrite || busyRef.current || pending || conflict || !history || !validate()) return;
    const linked = lines.some(line => !!line.purchasingLineId);
    if (linked && !fulfillment) { setError('Reopen the saved purchasing list before reviewing linked items.'); return; }
    const payload: BatchRequest = { requestId: inventoryRequestId(), receivedOn, supplier: supplier.trim() || null, reason: notes.trim() || 'Purchase received',
      lines: lines.map(line => ({ itemId: line.item.id, version: line.item.version, quantity: line.quantity, unit: line.unit, totalCost: line.cost || null,
        ...(line.purchasingLineId ? { purchasingLineId: line.purchasingLineId } : {}) })),
      ...(linked && fulfillment ? { purchasingRef: { weekStart: fulfillment.weekStart, version: fulfillment.version } } : {}) };
    const controller = new AbortController(); operation.current = controller; busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const value = await previewBatchReceipt(payload, controller.signal);
      if (!controller.signal.aborted) setReview(value);
    } catch (failure) {
      if (!controller.signal.aborted) { setError(authError(failure, 'Could not review this receipt. Your entries are still here.')); if (axios.isAxiosError(failure) && failure.response?.status === 409) setConflict(true); }
    } finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  function confirmed(batch: BatchReceipt) {
    if (account) uncertainReceipts.delete(account.id);
    setSuccess(batch); setLines([]); setSupplier(''); setNotes(''); setReview(null); setPending(null); setDirty(false); setConflict(false); setError(''); setMessage(''); setInvalid({});
    setItemsRetry(value => value + 1); setHistoryRetry(value => value + 1); setSourceRetry(value => value + 1);
  }
  async function commit() {
    if (!canWrite || busyRef.current || (!pending && !review)) return;
    const wasPending = !!pending;
    const payload = pending || review!.request;
    if (account) uncertainReceipts.set(account.id, { request: payload, review });
    // Keep the exact server-reviewed body and identifier after a lost response.
    // Editing cannot create a second receipt while the first result is unknown.
    setPending(payload); busyRef.current = true; setBusy(true); setError(''); setMessage('');
    const controller = new AbortController(); operation.current = controller;
    try {
      const value = await recordBatchReceipt(payload, controller.signal);
      if (!controller.signal.aborted) confirmed(value.batch);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(authError(failure, 'Could not confirm receipt. Keep this page open and retry the same receipt.'));
        if (!wasPending && definitive(failure)) {
          if (account) uncertainReceipts.delete(account.id);
          setPending(null); setReview(null);
          const status = axios.isAxiosError(failure) ? failure.response?.status : undefined;
          setConflict(status === 409); setMessage('The receipt was rejected. Your quantities are kept; review again before recording.');
        }
      }
    } finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  async function checkStatus() {
    if (!pending || busyRef.current) return;
    const controller = new AbortController(); operation.current = controller; busyRef.current = true; setBusy(true); setError('');
    try {
      const batch = await getBatchByRequest(pending.requestId, controller.signal);
      if (!controller.signal.aborted) {
        if (batch) confirmed(batch);
        else setMessage('No confirmed receipt was found yet. Retry the same receipt to safely confirm it; its quantities remain locked.');
      }
    } catch (failure) { if (!controller.signal.aborted) setError(authError(failure, 'Could not check receipt status. Retry the same receipt when the connection returns.')); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  async function refreshVersions() {
    if (!canWrite || busyRef.current || pending) return;
    const controller = new AbortController(); operation.current = controller; busyRef.current = true; setBusy(true); setError('');
    try {
      const [latest, currentList] = await Promise.all([getReceivingItems(controller.signal), week ? getPurchasingFulfillment(week, controller.signal) : Promise.resolve(null)]);
      if (controller.signal.aborted) return;
      const missing = lines.filter(line => !latest.some(item => item.id === line.item.id));
      setItems(latest); setFulfillment(currentList); setReview(null);
      setLines(previous => previous.map(line => ({ ...line, item: latest.find(item => item.id === line.item.id) || line.item })));
      setConflict(false); setMessage('Stock versions refreshed. Your received quantities and costs were kept. Review again before recording.');
      if (missing.length) setError('Some destinations are unavailable: ' + missing.map(line => line.item.name).join(', ') + '. Remove those items before reviewing again.');
    } catch (failure) { if (!controller.signal.aborted) setError(authError(failure, 'Could not refresh stock versions. Your receipt is still here.')); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  function cancel() {
    if (busyRef.current || pending || (dirty && !window.confirm('Discard this unrecorded receipt? Inventory has not been changed.'))) return;
    setLines([]); setReview(null); setSupplier(''); setNotes(''); setDirty(false); setError(''); setMessage(''); setConflict(false); setInvalid({});
  }
  const available = items.filter(item => !lines.some(line => line.item.id === item.id) && (item.name + ' ' + item.location).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const linked = lines.some(line => !!line.purchasingLineId);
  const attributes = (key: string) => ({ 'aria-invalid': !!invalid[key], 'aria-describedby': invalid[key] ? 'receiving-error-' + key : undefined });
  const fieldError = (key: string) => invalid[key] && <p className="receiving-field-error" id={'receiving-error-' + key}>{invalid[key]}</p>;
  return <div className="ska-page ska-core-page receiving-page">
    <header className="ska-page-head"><div><h1><span className="ska-heading-icon is-blue"><PackageCheck aria-hidden="true" size={24} /></span>Receive purchases</h1><p>Record the items that actually arrived, together.</p></div>
      <Link className="ska-button" to="/inventory"><ArrowLeft size={18} aria-hidden="true" />Inventory</Link></header>
    <section className="receiving-intro"><PackageCheck size={30} aria-hidden="true" /><div><h2>Arrived? Check it. Record it.</h2><p>Choose an existing item and storage location, enter the actual received amounts, then review the stock changes. Planning and check-offs do not add stock.</p></div></section>
    {!canWrite && <p className="receiving-note">Read-only access: you can inspect recorded receipts. An administrator or editor can receive purchases.</p>}
    {canWrite && <section className="receiving-panel" aria-label="Receipt draft">
      <div className="receiving-section-head"><h2>New receipt</h2><span className="receiving-badge">{lines.length}/50 items</span></div>
      <p className="receiving-small">Amounts start empty. Leave costs blank when unknown. Choose each stock location explicitly; boxes and packs are never guessed.</p>
      <div hidden={!!review || !!pending}>
      <fieldset disabled={frozen || !!review} className="receiving-fields">
        <div className="receiving-common"><div><label>Received date<input type="date" min="1900-01-01" max={history?.today} value={receivedOn} {...attributes('date')} onChange={event => { setReceivedOn(event.target.value); changed(); }} /></label>{fieldError('date')}<p className="receiving-small">Facility time zone: {history?.timeZone || 'Loading…'}</p></div>
          <label>Supplier (optional)<input value={supplier} maxLength={200} onChange={event => { setSupplier(event.target.value); changed(); }} /></label></div>
        <label>Receipt notes (optional)<textarea rows={2} maxLength={500} value={notes} onChange={event => { setNotes(event.target.value); changed(); }} /></label>
      </fieldset>
      <section aria-label="Saved purchasing source" className="receiving-source">
        <label>Purchasing week (optional)<input type="date" value={week} disabled={frozen || !!review} onChange={event => {
          if (busyRef.current || pending || (dirty && !window.confirm('Discard this unrecorded receipt and change the purchasing week?'))) return;
          setLines([]); setReview(null); setSupplier(''); setNotes(''); setDirty(false); setConflict(false); setError(''); setMessage('');
          const next = mondayOf(event.target.value); setParams(previous => { const value = new URLSearchParams(previous); if (next) value.set('week', next); else value.delete('week'); return value; }, { replace: true });
        }} /></label>
        {sourceLoading && <p role="status">Opening saved purchasing list…</p>}
        {sourceError && <p role="alert">{sourceError} <button className="ska-button" disabled={frozen} onClick={() => setSourceRetry(value => value + 1)}>Retry purchasing source</button></p>}
        {week && !sourceLoading && !sourceError && !fulfillment && <p>No purchasing list is saved for this week. You can still receive standalone inventory items.</p>}
        {fulfillment && <><p>Saved purchasing list · Week of {fulfillment.weekStart} · Version {fulfillment.version}</p><p className="receiving-small">{fulfillment.note}</p>
          <ul className="receiving-planned">{fulfillment.lines.filter(line => line.selected).map(line => <li key={line.id}><span>{line.name} · {line.location || 'No linked location'}</span><strong>Received {line.receivedQuantity} {line.unit} · Remaining {line.remainingQuantity} {line.unit}</strong></li>)}</ul>
          <button type="button" className="ska-button" disabled={frozen || !!review || conflict || itemsLoading || !!itemsError || !fulfillment.lines.some(line => line.selected && !lines.some(value => value.item.id === line.itemId))} onClick={addPlanned}><ShoppingBasket size={18} aria-hidden="true" />Add selected purchasing items</button>
          {linked && <p className="receiving-small">This receipt will reference saved purchasing version {fulfillment.version}. The purchasing list stays unchanged.</p>}
        </>}
      </section>
      </div>
      {!review && <fieldset className="receiving-fields receiving-add" disabled={frozen || conflict || itemsLoading || !!itemsError}>
        <legend>Add an existing inventory item</legend>
        {itemsLoading && <p role="status">Loading inventory destinations…</p>}
        {itemsError && <p role="alert">{itemsError}</p>}
        <label><span><Search size={16} aria-hidden="true" /> Search inventory items</span><input type="search" value={search} onChange={event => { setSearch(event.target.value); setChosen(''); }} /></label>
        <label>Inventory item and location<select aria-label="Inventory item and location" value={chosen} onChange={event => setChosen(event.target.value)}><option value="">Choose an item and its location</option>{available.map(item => <option key={item.id} value={item.id}>{item.name} · {item.location} · {item.quantity} {item.unit}</option>)}</select></label>
        {!itemsLoading && !itemsError && !available.length && <p className="receiving-small">No matching unused destinations. Add a new stock record in Inventory if needed.</p>}
        <button type="button" className="ska-button" disabled={!chosen || lines.length >= 50} onClick={addItem}><Plus size={18} aria-hidden="true" />Add inventory item</button>
      </fieldset>}
      {itemsError && <button type="button" className="ska-button" disabled={frozen} onClick={() => setItemsRetry(value => value + 1)}>Retry inventory destinations</button>}
      {!review && <div className="receiving-lines">{lines.map(line => <article className="receiving-card" aria-label={labelOf(line.item)} key={line.item.id}>
        <div className="receiving-section-head"><div><h3>{line.item.name}</h3><p>{line.item.location} · Recorded stock {line.item.quantity} {line.item.unit}</p></div><button className="ska-button" type="button" disabled={frozen} onClick={() => { setLines(previous => previous.filter(value => value.item.id !== line.item.id)); changed(); }}>Remove {line.item.name}</button></div>
        {line.purchasingLineId ? <p className="receiving-small">Linked to the saved purchasing list. Only this actual delivery will count toward received amounts.</p> : <p className="receiving-small">Standalone receipt: this line will not count toward a purchasing list.</p>}
        {fulfillment?.lines.some(planned => planned.itemId === line.item.id && planned.selected && planned.unit === line.item.unit) && <label className="receiving-link-choice"><input type="checkbox" checked={!!line.purchasingLineId} disabled={frozen} onChange={event => changeLine(line.item.id, { purchasingLineId: event.target.checked ? fulfillment.lines.find(planned => planned.itemId === line.item.id && planned.selected && planned.unit === line.item.unit)?.id : undefined })} />Count {labelOf(line.item)} toward this purchasing list</label>}
        <fieldset disabled={frozen} className="receiving-fields">
          <div><label>Received quantity for {labelOf(line.item)}<input inputMode="decimal" value={line.quantity} {...attributes(line.item.id + ':quantity')} onChange={event => changeLine(line.item.id, { quantity: event.target.value })} /></label>{fieldError(line.item.id + ':quantity')}</div>
          <label>Received unit for {labelOf(line.item)}<select aria-label={'Received unit for ' + labelOf(line.item)} value={line.unit} onChange={event => changeLine(line.item.id, { unit: event.target.value })}>{Array.from(new Set([line.unit, ...inventoryUnits.filter(unit => compatibleStockUnits(unit, line.item.unit))])).map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></label>
          <div><label>Total cost for {labelOf(line.item)} (USD, optional)<input inputMode="decimal" value={line.cost} {...attributes(line.item.id + ':cost')} onChange={event => changeLine(line.item.id, { cost: event.target.value })} /></label>{fieldError(line.item.id + ':cost')}<p className="receiving-small">{line.cost ? 'Cost for this entire received line.' : 'Not recorded'}</p></div>
        </fieldset>
      </article>)}</div>}
      {fieldError('lines')}
      {conflict && <div className="receiving-note"><p>Stock or the saved purchasing list changed. Your actual quantities are kept. Refresh versions, check the destinations and review again.</p><button type="button" className="ska-button" disabled={frozen} onClick={() => void refreshVersions()}>Refresh stock versions</button></div>}
      {!review && !pending && <button type="button" className="ska-button is-primary" disabled={busy || conflict || !history || !!historyError || !lines.length} onClick={() => void preview()}>{busy ? 'Reviewing…' : 'Review receipt'}</button>}
      {review && <section className="receiving-review" aria-label="Receipt review"><h2>Review actual delivery</h2><p>{review.request.receivedOn} · Supplier: {review.request.supplier || 'Not recorded'}</p><p>{review.request.reason}</p>
        <ReceiptLines lines={review.lines} /><p className="receiving-note">Recording adds every received line to inventory together. It does not reserve stock, change saved plans or place an order.</p>
        <div className="receiving-actions"><button type="button" className="ska-button is-primary" disabled={busy || !!pending} onClick={() => void commit()}><Check size={18} aria-hidden="true" />{busy ? 'Recording…' : 'Record receipt'}</button>
          <button type="button" className="ska-button" disabled={frozen} onClick={() => { setReview(null); setError(''); }}>Back to edit</button></div>
      </section>}

      {dirty && <button type="button" className="ska-button receiving-cancel" disabled={frozen} onClick={cancel}>Cancel receipt</button>}
    </section>}
      {pending && <section className="receiving-note" aria-label="Unconfirmed receipt"><h3>Confirm this receipt before making another</h3><p>The result may have been saved even if the response was lost. Keep this page open. Your reviewed amounts are locked; retrying uses the same receipt identifier and cannot add stock twice.</p>
        <div className="receiving-actions"><button type="button" className="ska-button is-primary" disabled={busy || !canWrite} onClick={() => void commit()}>Retry same receipt</button><button type="button" className="ska-button" disabled={busy} onClick={() => void checkStatus()}>Check receipt status</button></div></section>}
    {error && <p role="alert" className="ska-alert is-error">{error}</p>}
    {message && <p role="status" className="ska-alert">{message}</p>}
    {success && <section className="receiving-success"><h2 role="status">Receipt recorded. Inventory updated for {success.lines.length} items.</h2><p>Receipt {success.id} · Received {success.receivedOn}</p><Link className="ska-button" to={'/receiving?receipt=' + encodeURIComponent(success.id)}>View recorded receipt</Link></section>}
    {receiptId && <section className="receiving-panel" aria-label="Recorded receipt"><h2>Recorded receipt</h2>
      {detailLoading && <p role="status">Opening receipt…</p>}
      {detailError && <p role="alert">{detailError} <button type="button" className="ska-button" onClick={() => setDetailRetry(value => value + 1)}>Retry recorded receipt</button></p>}
      {detail && <><p>Receipt {detail.id} · Received {detail.receivedOn} · Supplier: {detail.supplier || 'Not recorded'}</p><p>Recorded by {detail.actorUsername} · {new Date(detail.recordedAt).toLocaleString()}</p><p>{detail.reason}</p>
        {detail.purchasingRef && <p>Purchasing week {detail.purchasingRef.weekStart} · Version {detail.purchasingRef.version} · Stock baseline {new Date(detail.purchasingRef.stockTakenAt).toLocaleString()}</p>}
        <p className="receiving-small">These balances are the original receipt record, not current inventory.</p><ReceiptLines lines={detail.lines} /></>}
    </section>}
    <section className="receiving-panel" aria-label="Receiving history"><h2>Receiving history</h2><p className="receiving-small">Multi-item deliveries stay together here. Individual stock movements also appear in Inventory and Purchase history.</p>
      {historyLoading && <p role="status">Loading receiving history…</p>}
      {historyError && <p role="alert">{historyError} <button type="button" className="ska-button" onClick={() => setHistoryRetry(value => value + 1)}>Retry receiving history</button></p>}
      {!historyLoading && !historyError && history && <>{!history.items.length ? <p>No receipts recorded yet.</p> : <ul className="receiving-history">{history.items.map(batch => <li key={batch.id}><div><strong>{batch.receivedOn} · {batch.supplier || 'Supplier not recorded'}</strong><p>{batch.lines.length} items · Recorded by {batch.actorUsername}</p></div><Link className="ska-button" aria-label={'View receipt ' + batch.id} to={'/receiving?receipt=' + encodeURIComponent(batch.id)}>View receipt</Link></li>)}</ul>}
        <div className="receiving-actions"><button type="button" className="ska-button" disabled={busy || historyPage <= 1} onClick={() => setHistoryPage(value => value - 1)}>Previous receipts</button><span>Page {history.page}</span><button type="button" className="ska-button" disabled={busy || history.page * history.pageSize >= history.total} onClick={() => setHistoryPage(value => value + 1)}>Next receipts</button></div>
      </>}
    </section>
  </div>;
}
