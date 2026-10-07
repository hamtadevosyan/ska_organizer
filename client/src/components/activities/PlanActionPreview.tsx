import { useEffect, useState } from 'react';
import axios from 'axios';
import { authError } from '../../auth/transport';
import { activityPlanUrl, entryPayload, materialUnitLabel } from '../../api/activities';
import type { ActivityPlan, Entry, MaterialCheck } from '../../api/activities';

type Props = { plan: ActivityPlan; entries: Entry[]; disabled?: boolean; actionLabel: string; onApply: () => void };
type Result = { entries: Entry[]; version: number; materials: MaterialCheck[]; error: string; valid: boolean };

export function PlanActionPreview({ plan, entries, disabled, actionLabel, onApply }: Props) {
  const [result, setResult] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState(true);
  const current = result?.entries === entries && result.version === plan.version ? result : null;
  useEffect(() => {
    const controller = new AbortController();
    setPending(true); setResult(null);
    void axios.post<{ data: { materials: MaterialCheck[] } }>(activityPlanUrl + '/preview',
      { roomId: plan.roomId, weekStart: plan.weekStart, version: plan.version, entries: entryPayload(entries) }, { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setResult({ entries, version: plan.version, materials: response.data.data.materials, error: '', valid: true }); })
      .catch(failure => { if (!controller.signal.aborted) setResult({ entries, version: plan.version, materials: [], error: authError(failure, 'Could not check this change. Try again. Your draft is unchanged.'), valid: false }); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [entries, plan.roomId, plan.weekStart, plan.version, retry]);
  return <section className="planner-action-preview" aria-label="Change preview">
    <h3>Materials after this change</h3>
    <p>For the whole destination week, using current stock. Copying, moving and saving use or reserve no stock.</p>
    {pending || !current ? <p role="status">Checking current stock and saved activities…</p> : current.error ? <p role="alert" className="ska-alert is-error">{current.error}</p>
      : !current.materials.length ? <p>No materials listed for this week.</p>
      : <ul className="planner-action-materials">{current.materials.map(item => <li key={item.itemId + ':' + item.unit}><strong>{item.name}</strong>
        <span>Needed: {item.needed} {materialUnitLabel(item.unit)} · Available: {item.issue ? 'Check item' : item.available + ' ' + materialUnitLabel(item.unit)}</span>
        <span>{item.issue || (item.shortage === '0' ? 'Ready' : 'To get: ' + item.shortage + ' ' + materialUnitLabel(item.unit))}</span>
      </li>)}</ul>}
    <div className="planner-action-buttons"><button type="button" className="ska-button" disabled={pending} onClick={() => setRetry(value => value + 1)}>Check preview again</button>
      <button type="button" className="ska-button is-primary" disabled={disabled || pending || !current?.valid} onClick={onApply}>{actionLabel}</button></div>
    <p>Changes stay in the draft until Save week. You can undo them before saving.</p>
  </section>;
}
