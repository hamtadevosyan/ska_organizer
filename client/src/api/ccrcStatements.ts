import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { BILLING_CHANGED } from './billing';
import type { DocumentFile } from './childDocuments';

export type CcrcPage = { number: number; text: string; method: 'text' | 'ocr' | 'unreadable'; warnings: string[] };
export type CcrcCandidate = { id: string; page: number; excerpt: string; childName: string; childReference?: string; paymentDate?: string | null; paymentReference?: string | null; serviceMonth: string | null; amountCents: number | null; kind: 'payment' | 'adjustment' | 'unknown'; warnings: string[] };
export type CcrcLine = { id: string; page: number; excerpt: string; childId: string; childName: string; serviceMonth: string; amountCents: number | null; action: 'payment' | 'exclude'; note: string; reviewed: boolean; billingVersion: number | null; allowUnappliedCredit: boolean; entryReference: string; paymentDate?: string; paymentReference?: string };
export type CcrcReview = { statementReference: string; paymentReference: string; paymentDate: string; totalCents: number | null; pageCount: number | null; pagesReviewed: number[]; sourceReviewed: boolean; reconciliationReason: string; duplicateReason: string; lines: CcrcLine[] };
export type CcrcStatementSummary = { id: string; version: number; status: 'draft' | 'posted' | 'cancelled'; filename: string; contentType: string; byteLength: number; createdAt: string; updatedAt: string; statementReference?: string; paymentDate?: string; totalCents?: number | null; lineCount: number };
export type CcrcStatement = CcrcStatementSummary & {
  fingerprint: string; today: string; timeZone: string;
  extraction: { pageCount: number | null; pages: CcrcPage[]; statementReference: string | null; paymentReference?: string | null; paymentDate: string | null; totalCents: number | null; lines: CcrcCandidate[]; warnings: string[]; incomplete: boolean };
  review: CcrcReview;
  children: { id: string; name: string; active: boolean; billingVersion: number; charges: { id: string; month: string; settlementMode?: string; amountCents: number; outstandingCents: number }[] }[];
  duplicateWarnings: { kind: 'exact' | 'possible'; statementId: string | null; message: string }[];
  postedPayments: { childId: string; childName: string; paymentId: string; statementLineId: string; page: number; billingVersion: number; serviceMonth: string; amountCents: number; remainingCents: number | null; awaitingCcrc: boolean; allocation: 'applied' | 'partial_credit' | 'unapplied' }[];
  history: { type: string; at: string; actorId: string; reason?: string }[];
};
export type CcrcStatementList = { items: CcrcStatementSummary[]; total: number; today: string; timeZone: string };
const base = API_BASE_URL + '/api/billing/statements';
export async function listCcrcStatements(signal?: AbortSignal) {
  return (await axios.get<{ data: CcrcStatementList }>(base, { signal })).data.data;
}
export async function getCcrcStatement(id: string, signal?: AbortSignal) {
  return (await axios.get<{ data: CcrcStatement }>(base + '/' + encodeURIComponent(id), { signal })).data.data;
}
export async function uploadCcrcStatement(file: DocumentFile, requestId: string, signal?: AbortSignal) {
  return (await axios.post<{ data: CcrcStatement }>(base, { file, requestId }, { signal })).data.data;
}
export async function saveCcrcReview(id: string, body: Record<string, unknown>, signal?: AbortSignal) {
  return (await axios.put<{ data: CcrcStatement }>(base + '/' + encodeURIComponent(id) + '/review', body, { signal })).data.data;
}
export async function postCcrcStatement(id: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const result = (await axios.post<{ data: CcrcStatement }>(base + '/' + encodeURIComponent(id) + '/post', body, { signal })).data.data;
  window.dispatchEvent(new Event(BILLING_CHANGED));
  return result;
}
export async function cancelCcrcStatement(id: string, body: Record<string, unknown>, signal?: AbortSignal) {
  return (await axios.post<{ data: CcrcStatement }>(base + '/' + encodeURIComponent(id) + '/cancel', body, { signal })).data.data;
}
export async function getCcrcStatementContent(id: string, signal?: AbortSignal) {
  return (await axios.get<Blob>(base + '/' + encodeURIComponent(id) + '/content', { responseType: 'blob', signal })).data;
}

export async function reopenCcrcStatement(id: string, body: Record<string, unknown>, signal?: AbortSignal) {
  return (await axios.post<{ data: CcrcStatement }>(base + '/' + encodeURIComponent(id) + '/reopen', body, { signal })).data.data;
}
