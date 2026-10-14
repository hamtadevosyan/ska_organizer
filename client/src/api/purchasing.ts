import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

export type PurchasingSource = {
  kind: 'meal' | 'activity' | 'low-stock'; label: string; quantity: string; unit: string;
  roomId?: string; date?: string; reusable?: boolean;
};
export type PurchasingLine = {
  id: string; itemId: string | null; ingredientId: string | null; name: string; unit: string;
  location: string | null; needed: string; inStorage: string; toBuy: string; buyQuantity: string;
  selected: boolean; checked: boolean;
  stockItems: { id: string; name: string; location: string; unit: string; quantity: string; version: number; allocated: string }[];
  sources: PurchasingSource[]; notes: string[];
};
export type PurchasingSelection = {
  includeMeals: boolean; roomIds: string[]; lowStockTargets: { itemId: string; targetQuantity: string }[];
};
export type PurchasingList = PurchasingSelection & {
  weekStart: string; version: number; savedAt: string | null; stockTakenAt: string;
  mealPlan: { version: number; savedAt: string | null } | null;
  activityPlans: { roomId: string; roomName: string; version: number; savedAt: string | null }[];
  lines: PurchasingLine[]; issues: { code: string; message: string; resolution: string; href?: string }[];
};
export type PurchasingOptions = {
  rooms: { id: string; name: string; archived: boolean }[];
  lowStock: { id: string; name: string; location: string; unit: string; quantity: string; reorderThreshold: string; version: number }[];
};
export type PurchasingChoice = Pick<PurchasingLine, 'id' | 'buyQuantity' | 'selected' | 'checked'>;
const url = API_BASE_URL + '/api/purchasing';
export async function getPurchasingOptions(signal?: AbortSignal) {
  return (await axios.get<{ data: PurchasingOptions }>(url + '/options', { signal })).data.data;
}
export async function getPurchasingList(week: string, signal?: AbortSignal) {
  return (await axios.get<{ data: PurchasingList | null }>(url + '/' + encodeURIComponent(week), { signal })).data.data;
}
export async function previewPurchasingList(week: string, selection: PurchasingSelection, signal?: AbortSignal) {
  return (await axios.post<{ data: { list: PurchasingList; token: string } }>(url + '/' + encodeURIComponent(week) + '/preview', selection, { signal })).data.data;
}
export async function savePurchasingList(week: string, values: { version: number; token?: string; choices: PurchasingChoice[] }, signal?: AbortSignal) {
  return (await axios.put<{ data: PurchasingList }>(url + '/' + encodeURIComponent(week), values, { signal })).data.data;
}
// Escape every field, including metadata, with the same protections as Reports.
const csvCell = (value: unknown) => {
  let text = String(value ?? '');
  if (/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text.normalize('NFKC')) || /^[\p{Cc}\p{Cf}]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function purchasingCsv(list: PurchasingList, unsaved = false) {
  const header = ['Week starting', 'Review', 'Stock sampled at', 'Item', 'Location', 'Unit', 'Needed', 'In stock', 'Suggested to buy', 'Buy quantity', 'Checked off', 'Sources', 'Notes'];
  const rows = list.lines.filter(line => line.selected).map(line => [
    list.weekStart, unsaved ? 'Unsaved preview' : 'Saved version ' + list.version, list.stockTakenAt,
    line.name, line.location, line.unit, line.needed, line.inStorage, line.toBuy, line.buyQuantity,
    line.checked ? 'Yes' : 'No', line.sources.map(source => `${source.label}${source.date ? ' · ' + source.date : ''}: ${source.quantity} ${source.unit} (${source.kind}${source.reusable ? ', reusable equipment' : ''})`).join('; '), line.notes.join('; '),
  ]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
