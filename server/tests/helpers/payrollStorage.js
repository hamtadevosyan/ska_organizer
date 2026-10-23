const { randomUUID } = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path');
const db = require('../../services/dbAdapter'); const vault = require('../../services/payrollVault');
exports.savePayrollStorage = async actor => {
  const staff = await db.createStaff({ id: randomUUID(), name: 'Synthetic payroll archive employee', role: 'Teacher', active: true, roomId: null, version: 1 });
  const bytes = fs.readFileSync(path.join(__dirname, '../fixtures/child-documents/synthetic.png'));
  const data = {
    profile: { taxId: 'SYNTHETIC-ARCHIVE-1234', bankAccount: 'SYNTHETIC-5678', rates: [{ cents: 2000, effectiveOn: '2026-01-01' }, { cents: 2500, effectiveOn: '2026-10-01' }], history: [{ actorId: actor.id, reason: 'Synthetic rate correction' }] },
    ledger: { timeZone: 'America/Los_Angeles', sessions: [{ start: '2026-10-19T15:00:00Z', end: '2026-10-19T23:30:00Z', original: { start: '2026-10-19T14:59:00Z' }, breaks: [] }], approvals: { '2026-10-19': { status: 'approved', mode: 'manual-reviewed', paidMillis: 32400000, regularMillis: 32400000, overtimeMillis: 0, doubleMillis: 0, premiumCents: 1250, overtimeReviewed: true, scheduledCreditMillis: 1800000, overtimeFingerprint: 'synthetic-rates-aware-review', actorId: actor.id } }, history: [{ type: 'correction', reason: 'Synthetic correction', actorId: actor.id }], workLimits: {'2026-10-19':540}, workWindows: {'2026-10-19':{startTime:'08:00',endTime:'17:00',timeZone:'America/Los_Angeles',effectiveOn:'2026-10-19',sequence:1}}, workReviews: {'2026-10-19':{decision:'worked',reason:'Synthetic extra-time decision',actorId:actor.id}} },
    workSchedule: {fallbackMinutes:480,entries:[{effectiveOn:'2026-10-19',minutes:540,startTime:'08:00',endTime:'17:00',timeZone:'America/Los_Angeles',sequence:1,reason:'Synthetic daily schedule',actorId:actor.id}]},
    document: { revisions: [{ revision: 1, dataBase64: bytes.toString('base64'), actorId: actor.id }, { revision: 2, dataBase64: bytes.toString('base64'), actorId: actor.id }] },
    snapshot: { preview: { start: '2026-10-19', end: '2026-10-19', grossCents: 20000 }, actorId: actor.id },
  };
  for (const [kind, value] of Object.entries(data)) { const row = { id: (kind === 'workSchedule' ? 'profile:work-schedule:' : kind + ':') + staff.id, staffId: staff.id, kind: kind === 'workSchedule' ? 'profile' : kind, version: 2, createdAt: new Date(), updatedAt: new Date() }; await db.savePayrollRecord({ ...row, ciphertext: vault.seal(row, value) }); }
};
exports.payrollStorageSnapshot = async () => {
  const first = await db.firstPayrollRecord(); if (!first) throw new Error('Synthetic payroll archive fixture is missing.');
  const rows = await db.listPayrollRecords(first.staffId); if (rows.length !== 5) throw new Error('Synthetic payroll archive records are incomplete.');
  return rows.map(row => ({ ...row, decrypted: vault.open(row) }));
};
