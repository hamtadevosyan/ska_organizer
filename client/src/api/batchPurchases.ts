import axios from 'axios';
import { inventoryUrl, type InventoryItem, type InventoryList, type InventorySnapshot } from './inventory';
import { announceInventoryChange } from './inventoryChanges';

export type BatchRequestLine = {
  itemId: string; version: number; quantity: string; unit: string; totalCost: string | null; purchasingLineId?: string;
};
export type BatchRequest = {
  requestId: string; receivedOn: string; supplier: string | null; reason: string; lines: BatchRequestLine[];
  purchasingRef?: { weekStart: string; version: number };
};
export type PurchasingReceiptReference = { weekStart: string; version: number; stockTakenAt: string; calculationKey: string };
export type BatchLine = {
  itemId: string; name: string; location: string; quantity: string; unit: string; stockUnit: string; stockDelta: string;
  beforeQuantity: string; afterQuantity: string; totalCost: string | null; versionBefore: number; versionAfter: number;
  purchasingLineId: string | null; plannedQuantity: string | null; previouslyReceived: string | null; remainingQuantity: string | null;
  notes: string[]; receiptId?: string; movementId?: string; itemSnapshot?: InventorySnapshot;
};
export type BatchReceipt = {
  id: string; receivedOn: string; supplier: string | null; reason: string; currency: 'USD'; actorId: string;
  actorUsername: string; recordedAt: string; purchasingRef: PurchasingReceiptReference | null; lines: BatchLine[];
};
export type BatchReview = { request: BatchRequest; lines: BatchLine[]; purchasingRef: PurchasingReceiptReference | null };
export type ReceivingHistory = { items: BatchReceipt[]; total: number; page: number; pageSize: number; today: string; timeZone: string };
export type PurchasingFulfillment = {
  weekStart: string; version: number; stockTakenAt: string;
  lines: { id: string; itemId: string | null; name: string; location: string | null; unit: string; buyQuantity: string;
    receivedQuantity: string; remainingQuantity: string; selected: boolean; unavailable?: boolean; availabilityMessage?: string }[];
  batches: { id: string; receivedOn: string; supplier: string | null; recordedAt: string }[]; note: string;
};
const url = inventoryUrl + '/purchase-batches';
export async function getReceivingHistory(page = 1, signal?: AbortSignal) {
  return (await axios.get<ReceivingHistory>(url, { params: { page, pageSize: 10 }, signal })).data;
}
export async function getBatchReceipt(id: string, signal?: AbortSignal) {
  return (await axios.get<{ data: BatchReceipt }>(url + '/' + encodeURIComponent(id), { signal })).data.data;
}
export async function getBatchByRequest(id: string, signal?: AbortSignal) {
  return (await axios.get<{ data: BatchReceipt | null }>(url + '/by-request/' + encodeURIComponent(id), { signal })).data.data;
}
export async function getPurchasingFulfillment(weekStart: string, signal?: AbortSignal) {
  return (await axios.get<{ data: PurchasingFulfillment | null }>(url + '/purchasing/' + encodeURIComponent(weekStart), { signal })).data.data;
}
export async function previewBatchReceipt(payload: BatchRequest, signal?: AbortSignal) {
  return (await axios.post<{ data: BatchReview }>(url + '/preview', payload, { signal })).data.data;
}
export async function recordBatchReceipt(payload: BatchRequest, signal?: AbortSignal) {
  const result = (await axios.post<{ data: { batch: BatchReceipt; replayed: boolean } }>(url, payload, { signal })).data.data;
  announceInventoryChange(); return result;
}
export async function getReceivingItems(signal: AbortSignal) {
  const items: InventoryItem[] = [];
  for (let page = 1; !signal.aborted; page++) {
    const response = (await axios.get<InventoryList>(inventoryUrl, { params: { page, pageSize: 100 }, signal })).data;
    items.push(...response.items);
    if (!response.items.length || items.length >= response.total) break;
  }
  return items;
}
