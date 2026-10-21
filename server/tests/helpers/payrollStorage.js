const { randomUUID } = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path');
const db = require('../../services/dbAdapter'); const vault = require('../../services/payrollVault');
exports.savePayrollStorage = async actor => {
  const staff = await db.createStaff({ id: randomUUID(), name: 'Synthetic payroll archive employee', role: 'Teacher', active: true, roomId: null, version: 1 });
  const bytes = fs.readFileSync(path.join(__dirname, '../fixtures/child-documents/synthetic.png'));
  const data = {
    profile: { taxId: 'SYNTHETIC-ARCHIVE-1234', bankAccount: 'SYNTHETIC-5678', rates: [{ cents: 2000, effectiveOn: '2026-01-01' }, { cents: 2500, effectiveOn: '2026-10-01' }], history: [{ actorId: actor.id, reason: 'Synthetic rate correction' }] },
    ledger: { timeZone: 'America/Los_Angeles', sessions: [{ start: '2026-10-19T15:00:00Z', end: '2026-10-19T23:00:00Z', original: { start: '2026-10-19T14:59:00Z' }, breaks: [] }], approvals: { '2026-10-19': { status: 'approved', regularMillis: 28800000, actorId: actor.id } }, history: [{ type: 'correction', reason: 'Synthetic correction', actorId: actor.id }] },
    document: { revisions: [{ revision: 1, dataBase64: bytes.toString('base64'), actorId: actor.id }, { revision: 2, dataBase64: bytes.toString('base64'), actorId: actor.id }] },
    snapshot: { preview: { start: '2026-10-19', end: '2026-10-19', grossCents: 20000 }, actorId: actor.id },
  };
  for (const [kind, value] of Object.entries(data)) { const row = { id: kind + ':' + staff.id, staffId: staff.id, kind, version: 2, createdAt: new Date(), updatedAt: new Date() }; await db.savePayrollRecord({ ...row, ciphertext: vault.seal(row, value) }); }
};
exports.payrollStorageSnapshot = async () => {
  const first = await db.firstPayrollRecord(); if (!first) throw new Error('Synthetic payroll archive fixture is missing.');
  const rows = await db.listPayrollRecords(first.staffId); if (rows.length !== 4) throw new Error('Synthetic payroll archive records are incomplete.');
  return rows.map(row => ({ ...row, decrypted: vault.open(row) }));
};
