import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import InventoryGroupOperation from './InventoryGroupOperation';
import { getGroupOperation, type GroupOperationReceipt } from '../api/inventoryGroupRemoval';
vi.mock('../api/inventoryGroupRemoval', () => ({ getGroupOperation: vi.fn() }));
const group = { id: 'source', name: 'Kitchen', kind: 'food' as const, version: 1, archived: false, archivedAt: null, deletedAt: null, description: '', createdAt: '', updatedAt: '' };
const before = { id: 'flour', name: 'Flour', category: 'Kitchen', groupId: 'source', location: 'Pantry', unit: 'g', ingredientId: null, reorderThreshold: '5', quantity: '20', version: 1 };
const receipt: GroupOperationReceipt = { id: 'operation', action: 'archive', sourceBefore: group, sourceAfter: { ...group, version: 2, archived: true }, target: null, reason: 'Storage retired', itemCount: 1, nonzeroCount: 1,
  totals: [{ unit: 'g', quantity: '20' }], members: [{ before, after: { ...before, version: 2, archived: true }, movementId: 'history' }], actorId: 'admin', actorUsername: 'Administrator', recordedAt: '2026-10-16T12:00:00Z' };
const mount = () => render(<MemoryRouter initialEntries={['/inventory/group-operations/operation']}><Routes><Route path="/inventory/group-operations/:id" element={<InventoryGroupOperation />} /></Routes></MemoryRouter>);
beforeEach(() => vi.mocked(getGroupOperation).mockReset().mockResolvedValue(structuredClone(receipt)));
test('the read-only operation retains quantities, source and actor with no mutation controls', async () => {
  mount(); expect(await screen.findByText('Group and items archived')).toBeInTheDocument();
  expect(screen.getByText('20 → 20 g · Pantry')).toBeInTheDocument(); expect(screen.getByText(/Recorded by Administrator/)).toBeInTheDocument();
  expect(screen.getByText(/did not dispose of stock/)).toBeInTheDocument(); expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(getGroupOperation).toHaveBeenCalledWith('operation', expect.any(AbortSignal));
});
test('failed operation reads can be retried without inventing success', async () => {
  vi.mocked(getGroupOperation).mockRejectedValueOnce(new Error('Offline')); mount(); await screen.findByRole('alert');
  expect(screen.queryByText('Group and items archived')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Retry group operation' }));
  await screen.findByText('Group and items archived'); expect(getGroupOperation).toHaveBeenCalledTimes(2);
});
