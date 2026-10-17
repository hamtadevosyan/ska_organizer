import { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { PackageCheck } from 'lucide-react';
import { getPurchasingFulfillment, type PurchasingFulfillment } from '../../api/batchPurchases';
import { authError } from '../../auth/transport';

export default function PurchasingReceiptProgress({ weekStart, version, stockTakenAt, canReceive }: {
  weekStart: string; version: number; stockTakenAt: string; canReceive: boolean;
}) {
  const [progress, setProgress] = useState<PurchasingFulfillment | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setProgress(null); setError('');
    void getPurchasingFulfillment(weekStart, controller.signal).then(value => {
      if (!controller.signal.aborted) setProgress(value);
    }).catch(failure => {
      if (!controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load received purchases.'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [weekStart, version, stockTakenAt, retry]);
  const matches = progress?.version === version && progress.stockTakenAt === stockTakenAt;
  return <section aria-label="Received purchases" className="purchasing-panel purchasing-no-print">
    <h3><PackageCheck size={20} aria-hidden="true" /> Received purchases</h3>
    {loading && <p role="status">Loading received amounts…</p>}
    {error && <p role="alert">{error} <button type="button" className="ska-button" onClick={() => setRetry(value => value + 1)}>Retry received amounts</button></p>}
    {!loading && !error && !matches && <p>The saved purchasing list changed. Reopen it to see matching received amounts.</p>}
    {matches && <><p className="purchasing-small">{progress.note}</p>
      <ul className="purchasing-source-list">{progress.lines.filter(line => line.selected).map(line => <li key={line.id}><span>{line.name}{line.location ? ' · ' + line.location : ''}</span>
        <strong>Received {line.receivedQuantity} {line.unit} · Remaining {line.remainingQuantity} {line.unit}</strong>{line.unavailable && <p>{line.availabilityMessage}</p>}</li>)}</ul>
      {canReceive && <Link className="ska-button is-primary" to={'/receiving?week=' + encodeURIComponent(weekStart)}>Receive purchases</Link>}
    </>}
  </section>;
}
