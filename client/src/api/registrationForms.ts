import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { ChildDocument, DocumentCategory, DocumentFile, DocumentRevision } from './childDocuments';
import { notifyStaffComplianceChanged } from './staffComplianceEvents';

export type TemplateAudience = 'child' | 'employee' | 'facility';
export const templateAudiences = { child: 'Children', employee: 'Employees', facility: 'Facility' };
export type RegistrationForm = {
  audience?: TemplateAudience;
  id: string; title: string; instructions: string; category: DocumentCategory; required: boolean;
  expirationRequired?: boolean;
  active: boolean; version: number; currentRevisionId: string | null; templateRevision: number; updatedAt: string;
};
export type RegistrationFormMetadata = Pick<RegistrationForm, 'title' | 'instructions' | 'category' | 'audience' | 'required' | 'expirationRequired'>;
export type RegistrationFormDetails = { form: RegistrationForm; revisions: DocumentRevision[]; total: number };
export type RegistrationChecklistItem = { form: RegistrationForm; status: 'missing' | 'needs_review' | 'complete' | 'outdated'; document: ChildDocument | null };
export type RegistrationChecklist = { items: RegistrationChecklistItem[]; requiredTotal: number; requiredComplete: number; complete: boolean; percentage?: number; missingBasicInfo?: string[] };
const base = `${API_BASE_URL}/api/registration-forms`;
const formUrl = (id: string) => base + '/' + encodeURIComponent(id);
export async function listRegistrationForms(includeArchived: boolean, signal: AbortSignal) {
  return (await axios.get<{ items: RegistrationForm[] }>(base, { params: includeArchived ? { includeArchived: 1 } : undefined, signal })).data;
}
export async function getRegistrationForm(id: string, signal: AbortSignal, page?: number) {
  return (await axios.get<RegistrationFormDetails>(formUrl(id), { params: page === undefined ? undefined : { page, pageSize: 10 }, signal })).data;
}
export async function addRegistrationForm(metadata: RegistrationFormMetadata, file: DocumentFile | undefined, requestId: string, signal: AbortSignal) {
  const response = await axios.post<{ form: RegistrationForm; revision: DocumentRevision | null }>(base, { ...metadata, ...(file ? { file } : {}), requestId }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function updateRegistrationForm(form: RegistrationForm, metadata: RegistrationFormMetadata & Pick<RegistrationForm, 'active'>, signal: AbortSignal) {
  const response = await axios.put<{ form: RegistrationForm }>(formUrl(form.id), { ...metadata, version: form.version }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function reviseRegistrationForm(form: RegistrationForm, file: DocumentFile, changeNote: string, requestId: string, signal: AbortSignal) {
  const response = await axios.post<{ form: RegistrationForm; revision: DocumentRevision }>(formUrl(form.id) + '/revisions', { file, changeNote, requestId, version: form.version }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function getRegistrationFormContent(id: string, revisionId: string, download: boolean, signal: AbortSignal) {
  return (await axios.get<Blob>(formUrl(id) + '/revisions/' + encodeURIComponent(revisionId) + '/content', { params: download ? { download: 1 } : undefined, responseType: 'blob', signal })).data;
}
export async function getRegistrationChecklist(childId: string, signal: AbortSignal) {
  return (await axios.get<RegistrationChecklist>(`${API_BASE_URL}/api/children/${encodeURIComponent(childId)}/documents/checklist`, { signal })).data;
}
