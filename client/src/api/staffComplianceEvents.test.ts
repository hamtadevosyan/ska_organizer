import axios from 'axios';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { STAFF_COMPLIANCE_CHANGED } from './staffComplianceEvents';
import { addStaffDocument, reviewStaffDocument, reviseStaffDocument, updateStaffComplianceSettings, updateStaffDocument } from './staffDocuments';
import type { StaffDocument, StaffDocumentMetadata } from './staffDocuments';
import { saveStaff } from './staff';
import type { StaffMember } from './staff';
import { addRegistrationForm, reviseRegistrationForm, updateRegistrationForm } from './registrationForms';
import type { RegistrationForm } from './registrationForms';
vi.mock('axios');
const metadata: StaffDocumentMetadata = { title: 'Synthetic certificate', category: 'other', documentDate: null, notes: 'Confidential note', issuer: 'Confidential issuer', reference: 'Private reference', issuedOn: '2026-01-01', expiresOn: '2027-01-01', nonExpiring: false, warningDays: null, registrationFormId: 'requirement-one', registrationFormRevisionId: null };
const document: StaffDocument = { ...metadata, id: 'document-one', staffId: 'employee-one', version: 1, currentRevisionId: 'revision-one', updatedAt: '2026-10-08T10:00:00Z', reviewedRevisionId: null, reviewedAt: null, reviewedBy: null };
const staff: StaffMember = { id: 'employee-one', name: 'Synthetic Employee', role: 'Teacher', active: true, roomId: null, room: null, version: 1, createdAt: '2026-10-08T10:00:00Z', updatedAt: '2026-10-08T10:00:00Z' };
const form: RegistrationForm = { id: 'requirement-one', audience: 'employee', title: 'Synthetic certificate', category: 'other', instructions: '', required: true, expirationRequired: true, active: true, version: 1, currentRevisionId: null, templateRevision: 0, updatedAt: '2026-10-08T10:00:00Z' };
const file = { name: 'certificate.png', contentType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
const signalled = [
  { name: 'certificate creation', run: (signal: AbortSignal) => addStaffDocument(staff.id, metadata, file, 'request-one', signal) },
  { name: 'certificate metadata correction', run: (signal: AbortSignal) => updateStaffDocument(staff.id, document, metadata, signal) },
  { name: 'certificate renewal', run: (signal: AbortSignal) => reviseStaffDocument(staff.id, document, metadata, file, 'renewal', 'request-one', signal) },
  { name: 'certificate review', run: (signal: AbortSignal) => reviewStaffDocument(staff.id, document, true, signal) },
  { name: 'reminder settings', run: (signal: AbortSignal) => updateStaffComplianceSettings({ warningDays: 40, version: 1 }, 30, signal) },
  { name: 'requirement creation', run: (signal: AbortSignal) => addRegistrationForm(form, undefined, 'request-one', signal) },
  { name: 'requirement archival or metadata', run: (signal: AbortSignal) => updateRegistrationForm(form, { ...form, active: false }, signal) },
  { name: 'requirement template revision', run: (signal: AbortSignal) => reviseRegistrationForm(form, file, 'updated blank', 'request-one', signal) },
];
const operations = [...signalled, { name: 'employee creation', run: () => saveStaff(null, staff) }, { name: 'employee deactivation', run: () => saveStaff(staff, { active: false }) }];
let events: Event[];
const listen = (event: Event) => events.push(event);
beforeEach(() => {
  vi.resetAllMocks(); events = []; window.addEventListener(STAFF_COMPLIANCE_CHANGED, listen);
  vi.mocked(axios.post).mockResolvedValue({ data: { data: staff, document, form, warningDays: 30, version: 2 } });
  vi.mocked(axios.put).mockResolvedValue({ data: { data: staff, document, form, warningDays: 30, version: 2 } });
});
afterEach(() => { window.removeEventListener(STAFF_COMPLIANCE_CHANGED, listen); });

test.each(operations)('$name invalidates authorized reminders exactly once after success with no personnel payload', async ({ run }) => {
  await run(new AbortController().signal); expect(events).toHaveLength(1); expect(events[0].type).toBe(STAFF_COMPLIANCE_CHANGED);
  expect(events[0]).not.toHaveProperty('detail'); expect(JSON.stringify(events[0])).not.toContain(staff.id);
});

test.each(operations)('$name does not emit on failure or cancelled response', async ({ run }) => {
  const failure = new Error('Rejected or cancelled by the API transport');
  vi.mocked(axios.post).mockRejectedValueOnce(failure); vi.mocked(axios.put).mockRejectedValueOnce(failure);
  await expect(run(new AbortController().signal)).rejects.toBe(failure); expect(events).toHaveLength(0);
});

test.each(signalled)('$name ignores a fulfilled response after its caller has aborted', async ({ run }) => {
  const controller = new AbortController(); controller.abort(); await run(controller.signal); expect(events).toHaveLength(0);
});

test('pending certificate upload does not refresh reminders until the server acknowledges it', async () => {
  let acknowledge!: (value: { data: { document: StaffDocument } }) => void;
  vi.mocked(axios.post).mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  const request = addStaffDocument(staff.id, metadata, file, 'request-one', new AbortController().signal);
  expect(events).toHaveLength(0); acknowledge({ data: { document } }); await request; expect(events).toHaveLength(1);
});
