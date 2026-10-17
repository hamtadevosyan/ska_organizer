import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { InventoryGroupRemoval } from './InventoryGroupRemoval';
import { SignedIn } from '../../tests/authFixture';
import { testAccount } from '../../tests/authAccount';
import { UnsavedChangesContext } from '../UnsavedChangesContext';
import { commitGroupRemoval, getGroupRemovalByRequest, getGroupRemovalContext, previewGroupRemoval } from '../../api/inventoryGroupRemoval';
import type { GroupOperationReceipt, GroupRemovalContext, GroupRemovalReview, RemovalGroup, RemovalSnapshot } from '../../api/inventoryGroupRemoval';
vi.mock('../../api/inventoryGroupRemoval', async original => ({ ...await original<typeof import('../../api/inventoryGroupRemoval')>(), getGroupRemovalContext: vi.fn(), previewGroupRemoval: vi.fn(), commitGroupRemoval: vi.fn(), getGroupRemovalByRequest: vi.fn() }));
const report = vi.fn(), saved = vi.fn(), cancel = vi.fn();
let actor = 0, token = 0;
const group = (id: string, name: string): RemovalGroup => ({ id, name, kind: 'supplies', description: '', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', version: 1, archived: false, archivedAt: null, deletedAt: null });
const source = group('art', 'Art supplies'), target = group('materials', 'Materials');
const member = (id = 'paper'): RemovalSnapshot => ({ id, name: id === 'paper' ? 'Colored paper' : 'Stock ' + id, category: source.name, groupId: source.id, location: 'Art shelf', ingredientId: null, unit: 'count', quantity: '3.25', reorderThreshold: '1', version: 1 });
let context: GroupRemovalContext;
const makeContext = (members: RemovalSnapshot[] = []): GroupRemovalContext => ({ source: structuredClone(source), contextVersion: 'context-1', members, destinations: [structuredClone(target)], itemCount: members.length, nonzeroCount: members.length, totals: members.length ? [{ unit: 'count', quantity: '3.25' }] : [] });
function makeReview(action: 'delete' | 'move' | 'archive', reason = 'Inventory groups reorganized'): GroupRemovalReview {
  return { source: structuredClone(context.source), reviewToken: 'signed-review-' + ++token, action, target: action === 'move' ? structuredClone(target) : null,
    members: structuredClone(context.members), itemCount: context.itemCount, nonzeroCount: context.nonzeroCount, totals: structuredClone(context.totals), reason, expiresAt: '2026-10-16T12:10:00Z' };
}
function receipt(review: GroupRemovalReview): GroupOperationReceipt {
  return { id: 'operation-one', action: review.action, sourceBefore: review.source, sourceAfter: { ...review.source, version: 2, ...(review.action === 'archive' ? { archived: true, archivedAt: '2026-10-16T12:00:00Z' } : { deletedAt: '2026-10-16T12:00:00Z' }) },
    target: review.target, reason: review.reason, itemCount: review.itemCount, nonzeroCount: review.nonzeroCount, totals: review.totals,
    members: review.members.map(before => ({ before, after: { ...before, version: before.version + 1 }, movementId: 'movement-' + before.id })), actorId: 'admin', actorUsername: 'admin', recordedAt: '2026-10-16T12:00:00Z' };
}
function mount(role: 'admin' | 'editor' | 'viewer' = 'admin', id = 'group-removal-test-' + ++actor) {
  return render(<SignedIn account={{ ...testAccount, id, role }}><UnsavedChangesContext.Provider value={report}><InventoryGroupRemoval groupId={source.id} onSaved={saved} onCancel={cancel} /></UnsavedChangesContext.Provider></SignedIn>);
}
const errorResponse = (status: number, message: string) => ({ isAxiosError: true, response: { status, data: { error: { message } } } });
async function choose(action: string) { const radio = await screen.findByRole('radio', { name: action }); await waitFor(() => expect(radio).toBeEnabled()); fireEvent.click(radio); }
async function preview() { fireEvent.click(screen.getByRole('button', { name: 'Review group removal' })); return await screen.findByRole('region', { name: 'Review group removal' }); }
async function emptyReview() { await choose('Delete empty group'); return preview(); }
beforeEach(() => {
  vi.clearAllMocks(); context = makeContext();
  vi.mocked(getGroupRemovalContext).mockReset().mockImplementation(async () => structuredClone(context));
  vi.mocked(previewGroupRemoval).mockReset().mockImplementation(async (_groupId, values) => makeReview(values.action, values.reason));
  vi.mocked(commitGroupRemoval).mockReset().mockImplementation(async () => ({ ...receipt(makeReview('delete')), replayed: false }));
  vi.mocked(getGroupRemovalByRequest).mockReset().mockResolvedValue(null);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

test('empty deletion is reviewed before committing, while canceling and Back to choices do not mutate anything', async () => {
  mount(); await choose('Delete empty group'); const review = await preview();
  expect(previewGroupRemoval).toHaveBeenCalledWith(source.id, { action: 'delete', contextVersion: 'context-1' }, expect.any(AbortSignal));
  expect(within(review).getByText('Art supplies')).toBeInTheDocument(); expect(commitGroupRemoval).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Back to choices' })); expect(screen.getByRole('radio', { name: 'Delete empty group' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel group removal' })); expect(cancel).toHaveBeenCalledTimes(1); expect(commitGroupRemoval).not.toHaveBeenCalled();
});

test('a confirmed empty deletion uses only the signed review and explicit acknowledgment flag', async () => {
  mount('editor'); await emptyReview(); const review = await vi.mocked(previewGroupRemoval).mock.results[0].value;
  fireEvent.click(screen.getByRole('button', { name: 'Delete empty group' })); await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(commitGroupRemoval).toHaveBeenCalledWith(source.id, { reviewToken: review.reviewToken, acknowledgeRetainedStock: false, requestId: expect.stringMatching(/^[a-f0-9]{32}$/) }, expect.any(AbortSignal));
  expect(report).toHaveBeenLastCalledWith(false, false);
});

test('moving reviews every item and only compatible explicit destinations, keeping item quantities visible', async () => {
  context = makeContext(Array.from({ length: 61 }, (_, index) => member('item-' + index)));
  mount(); await choose('Move all items and delete group');
  expect(screen.getByRole('radio', { name: 'Delete empty group' })).toBeDisabled();
  const select = screen.getByRole('combobox', { name: 'Move items to group' });
  expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose a compatible group', 'Materials']);
  fireEvent.click(screen.getByRole('button', { name: 'Review group removal' })); expect(select).toHaveAttribute('aria-invalid', 'true'); expect(previewGroupRemoval).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: target.id } }); const review = await preview();
  expect(within(review).getAllByRole('listitem')).toHaveLength(61); expect(within(review).getByText('Stock item-60')).toBeInTheDocument();
  expect(previewGroupRemoval).toHaveBeenCalledWith(source.id, { action: 'move', contextVersion: 'context-1', targetGroupId: target.id, targetVersion: 1 }, expect.any(AbortSignal));
  expect(within(review).getByText(/Every quantity, unit, storage location and food connection stays unchanged/)).toBeInTheDocument();
  expect(commitGroupRemoval).not.toHaveBeenCalled();
});

test('archiving nonzero balances requires a reason and a separate retained-stock acknowledgment', async () => {
  context = makeContext([member()]); mount(); await choose('Archive group and all items');
  fireEvent.click(screen.getByRole('button', { name: 'Review group removal' })); expect(screen.getByLabelText('Reason')).toHaveAttribute('aria-invalid', 'true'); expect(previewGroupRemoval).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'No longer used in the classroom' } }); const review = await preview();
  expect(within(review).getByText('Colored paper')).toBeInTheDocument(); expect(within(review).getByText('3.25 count', { exact: true })).toBeInTheDocument();
  const commit = screen.getByRole('button', { name: 'Archive group and all items' }); expect(commit).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand these records will be archived and their recorded quantities will stay unchanged' }));
  expect(commit).toBeEnabled(); fireEvent.click(commit); await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(commitGroupRemoval).toHaveBeenCalledWith(source.id, expect.objectContaining({ acknowledgeRetainedStock: true }), expect.any(AbortSignal));
});

test('stale membership keeps the action and reason but demands a fresh complete context and new review', async () => {
  context = makeContext([member()]); vi.mocked(previewGroupRemoval).mockRejectedValueOnce(errorResponse(409, 'Group membership changed'));
  mount(); await choose('Archive group and all items'); fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Classroom closed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review group removal' })); await screen.findByText('Group membership changed'); expect(screen.getByRole('button', { name: 'Review group removal' })).toBeDisabled();
  context = { ...makeContext([member(), member('new-item')]), contextVersion: 'context-2' };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh removal review' })); await screen.findByText(/Latest group membership loaded/);
  expect(screen.getByRole('radio', { name: 'Archive group and all items' })).toBeChecked(); expect(screen.getByLabelText('Reason')).toHaveValue('Classroom closed');
  const review = await preview(); expect(within(review).getByText('Stock new-item')).toBeInTheDocument();
  expect(previewGroupRemoval).toHaveBeenLastCalledWith(source.id, { action: 'archive', contextVersion: 'context-2', reason: 'Classroom closed' }, expect.any(AbortSignal)); expect(commitGroupRemoval).not.toHaveBeenCalled();
});

test('a lost commit response freezes the same body and ID across failed retries and a null status check', async () => {
  vi.mocked(commitGroupRemoval).mockRejectedValueOnce(new Error('Lost response')).mockRejectedValueOnce(errorResponse(429, 'Try later'));
  mount(); await emptyReview(); fireEvent.click(screen.getByRole('button', { name: 'Delete empty group' }));
  await screen.findByRole('region', { name: 'Unconfirmed group removal' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same group removal' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Cancel group removal' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Back to choices' })).toBeDisabled(); expect(report).toHaveBeenLastCalledWith(true, true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same group removal' })); await screen.findByText('Try later');
  expect(screen.getByRole('region', { name: 'Unconfirmed group removal' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check removal status' })); await screen.findByText(/No confirmed operation was found yet/);
  expect(screen.getByRole('button', { name: 'Cancel group removal' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry same group removal' })); await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  const calls = vi.mocked(commitGroupRemoval).mock.calls; expect(calls).toHaveLength(3); expect(calls[1].slice(0, 2)).toEqual(calls[0].slice(0, 2)); expect(calls[2].slice(0, 2)).toEqual(calls[0].slice(0, 2));
});

test('an initial authoritative commit conflict preserves choices and requires refresh rather than blind retry', async () => {
  vi.mocked(commitGroupRemoval).mockRejectedValueOnce(errorResponse(409, 'Destination changed'));
  mount(); await emptyReview(); fireEvent.click(screen.getByRole('button', { name: 'Delete empty group' }));
  await screen.findByText('Destination changed'); expect(screen.queryByRole('region', { name: 'Unconfirmed group removal' })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Delete empty group' })).toBeChecked(); expect(screen.getByRole('button', { name: 'Review group removal' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh removal review' })); await screen.findByText(/Latest group membership loaded/); await emptyReview();
  fireEvent.click(screen.getByRole('button', { name: 'Delete empty group' })); await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  const calls = vi.mocked(commitGroupRemoval).mock.calls; expect(calls[1][1].requestId).not.toEqual(calls[0][1].requestId); expect(calls[1][1].reviewToken).not.toEqual(calls[0][1].reviewToken);
});

test('an uncertain request survives same-account auth remount while another account cannot inherit it', async () => {
  vi.mocked(commitGroupRemoval).mockRejectedValueOnce(new Error('Lost response'));
  const first = mount('admin', 'uncertain-actor'); await emptyReview(); fireEvent.click(screen.getByRole('button', { name: 'Delete empty group' }));
  await screen.findByRole('region', { name: 'Unconfirmed group removal' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same group removal' })).toBeEnabled()); first.unmount();
  const other = mount('viewer', 'another-actor'); expect(screen.queryByRole('region', { name: 'Unconfirmed group removal' })).not.toBeInTheDocument(); other.unmount();
  mount('viewer', 'uncertain-actor'); expect(screen.getByRole('region', { name: 'Unconfirmed group removal' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Retry same group removal' })).toBeDisabled(); expect(report).toHaveBeenLastCalledWith(true, true);
  vi.mocked(getGroupRemovalByRequest).mockResolvedValue(receipt(makeReview('delete'))); fireEvent.click(screen.getByRole('button', { name: 'Check removal status' })); await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(commitGroupRemoval).toHaveBeenCalledTimes(1);
});

test('a viewer has no removal choices or writes', async () => {
  mount('viewer'); await waitFor(() => expect(getGroupRemovalContext).toHaveBeenCalled());
  expect(screen.queryByRole('radio')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Review group removal' })).not.toBeInTheDocument(); expect(previewGroupRemoval).not.toHaveBeenCalled(); expect(commitGroupRemoval).not.toHaveBeenCalled();
});

test('busy refs prevent duplicate preview or commit clicks and unknown status keeps the review immutable', async () => {
  let resolvePreview!: (value: GroupRemovalReview) => void;
  vi.mocked(previewGroupRemoval).mockImplementation(() => new Promise(resolve => { resolvePreview = resolve; }));
  mount(); await choose('Delete empty group'); fireEvent.click(screen.getByRole('button', { name: 'Review group removal' })); fireEvent.click(screen.getByRole('button', { name: 'Preparing review…' })); expect(previewGroupRemoval).toHaveBeenCalledTimes(1);
  await act(async () => resolvePreview(makeReview('delete')));
  let resolveCommit!: (value: GroupOperationReceipt & { replayed: boolean }) => void;
  vi.mocked(commitGroupRemoval).mockImplementation(() => new Promise(resolve => { resolveCommit = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete empty group' })); fireEvent.click(screen.getByRole('button', { name: 'Confirming…' })); expect(commitGroupRemoval).toHaveBeenCalledTimes(1);
  await act(async () => resolveCommit({ ...receipt(makeReview('delete')), replayed: false })); expect(saved).toHaveBeenCalledTimes(1);
});
