import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Archive, ArrowRightLeft, FolderMinus, RefreshCw } from 'lucide-react';
import { useAuth } from '../../auth/context';
import { authError } from '../../auth/transport';
import { inventoryRequestId } from '../../api/inventory';
import { commitGroupRemoval, forgetUnconfirmedGroupRemoval, getGroupRemovalByRequest, getGroupRemovalContext, getUnconfirmedGroupRemoval, previewGroupRemoval, rememberUnconfirmedGroupRemoval } from '../../api/inventoryGroupRemoval';
import type { GroupOperationReceipt, GroupRemovalAction, GroupRemovalCommit, GroupRemovalContext, GroupRemovalReview } from '../../api/inventoryGroupRemoval';
import { useUnsavedChanges } from '../UnsavedChangesContext';
import './inventoryGroupRemoval.css';

const actionLabels: Record<GroupRemovalAction, string> = { delete: 'Delete empty group', move: 'Move all items and delete group', archive: 'Archive group and all items' };
const definitive = (failure: unknown) => axios.isAxiosError(failure) && !!failure.response && failure.response.status >= 400 && failure.response.status < 500 && failure.response.status !== 408;
function Members({ members }: { members: GroupRemovalContext['members'] }) {
  return <ul className="group-removal-members">{members.map(item => <li key={item.id}><div><strong>{item.name}</strong><p>{item.location} · {item.unit}{item.ingredientId ? ' · Connected food retained' : ''}</p></div><span>{item.quantity} {item.unit}</span></li>)}</ul>;
}
export function InventoryGroupRemoval({ groupId, onSaved, onCancel }: { groupId: string; onSaved: (receipt: GroupOperationReceipt) => void; onCancel: () => void }) {
  const { account } = useAuth();
  const canWrite = account?.role === 'admin' || account?.role === 'editor';
  const initial = useRef(account ? getUnconfirmedGroupRemoval(account.id) : undefined);
  const restored = initial.current?.groupId === groupId ? initial.current : undefined;
  const [context, setContext] = useState<GroupRemovalContext | null>(null);
  const [loading, setLoading] = useState(!restored);
  const [contextError, setContextError] = useState('');
  const [retry, setRetry] = useState(0);
  const [action, setAction] = useState<GroupRemovalAction | ''>(restored?.review.action || '');
  const [targetId, setTargetId] = useState(restored?.review.target?.id || '');
  const [reason, setReason] = useState(restored?.review.reason || '');
  const [review, setReview] = useState<GroupRemovalReview | null>(restored?.review || null);
  const [acknowledged, setAcknowledged] = useState(restored?.request.acknowledgeRetainedStock || false);
  const [pending, setPending] = useState<GroupRemovalCommit | null>(restored?.request || null);
  const [dirty, setDirty] = useState(!!restored);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const reportUnsaved = useUnsavedChanges();
  const hasUnsaved = !!pending || (canWrite && dirty);
  const frozen = busy || !!pending;
  const source = review?.source || context?.source;
  useEffect(() => {
    if (restored) return;
    const controller = new AbortController(); setLoading(true); setContextError(''); setContext(null);
    void getGroupRemovalContext(groupId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setContext(value); setConflict(false); setReview(null); setAcknowledged(false);
      if (retry) setMessage('Latest group membership loaded. Your choices and reason were kept. Review the complete item list again before confirming.');
    }).catch(failure => {
      if (!controller.signal.aborted && !axios.isCancel(failure)) setContextError(authError(failure, 'Could not load this group and all its items. Retry before making a removal decision.'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [groupId, retry, restored]);
  useEffect(() => { reportUnsaved(hasUnsaved, busy || !!pending); }, [reportUnsaved, hasUnsaved, busy, pending]);
  useEffect(() => () => { request.current?.abort(); reportUnsaved(false, false); }, [reportUnsaved]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (hasUnsaved || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [hasUnsaved, busy]);
  function change() { setDirty(true); setReview(null); setAcknowledged(false); setError(''); setMessage(''); setFields({}); }
  function failed(failure: unknown, fallback: string) {
    if (axios.isCancel(failure)) return;
    setError(authError(failure, fallback));
    if (axios.isAxiosError(failure) && failure.response?.status === 409) setConflict(true);
  }
  async function preview() {
    if (!canWrite || busyRef.current || pending || !context || loading || conflict) return;
    const invalid: Record<string, string> = {};
    const target = context.destinations.find(group => group.id === targetId);
    if (!action) invalid.action = 'Choose what should happen to this group.';
    if (action === 'delete' && context.itemCount) invalid.action = 'A group can only be deleted while it has no item records. Move or archive its items instead.';
    if (action === 'move' && !target) invalid.target = 'Choose a compatible active destination group.';
    if (reason.trim().length > 500 || (action === 'archive' && context.nonzeroCount > 0 && !reason.trim())) invalid.reason = 'Explain why these remaining balances should be archived, using up to 500 characters.';
    setFields(invalid); setError('');
    if (Object.keys(invalid).length || !action) return;
    const controller = new AbortController(); request.current = controller; busyRef.current = true; setBusy(true); setMessage('');
    try {
      const value = await previewGroupRemoval(groupId, { action, contextVersion: context.contextVersion, ...(action === 'move' && target ? { targetGroupId: target.id, targetVersion: target.version } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) }, controller.signal);
      if (!controller.signal.aborted) { setReview(value); setAcknowledged(false); }
    } catch (failure) { if (!controller.signal.aborted) failed(failure, 'Could not prepare the group removal review. Your choices are still here.'); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  function confirmed(receipt: GroupOperationReceipt) {
    if (account) forgetUnconfirmedGroupRemoval(account.id);
    setPending(null); setDirty(false); setReview(null); setError(''); reportUnsaved(false, false); onSaved(receipt);
  }
  async function commit() {
    if (!canWrite || busyRef.current || !review || conflict) return;
    if (!pending && review.action === 'archive' && review.nonzeroCount > 0 && !acknowledged) { setFields({ acknowledge: 'Confirm that recorded quantities will remain unchanged.' }); return; }
    const wasPending = !!pending;
    const payload = pending || { requestId: inventoryRequestId(), reviewToken: review.reviewToken, acknowledgeRetainedStock: acknowledged };
    if (account) rememberUnconfirmedGroupRemoval(account.id, { groupId, request: payload, review });
    setPending(payload); setError(''); setMessage(''); busyRef.current = true; setBusy(true);
    const controller = new AbortController(); request.current = controller;
    try {
      const receipt = await commitGroupRemoval(groupId, payload, controller.signal);
      if (!controller.signal.aborted) confirmed(receipt);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(authError(failure, 'Could not confirm the group operation. Keep this page open and retry the same group removal.'));
        if (!wasPending && definitive(failure)) {
          if (account) forgetUnconfirmedGroupRemoval(account.id);
          setPending(null); setReview(null); failed(failure, 'The operation was rejected. Your choices are kept.');
          setMessage('Nothing was confirmed. Refresh the review before trying again.'); setConflict(true);
        }
      }
    } finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  async function checkStatus() {
    if (!pending || busyRef.current) return;
    const controller = new AbortController(); request.current = controller; busyRef.current = true; setBusy(true); setError('');
    try {
      const receipt = await getGroupRemovalByRequest(pending.requestId, controller.signal);
      if (!controller.signal.aborted) {
        if (receipt) confirmed(receipt);
        else setMessage('No confirmed operation was found yet. Retry the same group removal safely; its original choices remain locked.');
      }
    } catch (failure) { if (!controller.signal.aborted) setError(authError(failure, 'Could not check the operation. Keep this page open and retry when connected.')); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  function refreshReview() {
    if (busyRef.current || pending) return;
    setReview(null); setError(''); setMessage(''); setFields({}); setRetry(value => value + 1);
  }
  function cancel() {
    if (busyRef.current || pending || (dirty && !window.confirm('Discard this unconfirmed group removal? No group or item has been changed.'))) return;
    reportUnsaved(false, false); onCancel();
  }
  const fieldError = (name: string) => fields[name] && <p className="group-removal-error" role="alert">{fields[name]}</p>;
  return <section className="group-removal-panel" aria-label="Remove inventory group">
    <header><span className="group-removal-icon"><FolderMinus aria-hidden="true" size={25} /></span><div><h2>Remove inventory group{source ? ': ' + source.name : ''}</h2><p>Choose what happens to every item before this group leaves active inventory.</p></div></header>
    {loading && <p role="status">Loading the complete group…</p>}
    {contextError && <p role="alert" className="group-removal-error">{contextError} <button type="button" className="ska-button" onClick={refreshReview}>Refresh removal review</button></p>}
    {error && <p role="alert" className="group-removal-error">{error}</p>}
    {message && <p role="status" className="group-removal-note">{message}</p>}
    {!canWrite && <p className="group-removal-note">Read-only access. You can check an unconfirmed operation’s status. An administrator or editor can remove groups.</p>}
    {!review && canWrite && context && <>
      <div className="group-removal-summary"><strong>{context.itemCount} item records</strong><span>{context.nonzeroCount} with recorded quantities above zero</span></div>
      <details className="group-removal-item-details"><summary>Items currently in {context.source.name} ({context.itemCount})</summary><Members members={context.members} /></details>
      <fieldset disabled={frozen || conflict} className="group-removal-choices"><legend>What should happen to this group?</legend>
        <label><input type="radio" aria-label="Delete empty group" name="remove-action" checked={action === 'delete'} disabled={context.itemCount > 0} onChange={() => { setAction('delete'); change(); }} /><span><strong>Delete empty group</strong><small>{context.itemCount ? 'This group has item records. Choose move or archive.' : 'Remove this empty group. No item records are affected.'}</small></span></label>
        <label><input type="radio" aria-label="Move all items and delete group" name="remove-action" checked={action === 'move'} onChange={() => { setAction('move'); change(); }} /><span><ArrowRightLeft aria-hidden="true" size={18} /><strong>Move all items and delete group</strong><small>Keep every item active in another compatible group. Quantities and locations stay the same.</small></span></label>
        {action === 'move' && <div><label className="group-removal-field">Move items to group<select aria-label="Move items to group" value={targetId} aria-invalid={!!fields.target} onChange={event => { setTargetId(event.target.value); change(); }}><option value="">Choose a compatible group</option>{context.destinations.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>{fieldError('target')}{!context.destinations.length && <p className="group-removal-note">No compatible active group is available. Cancel and create another {context.source.kind === 'food' ? 'food stock' : 'supplies'} group first.</p>}</div>}
        <label><input type="radio" aria-label="Archive group and all items" name="remove-action" checked={action === 'archive'} onChange={() => { setAction('archive'); change(); }} /><span><Archive aria-hidden="true" size={18} /><strong>Archive group and all items</strong><small>Keep their balances and history as read-only records. Exclude them from available stock and current choices.</small></span></label>
        <label className="group-removal-field">Reason<textarea rows={3} maxLength={500} value={reason} aria-invalid={!!fields.reason} onChange={event => { setReason(event.target.value); change(); }} /></label>{fieldError('reason')}
        <p className="group-removal-small">A reason is required when archiving nonzero stock. No quantities are written off.</p>
      </fieldset>
      {fieldError('action')}
      <button type="button" className="ska-button is-primary" disabled={frozen || conflict} onClick={() => void preview()}>{busy ? 'Preparing review…' : 'Review group removal'}</button>
    </>}
    {review && <section className="group-removal-review" aria-label="Review group removal"><h3>Review group removal</h3>
      <dl className="group-removal-facts"><div><dt>Group</dt><dd>{review.source.name}</dd></div><div><dt>Action</dt><dd>{actionLabels[review.action]}</dd></div>{review.target && <div><dt>Move every item to</dt><dd>{review.target.name}</dd></div>}<div><dt>Item records</dt><dd>{review.itemCount}</dd></div><div><dt>Records with remaining stock</dt><dd>{review.nonzeroCount}</dd></div></dl>
      <p className="group-removal-outcome">{review.action === 'delete' ? 'This empty group will leave inventory. No items or earlier history will be removed.' : review.action === 'move' ? `All ${review.itemCount} item records will move to ${review.target?.name}. The source group will leave inventory. Every quantity, unit, storage location and food connection stays unchanged.` : 'This group and every item in it will become read-only archived records. Their quantities stay unchanged and will no longer count as available stock.'}</p>
      <p><strong>Reason:</strong> {review.reason}</p>
      {!!review.totals.length && <p className="group-removal-note"><strong>Recorded totals, kept unchanged:</strong> {review.totals.map(total => total.quantity + ' ' + total.unit).join(' · ')}. Different units are kept separate.</p>}
      <Members members={review.members} />
      {review.action === 'archive' && review.nonzeroCount > 0 && <label className="group-removal-ack"><input type="checkbox" checked={acknowledged} disabled={frozen || !canWrite} onChange={event => { setAcknowledged(event.target.checked); setFields({}); }} />I understand these records will be archived and their recorded quantities will stay unchanged</label>}
      {fieldError('acknowledge')}
      <div className="group-removal-actions">{canWrite && <button type="button" className="ska-button is-primary" disabled={frozen || conflict || (review.action === 'archive' && review.nonzeroCount > 0 && !acknowledged)} onClick={() => void commit()}>{busy ? 'Confirming…' : actionLabels[review.action]}</button>}
        <button type="button" className="ska-button" disabled={frozen || !canWrite} onClick={() => { setReview(null); setAcknowledged(false); setFields({}); setError(''); }}>Back to choices</button></div>
    </section>}
    {conflict && !pending && <div className="group-removal-note"><p>This group, its members or the destination changed. Your choices are kept. Refresh the complete membership before preparing a new review.</p><button type="button" className="ska-button" disabled={busy} onClick={refreshReview}><RefreshCw size={18} aria-hidden="true" />Refresh removal review</button></div>}
    {pending && <section className="group-removal-pending" aria-label="Unconfirmed group removal"><h3>Confirm the result before doing anything else</h3><p>The change may already be saved. Keep this page open. The original request is locked; retrying it cannot repeat the operation.</p><div className="group-removal-actions"><button type="button" className="ska-button is-primary" disabled={busy || !canWrite} onClick={() => void commit()}>Retry same group removal</button><button type="button" className="ska-button" disabled={busy} onClick={() => void checkStatus()}>Check removal status</button></div></section>}
    <button type="button" className="ska-button group-removal-cancel" disabled={frozen} onClick={cancel}>Cancel group removal</button>
  </section>;
}
