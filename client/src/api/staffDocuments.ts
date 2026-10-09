import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import type { DocumentCategory, DocumentFile, DocumentRevision, DocumentWork } from './childDocuments';
import type { RegistrationForm } from './registrationForms';
import { notifyStaffComplianceChanged } from './staffComplianceEvents';

export type StaffDocumentMetadata = {
  title: string; category: DocumentCategory; documentDate: string | null; notes: string;
  issuer: string; reference: string; issuedOn: string | null; expiresOn: string | null; nonExpiring: boolean;
  warningDays: number | null; registrationFormId: string | null; registrationFormRevisionId: string | null;
};
export type StaffDocument = StaffDocumentMetadata & {
  id: string; staffId: string; version: number; currentRevisionId: string; updatedAt: string;
  reviewedRevisionId: string | null; reviewedAt: string | null; reviewedBy: string | null;
};
export type StaffDocumentRevision = DocumentRevision & Partial<Pick<StaffDocumentMetadata, 'issuedOn' | 'expiresOn' | 'nonExpiring' | 'warningDays' | 'issuer' | 'reference'>>;
export type StaffDocumentDetails = { document: StaffDocument; revisions: StaffDocumentRevision[]; total: number };
export type StaffComplianceStatus = 'missing' | 'needs_review' | 'outdated' | 'expiry_missing' | 'expired' | 'expiring' | 'complete';
export const staffComplianceLabels: Record<StaffComplianceStatus, string> = {
  missing: 'Missing document', needs_review: 'Needs review', outdated: 'Updated form needed', expiry_missing: 'Expiration date needed',
  expired: 'Expired', expiring: 'Renewal due soon', complete: 'Complete',
};
export type StaffRequirement = RegistrationForm & { expirationRequired?: boolean };
export type StaffChecklist = {
  today?: string; timeZone?: string; warningDays?: number;
  items: { form: StaffRequirement; status: StaffComplianceStatus; document: StaffDocument | null;
    expiresOn: string | null; daysRemaining: number | null; nextReminderDate?: string | null; warningDays?: number }[];
  requiredTotal: number; requiredComplete: number; percentage: number; complete: boolean;
};
export type StaffCompliance = {
  items: { staffId: string; employeeName: string; requirementId: string; requirementTitle: string; status: StaffComplianceStatus;
    expiresOn: string | null; daysRemaining: number | null; nextReminderDate?: string | null; warningDays?: number }[];
  totals: Partial<Record<StaffComplianceStatus, number>>; warningDays: number; today: string; timeZone: string; configured: boolean;
  requiredTotal: number; activeStaffTotal: number;
};
export type StaffComplianceResult = StaffCompliance;
export type StaffComplianceSettings = { warningDays: number; version: number };
export type { DocumentWork };
const base = `${API_BASE_URL}/api/staff-compliance`;
const documentsUrl = (staffId: string) => `${API_BASE_URL}/api/staff/${encodeURIComponent(staffId)}/documents`;
const documentUrl = (staffId: string, id: string) => documentsUrl(staffId) + '/' + encodeURIComponent(id);
export async function getStaffCompliance(signal: AbortSignal) {
  return (await axios.get<StaffCompliance>(base, { signal })).data;
}
export async function getStaffComplianceSettings(signal: AbortSignal) {
  return (await axios.get<StaffComplianceSettings>(base + '/settings', { signal })).data;
}
export async function updateStaffComplianceSettings(previous: StaffComplianceSettings, warningDays: number, signal: AbortSignal) {
  const response = await axios.put<StaffComplianceSettings>(base + '/settings', { warningDays, version: previous.version }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function getStaffChecklist(staffId: string, signal: AbortSignal) {
  return (await axios.get<StaffChecklist>(documentsUrl(staffId) + '/checklist', { signal })).data;
}
export async function listStaffDocuments(staffId: string, page: number, signal: AbortSignal) {
  return (await axios.get<{ items: StaffDocument[]; total: number }>(documentsUrl(staffId), { params: { page, pageSize: 10 }, signal })).data;
}
export async function getStaffDocument(staffId: string, id: string, page: number, signal: AbortSignal) {
  return (await axios.get<StaffDocumentDetails>(documentUrl(staffId, id), { params: { page, pageSize: 10 }, signal })).data;
}
export async function addStaffDocument(staffId: string, metadata: StaffDocumentMetadata, file: DocumentFile, requestId: string, signal: AbortSignal) {
  const response = await axios.post<{ document: StaffDocument; revision: StaffDocumentRevision }>(documentsUrl(staffId), { ...metadata, file, requestId }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function updateStaffDocument(staffId: string, document: StaffDocument, metadata: StaffDocumentMetadata, signal: AbortSignal) {
  const response = await axios.put<{ document: StaffDocument }>(documentUrl(staffId, document.id), { ...metadata, version: document.version }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function reviseStaffDocument(staffId: string, document: StaffDocument, metadata: StaffDocumentMetadata, file: DocumentFile, changeNote: string, requestId: string, signal: AbortSignal) {
  const { issuedOn, expiresOn, nonExpiring, warningDays, issuer, reference } = metadata;
  const response = await axios.post<{ document: StaffDocument; revision: StaffDocumentRevision }>(documentUrl(staffId, document.id) + '/revisions', {
    file, changeNote, requestId, version: document.version, issuedOn, expiresOn, nonExpiring, warningDays, issuer, reference,
  }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function reviewStaffDocument(staffId: string, document: StaffDocument, reviewed: boolean, signal: AbortSignal) {
  const response = await axios.put<{ document: StaffDocument }>(documentUrl(staffId, document.id) + '/review', { version: document.version, reviewed }, { signal });
  notifyStaffComplianceChanged(signal); return response.data;
}
export async function getStaffDocumentContent(staffId: string, id: string, revisionId: string, download: boolean, signal: AbortSignal) {
  return (await axios.get<Blob>(documentUrl(staffId, id) + '/revisions/' + encodeURIComponent(revisionId) + '/content', {
    params: download ? { download: 1 } : undefined, responseType: 'blob', signal,
  })).data;
}
