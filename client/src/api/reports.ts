import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

export type ReportKind = 'attendance' | 'purchases';
export type ReportFilters = { from: string; to: string; roomId: string };
export type ReportConfig = { today: string; timeZone: string; maxRangeDays: number; rooms: { id: string; name: string; active: boolean }[] };
export type ReportData = {
  kind: ReportKind; title: string; timeZone: string; generatedAt: string; generatedLabel: string;
  filters: { from: string; to: string; roomId: string | null; roomName: string | null };
  columns: { key: string; label: string }[]; rows: Record<string, string>[];
  summary: { label: string; value: string }[]; notes: string[];
};
const url = API_BASE_URL + '/api/reports';
const params = (kind: ReportKind, filters: ReportFilters) => ({ from: filters.from, to: filters.to,
  ...(kind === 'attendance' && filters.roomId ? { roomId: filters.roomId } : {}),
});
export async function reportConfig(signal: AbortSignal) {
  return (await axios.get<ReportConfig>(url + '/config', { signal })).data;
}
export async function readReport(kind: ReportKind, filters: ReportFilters, signal: AbortSignal) {
  return (await axios.get<ReportData>(url + '/' + kind, { params: params(kind, filters), signal })).data;
}
export async function downloadReport(kind: ReportKind, filters: ReportFilters, signal: AbortSignal) {
  try {
    return (await axios.get<Blob>(url + '/' + kind + '.csv', { params: params(kind, filters), signal, responseType: 'blob' })).data;
  } catch (error) {
    // Axios returns error JSON as a Blob too; retain readable validation messages.
    if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
      try { error.response.data = JSON.parse(await error.response.data.text()); } catch { /* Use the normal fallback. */ }
    }
    throw error;
  }
}
export function saveReportDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = objectUrl; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
export function dateRange(preset: 'today' | 'week' | 'month', today: string) {
  let from = today;
  if (preset === 'month') from = today.slice(0, 8) + '01';
  if (preset === 'week') {
    const date = new Date(today + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    from = date.toISOString().slice(0, 10);
  }
  return { from, to: today };
}
