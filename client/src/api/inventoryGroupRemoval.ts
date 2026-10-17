import axios from 'axios';
import { inventoryUrl, type InventoryGroup, type InventorySnapshot } from './inventory';
import { announceInventoryChange } from './inventoryChanges';

export type GroupRemovalAction = 'delete' | 'move' | 'archive';
export type RemovalGroup = Omit<InventoryGroup, 'summary'> & { version: number; archived: boolean; archivedAt: string | null; deletedAt: string | null };
export type RemovalSnapshot = InventorySnapshot & { archived?: boolean; archivedAt?: string | null };
export type GroupRemovalContext = {
  source: RemovalGroup; contextVersion: string; members: RemovalSnapshot[]; destinations: RemovalGroup[];
  itemCount: number; nonzeroCount: number; totals: { unit: string; quantity: string }[];
};
export type GroupRemovalReview = Omit<GroupRemovalContext, 'contextVersion' | 'destinations'> & {
  reviewToken: string; action: GroupRemovalAction; target: RemovalGroup | null; reason: string; expiresAt: string;
};
export type GroupRemovalPreview = { action: GroupRemovalAction; contextVersion: string; targetGroupId?: string; targetVersion?: number; reason?: string };
export type GroupRemovalCommit = { requestId: string; reviewToken: string; acknowledgeRetainedStock: boolean };
export type GroupOperationReceipt = {
  id: string; action: GroupRemovalAction; sourceBefore: RemovalGroup; sourceAfter: RemovalGroup; target: RemovalGroup | null;
  reason: string; itemCount: number; nonzeroCount: number; totals: { unit: string; quantity: string }[];
  members: { before: RemovalSnapshot; after: RemovalSnapshot; movementId: string | null }[];
  actorId: string; actorUsername: string; recordedAt: string;
};
export async function getGroupRemovalContext(groupId: string, signal?: AbortSignal) {
  return (await axios.get<{ data: GroupRemovalContext }>(inventoryUrl + '/groups/' + encodeURIComponent(groupId) + '/removal-context', { signal })).data.data;
}
export async function previewGroupRemoval(groupId: string, values: GroupRemovalPreview, signal?: AbortSignal) {
  return (await axios.post<{ data: GroupRemovalReview }>(inventoryUrl + '/groups/' + encodeURIComponent(groupId) + '/removal-preview', values, { signal })).data.data;
}
export async function commitGroupRemoval(groupId: string, values: GroupRemovalCommit, signal?: AbortSignal) {
  const receipt = (await axios.post<{ data: GroupOperationReceipt & { replayed: boolean } }>(inventoryUrl + '/groups/' + encodeURIComponent(groupId) + '/removal', values, { signal })).data.data;
  announceInventoryChange(); return receipt;
}
export async function getGroupOperation(id: string, signal?: AbortSignal) {
  return (await axios.get<{ data: GroupOperationReceipt }>(inventoryUrl + '/group-operations/' + encodeURIComponent(id), { signal })).data.data;
}
export async function getGroupRemovalByRequest(requestId: string, signal?: AbortSignal) {
  return (await axios.get<{ data: GroupOperationReceipt | null }>(inventoryUrl + '/group-operations/by-request/' + encodeURIComponent(requestId), { signal })).data.data;
}
// An uncertain operation survives the authentication screen in this tab only.
// Actor scoping prevents the next signed-in account from inheriting its details.
const uncertain = new Map<string, { groupId: string; request: GroupRemovalCommit; review: GroupRemovalReview }>();
export const getUnconfirmedGroupRemoval = (actorId: string) => uncertain.get(actorId);
export function rememberUnconfirmedGroupRemoval(actorId: string, value: { groupId: string; request: GroupRemovalCommit; review: GroupRemovalReview }) { uncertain.set(actorId, value); }
export function forgetUnconfirmedGroupRemoval(actorId: string) { uncertain.delete(actorId); }
