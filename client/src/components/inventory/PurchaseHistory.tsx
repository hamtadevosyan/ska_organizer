import { useEffect, useState } from 'react';
import axios from 'axios';
import { inventoryUrl } from '../../api/inventory';
import type { PurchaseList } from '../../api/inventory';
import { authError } from '../../auth/transport';

const button = 'rounded-lg border bg-white px-4 py-2 disabled:opacity-50';
export function PurchaseHistory({ itemId, itemName, onClose }: { itemId?: string; itemName?: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<PurchaseList>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    axios.get<PurchaseList>(inventoryUrl + '/purchases', { params: { ...(itemId ? { itemId } : {}), page, pageSize: 25 }, signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setData(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(authError(failure, 'Could not load purchase history. Try again.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [itemId, page, retry]);
  return <section aria-label="Purchase history" className="space-y-4 rounded-2xl border bg-white p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">Purchase history{itemName ? ': ' + itemName : ''}</h2><button className={button} onClick={onClose}>Close purchase history</button></div>
    <p className="text-sm text-slate-600">Item names, units and locations show the details recorded when each purchase was received.</p>
    {loading && <p role="status">Loading purchases…</p>}
    {error && <div role="alert">{error} <button className={button} onClick={() => setRetry((n) => n + 1)}>Retry purchases</button></div>}
    {!loading && !error && data && <>
      {!data.items.length ? <p>No purchases recorded yet.</p> : <div className="overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Received purchases</caption>
        <thead><tr>{['Received', 'Item and location', 'Quantity', 'Supplier', 'Total cost', 'Recorded by'].map((label) => <th scope="col" key={label} className="p-3">{label}</th>)}</tr></thead>
        <tbody>{data.items.map((receipt) => <tr key={receipt.id} className="border-t">
          <td className="p-3">{receipt.receivedOn}</td><th scope="row" className="p-3 font-normal"><strong>{receipt.itemSnapshot.name}</strong><p className="text-sm text-slate-500">{receipt.itemSnapshot.location}</p></th>
          <td className="p-3">{receipt.quantity} {receipt.unit}</td><td className="p-3">{receipt.supplier || 'Not recorded'}</td>
          <td className="p-3">{receipt.totalCost === null ? 'Not recorded' : receipt.totalCost + ' ' + receipt.currency}</td>
          <td className="p-3">{receipt.actorUsername}<p className="text-xs text-slate-500">{new Date(receipt.recordedAt).toLocaleString(undefined, { timeZone: data.timeZone })} ({data.timeZone})</p></td>
        </tr>)}</tbody></table></div>}
      {data.total > data.pageSize && <nav aria-label="Purchase pages" className="flex items-center justify-between"><button className={button} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous purchases</button><span>Page {page} of {Math.ceil(data.total / data.pageSize)}</span><button className={button} disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next purchases</button></nav>}
    </>}
  </section>;
}
