import { useEffect, useState } from 'react';
import axios from 'axios';
import { inventoryUrl } from '../../api/inventory';
import type { InventoryHistory as History, InventorySnapshot } from '../../api/inventory';
import { authError } from '../../auth/transport';

const labels = { opening: 'Opening count', addition: 'Stock addition', usage: 'Usage', correction: 'Count correction', details: 'Details changed' };
const describe = (snapshot: InventorySnapshot) => `${snapshot.name} · ${snapshot.category} · ${snapshot.location} · ${snapshot.unit}`;
export function InventoryHistory({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const [data, setData] = useState<History | null>(null);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    axios.get<History>(inventoryUrl + '/' + encodeURIComponent(itemId) + '/movements', { params: { page, pageSize: 25 }, signal: request.signal })
      .then((response) => { if (!request.signal.aborted) setData(response.data); })
      .catch((failure: unknown) => { if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load movement history.')); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [itemId, page, retry]);
  return <section aria-label="Inventory history" className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
    <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold">Movement history{data ? ': ' + data.item.name : ''}</h2><button onClick={onClose} className="rounded-lg border px-3 py-2">Close history</button></div>
    {loading && <p role="status">Loading movement history…</p>}
    {error && <div><p role="alert" className="text-red-800">{error}</p><button onClick={() => setRetry(retry + 1)} className="mt-2 rounded-lg border px-3 py-2">Retry history</button></div>}
    {!loading && !error && data && <>
      <p className="text-sm text-slate-600">{data.total} recorded changes. Corrections add a record and retain earlier counts.</p>
      <ol className="space-y-3">{data.items.map((movement) => <li key={movement.id} className="rounded-lg border p-4">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{labels[movement.type]}</h3><span className="text-sm text-slate-500">Revision {movement.itemVersion}</span></div>
        <p className="mt-1">{movement.beforeQuantity} → {movement.afterQuantity} {movement.after.unit} <span className="text-slate-500">(change {movement.delta})</span></p>
        <p className="mt-2">{movement.reason}</p>
        <p className="mt-2 text-sm text-slate-600">{movement.actorUsername} · <time dateTime={movement.occurredAt}>{new Date(movement.occurredAt).toLocaleString()}</time></p>
        <p className="mt-1 text-sm text-slate-600">{describe(movement.after)}</p>
        {movement.type === 'details' && movement.before && <p className="mt-1 text-sm text-slate-500">Previously: {describe(movement.before)}; reorder at {movement.before.reorderThreshold}. Now reorder at {movement.after.reorderThreshold}.</p>}
      </li>)}</ol>
      {data.total > data.pageSize && <nav aria-label="History pages" className="flex items-center justify-between">
        <button disabled={page === 1} onClick={() => setPage(page - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-50">Previous changes</button>
        <span>Page {page} of {Math.ceil(data.total / data.pageSize)}</span>
        <button disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-50">Next changes</button>
      </nav>}
    </>}
  </section>;
}
