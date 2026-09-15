import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

export const inventoryUrl = API_BASE_URL + '/api/inventory';
export const inventoryUnits = ['count', 'g', 'ml', 'oz', 'lb', 'gal', 'box', 'pack'];
export type InventoryItem = {
  id: string; name: string; category: string; location: string; unit: string;
  ingredientId: string | null; quantity: string; reorderThreshold: string; version: number;
  status: 'available' | 'low' | 'out'; createdAt: string; updatedAt: string;
  ingredient: { id: string; name: string; unit: string; archived: boolean } | null;
};
export type InventoryDetails = Pick<InventoryItem, 'name' | 'category' | 'location' | 'unit' | 'ingredientId' | 'reorderThreshold'>;
export type InventoryFilters = { q: string; category: string; location: string; status: string; page: number };
export type InventoryList = {
  items: InventoryItem[]; total: number; page: number; pageSize: number;
  summary: { total: number; available: number; lowStock: number; outOfStock: number };
  options: { categories: string[]; locations: string[] };
};
export type InventorySnapshot = InventoryDetails & Pick<InventoryItem, 'id' | 'quantity' | 'version'>;
export type StockMovement = {
  id: string; type: 'opening' | 'addition' | 'usage' | 'correction' | 'details';
  itemId: string; itemVersion: number; beforeQuantity: string; afterQuantity: string; delta: string;
  reason: string; actorId: string; actorUsername: string; occurredAt: string;
  before: InventorySnapshot | null; after: InventorySnapshot;
};
export type InventoryHistory = { item: InventoryItem; items: StockMovement[]; total: number; page: number; pageSize: number };
export async function saveInventory(previous: InventoryItem | null, values: InventoryDetails & { reason: string; openingQuantity?: string }, requestId: string) {
  const response = previous
    ? await axios.put<{ data: InventoryItem }>(inventoryUrl + '/' + encodeURIComponent(previous.id), { ...values, version: previous.version, requestId })
    : await axios.post<{ data: InventoryItem }>(inventoryUrl, { ...values, requestId });
  return response.data.data;
}
export async function adjustInventory(item: InventoryItem, values: { type: string; quantity: string; reason: string }, requestId: string) {
  return (await axios.post<{ data: InventoryItem }>(inventoryUrl + '/' + encodeURIComponent(item.id) + '/movements', {
    ...values, unit: item.unit, version: item.version, requestId,
  })).data.data;
}
// getRandomValues also works on the existing VM's HTTP development address.
export const inventoryRequestId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, '0')).join('');
