import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { Account } from '../auth/context';

export type DocumentCategory = 'medical' | 'contract' | 'consent' | 'other';
export const documentCategories: Record<DocumentCategory, string> = { medical: 'Medical record', contract: 'Contract', consent: 'Consent form', other: 'Other' };
export const maxDocumentBytes = 5 * 1024 * 1024;
export type ChildDocument = {
  id: string; childId: string; title: string; category: DocumentCategory; documentDate: string | null;
  notes: string; version: number; currentRevisionId: string; updatedAt: string;
};
export type DocumentRevision = {
  id: string; revision: number; filename: string; contentType: string; byteLength: number;
  sha256: string; uploadedAt: string; uploadedBy: string; changeNote: string | null; current: boolean;
};
export type DocumentFile = { name: string; contentType: string; dataBase64: string };
export type DocumentDetails = { document: ChildDocument; revisions: DocumentRevision[]; total: number };
export type DocumentMetadata = Pick<ChildDocument, 'title' | 'category' | 'documentDate' | 'notes'>;
export type DocumentWork = { dirty: boolean; busy: boolean };
export function documentAccess(account: Account | null): 'none' | 'view' | 'edit' {
  if (!account || account.disabled || account.mustChangePassword) return 'none';
  if (account.role === 'admin') return 'edit';
  const access = account.documentAccess || 'none';
  return account.role === 'viewer' && access === 'edit' ? 'view' : access;
}
export function documentRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
const url = (childId: string) => `${API_BASE_URL}/api/children/${encodeURIComponent(childId)}/documents`;
export async function listChildDocuments(childId: string, page: number, signal: AbortSignal) {
  return (await axios.get<{ items: ChildDocument[]; total: number }>(url(childId), { params: { page, pageSize: 10 }, signal })).data;
}
export async function getChildDocument(childId: string, id: string, page: number, signal: AbortSignal) {
  return (await axios.get<DocumentDetails>(url(childId) + '/' + encodeURIComponent(id), { params: { page, pageSize: 10 }, signal })).data;
}
export async function addChildDocument(childId: string, metadata: DocumentMetadata, file: DocumentFile, requestId: string, signal: AbortSignal) {
  return (await axios.post<{ document: ChildDocument; revision: DocumentRevision }>(url(childId), { ...metadata, file, requestId }, { signal })).data;
}
export async function updateChildDocument(childId: string, document: ChildDocument, metadata: DocumentMetadata, signal: AbortSignal) {
  return (await axios.put<{ document: ChildDocument }>(url(childId) + '/' + encodeURIComponent(document.id), { ...metadata, version: document.version }, { signal })).data;
}
export async function reviseChildDocument(childId: string, document: ChildDocument, file: DocumentFile, changeNote: string, requestId: string, signal: AbortSignal) {
  return (await axios.post<{ document: ChildDocument; revision: DocumentRevision }>(url(childId) + '/' + encodeURIComponent(document.id) + '/revisions', { file, changeNote, requestId, version: document.version }, { signal })).data;
}
export async function getDocumentContent(childId: string, id: string, revisionId: string, download: boolean, signal: AbortSignal) {
  return (await axios.get<Blob>(url(childId) + '/' + encodeURIComponent(id) + '/revisions/' + encodeURIComponent(revisionId) + '/content', {
    params: download ? { download: 1 } : undefined, responseType: 'blob', signal,
  })).data;
}
export function validateDocumentFile(file: File): string {
  if (!file.size) return 'Choose a file that is not empty.';
  if (file.size > maxDocumentBytes) return 'Choose a file of 5 MB or less.';
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const allowed: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  if (!extension || !allowed[extension] || file.type && file.type !== allowed[extension]) return 'Choose a PDF, JPG or PNG file.';
  return '';
}
export function readDocumentFile(file: File, signal: AbortSignal): Promise<DocumentFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cancel = () => { reader.abort(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    reader.onerror = () => { signal.removeEventListener('abort', cancel); reject(new Error('Could not read this file. Choose it again.')); };
    reader.onload = () => {
      signal.removeEventListener('abort', cancel);
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      resolve({ name: file.name, contentType: file.type || (extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : 'image/jpeg'), dataBase64: String(reader.result).split(',')[1] });
    };
    if (signal.aborted) { cancel(); return; }
    reader.readAsDataURL(file);
  });
}
