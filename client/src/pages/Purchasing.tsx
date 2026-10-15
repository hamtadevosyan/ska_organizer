import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Download, Package, Printer, RefreshCw, ShoppingBasket } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { getPurchasingList, getPurchasingOptions, previewPurchasingList, purchasingCsv, savePurchasingList } from '../api/purchasing';
import type { PurchasingLine, PurchasingList, PurchasingOptions, PurchasingSelection } from '../api/purchasing';
import { currentMonday, mondayOf } from '../components/meals/weeklyPlan';
import { validQuantity } from '../components/inventory/quantity';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import './purchasing.css';

const emptySelection = (): PurchasingSelection => ({ includeMeals: true, roomIds: [], lowStockTargets: [] });
const selectionOf = (list: PurchasingList): PurchasingSelection => ({ includeMeals: list.includeMeals,
  roomIds: [...list.roomIds].sort(), lowStockTargets: [...list.lowStockTargets].sort((a, b) => a.itemId.localeCompare(b.itemId)) });
const lineName = (line: PurchasingLine) => line.name + (line.location ? ' at ' + line.location : '');
const stamp = (date: string | null) => date ? new Date(date).toLocaleString() : 'Not saved';

function PurchasingSourceDetails({ line }: { line: PurchasingLine }) {
  return <><ul className="purchasing-source-list">{line.sources.map((source, index) => <li key={index}><span>{source.label}{source.date ? ' · ' + source.date : ''}</span><strong>{source.quantity} {source.unit}</strong>{source.reusable && <em>Shared reusable equipment</em>}</li>)}</ul>
    {line.stockItems.map(stock => <p key={stock.id} className="purchasing-small">{stock.name} · {stock.location} · Recorded {stock.quantity} {stock.unit} · Used in this estimate {stock.allocated} {stock.unit} · Stock version {stock.version}</p>)}
  </>;
}

export default function Purchasing() {
  const { account } = useAuth();
  const canWrite = account?.role === 'admin' || account?.role === 'editor';
  const [params, setParams] = useSearchParams();
  const week = mondayOf(params.get('week') || '') || currentMonday();
  const [options, setOptions] = useState<PurchasingOptions>({ rooms: [], lowStock: [] });
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState('');
  const [optionRetry, setOptionRetry] = useState(0);
  const [selection, setSelection] = useState<PurchasingSelection>(emptySelection);
  const [list, setList] = useState<PurchasingList | null>(null);
  const [savedVersion, setSavedVersion] = useState(0);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [conflict, setConflict] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const downloads = useRef(new Set<string>());
  const reportUnsaved = useUnsavedChanges();
  const configChanged = !!list && JSON.stringify(selection) !== JSON.stringify(selectionOf(list));
  const hasUnsaved = canWrite && (dirty || !!token || configChanged);

  useEffect(() => {
    const controller = new AbortController(); setOptionsLoading(true); setOptionsError('');
    void getPurchasingOptions(controller.signal).then(value => {
      if (!controller.signal.aborted) setOptions(value);
    }).catch(failure => {
      if (!controller.signal.aborted && !axios.isCancel(failure)) setOptionsError(authError(failure, 'Could not load room and low-stock choices.'));
    }).finally(() => { if (!controller.signal.aborted) setOptionsLoading(false); });
    return () => controller.abort();
  }, [optionRetry]);
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    busyRef.current = false; setBusy(false); setLoading(true); setLoadFailed(false); setError(''); setMessage(''); setConflict(false); setInvalid({});
    setList(null); setSelection(emptySelection()); setSavedVersion(0); setToken(''); setDirty(false);
    void getPurchasingList(week, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setList(value); setSavedVersion(value?.version || 0);
      if (value) setSelection(selectionOf(value));
    }).catch(failure => {
      if (!controller.signal.aborted && !axios.isCancel(failure)) { setLoadFailed(true); setError(authError(failure, 'Could not open this week’s purchasing list. Retry before making changes.')); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [week, loadRetry]);
  useEffect(() => { reportUnsaved(hasUnsaved, busy); }, [reportUnsaved, hasUnsaved, busy]);
  useEffect(() => () => { reportUnsaved(false, false); }, [reportUnsaved]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (hasUnsaved || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [hasUnsaved, busy]);
  useEffect(() => { const urls = downloads.current; return () => { request.current?.abort(); urls.forEach(url => URL.revokeObjectURL(url)); }; }, []);

  function changeSelection(next: PurchasingSelection) {
    if (!canWrite || busyRef.current || loading || loadFailed || conflict) return;
    setSelection({ ...next, roomIds: [...next.roomIds].sort(), lowStockTargets: [...next.lowStockTargets].sort((a, b) => a.itemId.localeCompare(b.itemId)) });
    setDirty(true); setInvalid({}); setMessage('');
  }
  function changeLine(id: string, values: Partial<Pick<PurchasingLine, 'buyQuantity' | 'selected' | 'checked'>>) {
    if (!canWrite || busyRef.current || configChanged || conflict) return;
    setList(current => current && ({ ...current, lines: current.lines.map(line => line.id === id ? { ...line, ...values } : line) }));
    setDirty(true); setInvalid({}); setMessage('');
  }
  function fail(failure: unknown, fallback: string) {
    if (axios.isCancel(failure)) return;
    setError(authError(failure, fallback));
    if (axios.isAxiosError(failure) && failure.response?.status === 409 && failure.response?.data?.error?.code !== 'PURCHASING_PREVIEW_EXPIRED') setConflict(true);
  }
  async function build() {
    if (busyRef.current || loading || loadFailed || optionsLoading || optionsError || conflict) return;
    const errors: Record<string, boolean> = {};
    for (const target of selection.lowStockTargets) if (!validQuantity(target.targetQuantity) || Number(target.targetQuantity) <= 0) errors[target.itemId] = true;
    setInvalid(errors); setError('');
    if (Object.keys(errors).length) { setError('Enter a total coverage greater than zero, with at most six decimal places, for each selected low-stock item.'); return; }
    busyRef.current = true; setBusy(true); setMessage('');
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    try {
      const result = await previewPurchasingList(week, selection, controller.signal);
      if (controller.signal.aborted) return;
      if (result.list.version !== savedVersion) {
        setConflict(true); setError('This purchasing list changed elsewhere. Reopen the saved list before building another review.'); return;
      }
      const previous = new Map(list?.lines.map(line => [line.id, line]) || []);
      const refreshed = { ...result.list, lines: result.list.lines.map(line => {
        const old = previous.get(line.id);
        if (!old) return line;
        // Deliberate buying amounts survive refresh. Changed calculations clear
        // check-off so a stale purchase mark cannot silently hide a new need.
        const manuallyAdjusted = old.buyQuantity !== old.toBuy;
        const buyQuantity = manuallyAdjusted ? old.buyQuantity : line.buyQuantity;
        const selected = manuallyAdjusted || old.selected !== (Number(old.toBuy) > 0) ? old.selected : line.selected;
        const sameCalculation = old.needed === line.needed && old.inStorage === line.inStorage && old.toBuy === line.toBuy;
        return { ...line, buyQuantity, selected, checked: selected && old.checked && old.buyQuantity === buyQuantity && sameCalculation };
      }) };
      setList(refreshed); setToken(result.token); setDirty(canWrite);
      setMessage('Current stock sampled. Review the list before saving. Manual buying amounts and selection overrides were kept for matching items; new shortages are selected, and changed needs clear their check-off.');
    } catch (failure) { if (!controller.signal.aborted) fail(failure, 'Could not build the purchasing list. Your current review is still here.'); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  async function save() {
    if (!canWrite || busyRef.current || !list || configChanged || conflict || list.issues.length) return;
    const errors = Object.fromEntries(list.lines.filter(line => !validQuantity(line.buyQuantity)).map(line => [line.id, true]));
    setInvalid(errors); setError('');
    if (Object.keys(errors).length) { setError('Enter non-negative buying quantities with at most six decimal places.'); return; }
    busyRef.current = true; setBusy(true); setMessage('');
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    try {
      const saved = await savePurchasingList(week, { version: savedVersion, ...(token ? { token } : {}),
        choices: list.lines.map(({ id, buyQuantity, selected, checked }) => ({ id, buyQuantity, selected, checked })) }, controller.signal);
      if (controller.signal.aborted) return;
      setList(saved); setSavedVersion(saved.version); setSelection(selectionOf(saved)); setDirty(false); setToken('');
      setMessage('Purchasing list saved. Stock and saved plans were not changed.');
    } catch (failure) { if (!controller.signal.aborted) fail(failure, 'Could not save the purchasing list. Your review is still here; try again.'); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  function reopen() {
    if (busyRef.current || (hasUnsaved && !window.confirm('Discard your unsaved purchasing review and open the latest saved list?'))) return;
    setLoadRetry(value => value + 1);
  }
  const downloadCsv = useCallback(() => {
    if (!list || list.issues.length) return;
    const url = URL.createObjectURL(new Blob([purchasingCsv(list, hasUnsaved || !!token || !list.savedAt)], { type: 'text/csv;charset=utf-8' }));
    downloads.current.add(url);
    const link = document.createElement('a'); link.href = url; link.download = `purchasing-${list.weekStart}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 1000);
  }, [list, hasUnsaved, token]);
  const selected = list?.lines.filter(line => line.selected) || [];
  const disabled = busy || loading || loadFailed || conflict || !canWrite;
  return <div className="ska-page ska-core-page purchasing-page">
    <header className="ska-page-head purchasing-no-print">
      <div><h1><span className="ska-heading-icon is-yellow"><ShoppingBasket size={24} aria-hidden="true" /></span>Purchasing</h1><p>One clear list for food, activity materials and supplies.</p></div>
      <Link to="/inventory" className="ska-button"><Package size={18} aria-hidden="true" />Inventory</Link>
    </header>
    <section className="purchasing-intro purchasing-no-print"><span className="purchasing-intro-icon"><ShoppingBasket aria-hidden="true" /></span><div>
      <h2>Plan it. Review it. Buy what you need.</h2><p>Use saved weekly plans, subtract compatible stock once, then choose what to buy. This is an estimate; nothing is reserved or added to inventory.</p>
    </div></section>
    {!canWrite && <p className="purchasing-hint purchasing-no-print">Read-only access: review, refresh, print and export. An administrator or editor can change and save this list.</p>}
    <section aria-label="Purchasing sources" className="purchasing-panel purchasing-no-print">
      <label className="purchasing-week">Purchasing week starting Monday<input type="date" value={week} disabled={busy} onChange={event => {
        const next = mondayOf(event.target.value);
        if (!next || next === week || busyRef.current || (hasUnsaved && !window.confirm('Discard your unsaved purchasing review and change weeks?'))) return;
        setDirty(false); setToken(''); reportUnsaved(false, false);
        setParams(previous => { const nextParams = new URLSearchParams(previous); nextParams.set('week', next); return nextParams; }, { replace: true });
      }} /></label>
      {loading && <p role="status">Opening purchasing list…</p>}
      {optionsLoading && <p role="status">Loading room and low-stock choices…</p>}
      {optionsError && <p role="alert">{optionsError} <button type="button" className="ska-button" onClick={() => setOptionRetry(value => value + 1)}>Retry source choices</button></p>}
      <fieldset disabled={disabled || optionsLoading || !!optionsError} className="purchasing-source-fields">
        <legend>What should this list cover?</legend>
        <label className="purchasing-check"><input type="checkbox" checked={selection.includeMeals} onChange={event => changeSelection({ ...selection, includeMeals: event.target.checked })} />Include saved meal plan</label>
        <p className="purchasing-small">Recipes and headcounts come from this week’s saved meal snapshot.</p>
        <div><h3>Activity plans by room</h3><p className="purchasing-small">Choose each room to include. Shared equipment is counted for overlapping activities across these rooms.</p>
          {!optionsLoading && !options.rooms.length && <p className="purchasing-small">No rooms are available. Add a room and save its activity plan first.</p>}
          <div className="purchasing-room-grid">{options.rooms.map(room => <label key={room.id} className="purchasing-check"><input type="checkbox" checked={selection.roomIds.includes(room.id)}
            onChange={event => changeSelection({ ...selection, roomIds: event.target.checked ? [...selection.roomIds, room.id] : selection.roomIds.filter(id => id !== room.id) })} />Include {room.name}{room.archived ? ' (archived)' : ''}</label>)}</div>
          {selection.roomIds.filter(id => !options.rooms.some(room => room.id === id)).map(id => <div key={id} className="purchasing-hint"><p>A previously selected room is unavailable: {id}.</p><button type="button" className="ska-button" onClick={() => changeSelection({ ...selection, roomIds: selection.roomIds.filter(roomId => roomId !== id) })}>Remove previous room</button></div>)}
        </div>
        <details><summary>Optional low-stock supplies ({selection.lowStockTargets.length} selected)</summary>
          <p className="purchasing-small">Choose a total coverage target for this exact item and location. The target covers plan demand too; it is not an extra order or a desired remaining balance.</p>
          {!optionsLoading && !options.lowStock.length && <p className="purchasing-small">No low-stock items right now.</p>}
          {options.lowStock.map(item => {
            const target = selection.lowStockTargets.find(value => value.itemId === item.id);
            return <div key={item.id} className="purchasing-target"><label className="purchasing-check"><input type="checkbox" checked={!!target} onChange={event => changeSelection({ ...selection,
              lowStockTargets: event.target.checked ? [...selection.lowStockTargets, { itemId: item.id, targetQuantity: '' }] : selection.lowStockTargets.filter(value => value.itemId !== item.id) })} />Top up {item.name} at {item.location}</label>
              <p className="purchasing-small">When choices were loaded: {item.quantity} {item.unit} · Low-stock level: {item.reorderThreshold} {item.unit}</p>
              {target && <label>Total coverage for {item.name} at {item.location} ({item.unit})<input inputMode="decimal" value={target.targetQuantity} aria-invalid={!!invalid[item.id]}
                onChange={event => changeSelection({ ...selection, lowStockTargets: selection.lowStockTargets.map(value => value.itemId === item.id ? { ...value, targetQuantity: event.target.value } : value) })} /></label>}
            </div>;
          })}
          {selection.lowStockTargets.filter(target => !options.lowStock.some(item => item.id === target.itemId)).map(target => <div key={target.itemId} className="purchasing-target">
            <p>Previously selected item is no longer in the low-stock choices: {list?.lines.find(line => line.itemId === target.itemId)?.name || target.itemId} · Target {target.targetQuantity}</p>
            <button type="button" className="ska-button" onClick={() => changeSelection({ ...selection, lowStockTargets: selection.lowStockTargets.filter(value => value.itemId !== target.itemId) })}>Remove previous target</button>
          </div>)}
        </details>
      </fieldset>
      <div className="purchasing-actions"><button type="button" className="ska-button is-primary" disabled={busy || loading || loadFailed || optionsLoading || !!optionsError || conflict} onClick={() => void build()}>
        <RefreshCw size={18} aria-hidden="true" />{busy ? 'Working…' : list ? 'Refresh current stock' : 'Build purchasing list'}</button>
        <button type="button" className="ska-button" disabled={busy || loading} onClick={reopen}>{conflict ? 'Reopen saved list' : 'Open saved list'}</button>
      </div>
      {configChanged && <p className="purchasing-hint">Your source choices changed. Refresh current stock to build a new review. The list below still shows the previous choices.</p>}
    </section>
    {error && <div role="alert" className="ska-alert is-error purchasing-no-print"><p>{error}</p>
      {conflict ? <p>Another person saved this week. Your review is kept here. Reopen the saved list to review their version before editing.</p>
        : loadFailed && <button type="button" className="ska-button" onClick={() => setLoadRetry(value => value + 1)}>Retry opening list</button>}
    </div>}
    {message && <p role="status" className="ska-alert purchasing-no-print">{message}</p>}
    {list && <section aria-label="Purchasing review" className="purchasing-review">
      <div className="purchasing-review-head"><div><h2>Purchasing list · Week of {list.weekStart}</h2>
        <p className="purchasing-badge">{hasUnsaved || !!token || !list.savedAt ? 'Unsaved preview' : 'Saved version ' + list.version}</p>
        <p className="purchasing-small">Stock sampled: <time dateTime={list.stockTakenAt}>{stamp(list.stockTakenAt)}</time> · Saved: {stamp(list.savedAt)}</p>
        <p className="purchasing-small">{list.mealPlan ? `Meal plan version ${list.mealPlan.version}` : list.includeMeals ? 'Meal plan unavailable' : 'Meals not included'}{list.activityPlans.length ? ' · Activity rooms: ' + list.activityPlans.map(plan => plan.roomName + ' (v' + plan.version + ')').join(', ') : ' · No activity rooms included'}</p>
      </div><span className="purchasing-count">{selected.length} to buy · {selected.filter(line => line.checked).length} checked</span></div>
      <p className="purchasing-small">Saved calculations stay unchanged on reload. Use Refresh current stock deliberately, then Save purchasing list to replace the review. A check-off marks this list only; record actual deliveries separately in Inventory.</p>
      {!!list.issues.length && <section aria-label="Purchasing issues" className="purchasing-issues"><h3>Resolve these before saving or purchasing</h3><ul>{list.issues.map((issue, index) => <li key={issue.code + index}>
        <strong>{issue.message}</strong><p>{issue.resolution}</p>{issue.href && issue.href.startsWith('/') && !issue.href.startsWith('//') && <Link to={issue.href} className="purchasing-no-print">Open the related record</Link>}
      </li>)}</ul></section>}
      {!list.lines.length && !list.issues.length && <p className="purchasing-empty">No purchases are needed for these saved plans and targets.</p>}
      <div className="purchasing-list">{list.lines.map(line => <article key={line.id} aria-label={lineName(line)} className={'purchasing-card' + (line.selected ? ' is-selected' : '')}>
        <div className="purchasing-card-heading"><div><h3>{line.name}</h3><p>{line.location || 'No linked stock location'}</p></div><span className="purchasing-unit">{line.unit}</span></div>
        <dl className="purchasing-math"><div><dt>Needed</dt><dd>{line.needed} {line.unit}</dd></div><div><dt>In stock</dt><dd>{line.inStorage} {line.unit}</dd></div><div><dt>To buy</dt><dd>{line.toBuy} {line.unit}</dd></div></dl>
        <div className="purchasing-line-controls purchasing-no-print"><label>Buy quantity for {lineName(line)} ({line.unit})<input inputMode="decimal" value={line.buyQuantity} aria-invalid={!!invalid[line.id]} disabled={!canWrite || busy || configChanged || conflict} onChange={event => changeLine(line.id, { buyQuantity: event.target.value, checked: false })} /></label>
          <label className="purchasing-check"><input type="checkbox" checked={line.selected} disabled={!canWrite || busy || configChanged || conflict} onChange={event => changeLine(line.id, { selected: event.target.checked, ...(event.target.checked ? {} : { checked: false }) })} />Buy {lineName(line)}</label>
          <label className="purchasing-check"><input type="checkbox" checked={line.checked} disabled={!canWrite || busy || !line.selected || configChanged || conflict} onChange={event => changeLine(line.id, { checked: event.target.checked })} />Checked off {lineName(line)}</label>
        </div>
        <p className="purchasing-print-only">Buy: {line.buyQuantity} {line.unit} · {line.checked ? 'Checked off' : 'Not checked off'}</p>
        <details className="purchasing-no-print"><summary>Sources &amp; stock details</summary><PurchasingSourceDetails line={line} /></details>
        <div className="purchasing-print-only"><PurchasingSourceDetails line={line} /></div>
        {line.notes.map((note, index) => <p key={index} className="purchasing-hint">{note}</p>)}
      </article>)}</div>
      <div className="purchasing-actions purchasing-footer purchasing-no-print">
        {canWrite && <button type="button" className="ska-button is-primary" disabled={busy || configChanged || conflict || !!list.issues.length || !hasUnsaved} onClick={() => void save()}><Check size={18} aria-hidden="true" />{busy ? 'Saving…' : 'Save purchasing list'}</button>}
        <button type="button" className="ska-button" disabled={busy || configChanged || !!list.issues.length || !selected.length} onClick={downloadCsv}><Download size={18} aria-hidden="true" />Export selected CSV</button>
        <button type="button" className="ska-button" disabled={busy || configChanged || !!list.issues.length || !selected.length} onClick={() => window.print()}><Printer size={18} aria-hidden="true" />Print selected list</button>
      </div>
    </section>}
    {!loading && !list && !error && <p className="purchasing-empty purchasing-no-print">No purchasing list saved for this week. Choose your sources and build a review.</p>}
  </div>;
}
