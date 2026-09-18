import axios from 'axios';
import { announceInventoryChange } from './inventoryChanges';
import { API_BASE_URL } from '../lib/api';

export const inventoryUrl = API_BASE_URL + '/api/inventory';
export const foodUnits = ['count', 'g', 'ml', 'oz', 'lb', 'gal'];
export const compatibleStockUnits = (from: string, to: string) => from === to
  || (['g', 'oz', 'lb'].includes(from) && ['g', 'oz', 'lb'].includes(to))
  || (['ml', 'gal'].includes(from) && ['ml', 'gal'].includes(to));
export const inventoryUnits = ['count', 'g', 'ml', 'oz', 'lb', 'gal', 'box', 'pack'];
export type InventoryGroup = {
  id: string; name: string; kind: 'food' | 'supplies'; description: string; createdAt: string; updatedAt: string;
  summary: { total: number; available: number; lowStock: number; outOfStock: number };
};
export type InventoryItem = {
  id: string; name: string; category: string; location: string; unit: string;
  groupId: string; group: Omit<InventoryGroup, 'summary'>;
  ingredientId: string | null; quantity: string; reorderThreshold: string; version: number;
  status: 'available' | 'low' | 'out'; createdAt: string; updatedAt: string;
  ingredient: { id: string; name: string; unit: string; archived: boolean } | null;
};
export type InventoryDetails = Pick<InventoryItem, 'name' | 'groupId' | 'location' | 'unit' | 'ingredientId' | 'reorderThreshold'>;
export type InventoryFilters = { q: string; groupId: string; location: string; status: string; page: number };
export type InventoryList = {
  items: InventoryItem[]; total: number; page: number; pageSize: number;
  summary: { total: number; available: number; lowStock: number; outOfStock: number };
  options: { categories: string[]; locations: string[] };
};
export type InventorySnapshot = Omit<InventoryDetails, 'groupId'> & Pick<InventoryItem, 'id' | 'category' | 'quantity' | 'version'> & { groupId?: string };
export type StockMovement = {
  id: string; type: 'opening' | 'addition' | 'usage' | 'correction' | 'details';
  itemId: string; itemVersion: number; beforeQuantity: string; afterQuantity: string; delta: string;
  reason: string; actorId: string; actorUsername: string; occurredAt: string;
  before: InventorySnapshot | null; after: InventorySnapshot;
};
export type InventoryHistory = { item: InventoryItem; items: StockMovement[]; total: number; page: number; pageSize: number };
export type PurchaseReceipt = {
  id: string; itemId: string; movementId: string; quantity: string; unit: string; receivedOn: string;
  supplier: string | null; totalCost: string | null; currency: 'USD'; itemSnapshot: InventorySnapshot;
  actorId: string; actorUsername: string; recordedAt: string;
};
export type PurchaseList = { items: PurchaseReceipt[]; total: number; page: number; pageSize: number; today: string; timeZone: string };
export type PurchaseDetails = { quantity: string; receivedOn: string; supplier: string; totalCost: string | null; reason: string };
export async function receivePurchase(item: InventoryItem, values: PurchaseDetails, requestId: string) {
  const result = (await axios.post<{ data: { receipt: PurchaseReceipt; item: InventoryItem; replayed: boolean } }>(
    inventoryUrl + '/' + encodeURIComponent(item.id) + '/purchases', { ...values, unit: item.unit, version: item.version, requestId },
  )).data.data;
  announceInventoryChange(); return result;
}
export async function saveInventory(previous: InventoryItem | null, values: InventoryDetails & { reason: string; openingQuantity?: string; newIngredient?: { name: string; unit: string } }, requestId: string) {
  const response = previous
    ? await axios.put<{ data: InventoryItem }>(inventoryUrl + '/' + encodeURIComponent(previous.id), { ...values, version: previous.version, requestId })
    : await axios.post<{ data: InventoryItem }>(inventoryUrl, { ...values, requestId });
  announceInventoryChange(); return response.data.data;
}
export async function adjustInventory(item: InventoryItem, values: { type: string; quantity: string; reason: string }, requestId: string) {
  const result = (await axios.post<{ data: InventoryItem }>(inventoryUrl + '/' + encodeURIComponent(item.id) + '/movements', {
    ...values, unit: item.unit, version: item.version, requestId,
  })).data.data;
  announceInventoryChange(); return result;
}
// getRandomValues also works on the existing VM's HTTP development address.
export const inventoryRequestId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, '0')).join('');
