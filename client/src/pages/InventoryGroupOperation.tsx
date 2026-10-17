import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import { Archive, ArrowRightLeft, FolderMinus } from 'lucide-react';
import { getGroupOperation, type GroupOperationReceipt } from '../api/inventoryGroupRemoval';
import { authError } from '../auth/transport';

const labels = { delete: 'Empty group deleted', move: 'Items moved and group deleted', archive: 'Group and items archived' };
export default function InventoryGroupOperation() {
  const { id = '' } = useParams();
  const [receipt, setReceipt] = useState<GroupOperationReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setReceipt(null); setError('');
    void getGroupOperation(id, request.signal).then(value => { if (!request.signal.aborted) setReceipt(value); })
      .catch(failure => { if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load this inventory group operation.')); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [id, retry]);
  const Icon = receipt?.action === 'archive' ? Archive : receipt?.action === 'move' ? ArrowRightLeft : FolderMinus;
  return <div className="ska-core-page space-y-5">
    <Link className="ska-button" to="/inventory">Back to inventory</Link>
    <section aria-label="Inventory group operation" className="min-w-0 space-y-4 rounded-2xl border bg-white p-4 shadow-sm sm:p-6">
      <h1 className="flex items-center gap-3 text-2xl font-bold"><Icon aria-hidden="true" /> Inventory group operation</h1>
      {loading && <p role="status">Loading group operation…</p>}
      {error && <div><p role="alert">{error}</p><button type="button" className="ska-button mt-3" onClick={() => setRetry(value => value + 1)}>Retry group operation</button></div>}
      {!loading && !error && receipt && <>
        <h2 className="text-xl font-bold">{labels[receipt.action]}</h2>
        <p className="break-words"><strong>{receipt.sourceBefore.name}</strong>{receipt.target && <> → <strong>{receipt.target.name}</strong></>}</p>
        <p>{receipt.itemCount} inventory records · {receipt.nonzeroCount} with a nonzero recorded quantity</p>
        <p>{receipt.action === 'archive' ? 'Archived records are read-only and excluded from active stock. Their quantities remain recorded; this operation did not dispose of stock.' : 'Quantities, units, locations and earlier history are retained.'}</p>
        <p className="break-words">Reason: {receipt.reason}</p>
        <p className="text-sm text-slate-600">Recorded by {receipt.actorUsername} · <time dateTime={receipt.recordedAt}>{new Date(receipt.recordedAt).toLocaleString()}</time></p>
        {!!receipt.totals.length && <p>Recorded balances: {receipt.totals.map(value => value.quantity + ' ' + value.unit).join(' · ')}</p>}
        {!receipt.members.length && <p>The group was empty. No item records were changed.</p>}
        <ol className="space-y-3">{receipt.members.map(({ before, after, movementId }) => <li key={before.id} className="min-w-0 space-y-2 rounded-xl border p-4">
          <h3 className="break-words font-semibold">{before.name}</h3>
          <p>{before.quantity} → {after.quantity} {after.unit} · {after.location}</p>
          <p className="break-words">Group: {before.category} → {after.category}{after.archived && ' · Archived'}</p>
          <p className="break-all text-sm text-slate-500">Record: {before.id}{movementId && <> · History: {movementId}</>}</p>
        </li>)}</ol>
      </>}
    </section>
  </div>;
}
