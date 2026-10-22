const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { createConnection } = require('../database/connection');
const db = require('../services/dbAdapter');
const vault = require('../services/payrollVault');
let key; beforeAll(() => { key = require('./helpers/payrollKey').install(); }); afterAll(() => key.cleanup());
test('encrypted private profiles, original time, document bytes and immutable calculation snapshots survive a PostgreSQL reconnect', async () => {
  const { schema } = context(); const staffId = randomUUID();
  await db.createStaff({ id: staffId, name: 'Synthetic payroll persistence', role: 'Teacher', active: true, roomId: null, version: 1 });
  const file = Buffer.from('Synthetic private file bytes\u0000\u0001');
  const values = [
    ['profile', { taxId: 'SYNTHETIC-SECRET', rates: [{ cents: 2000, effectiveOn: '2026-01-01' }], history: [{ reason: 'Original rate' }] }],
    ['ledger', { sessions: [{ start: '2026-10-19T15:00:00Z', original: { start: '2026-10-19T14:59:00Z' } }], approvals: { '2026-10-19': { status: 'approved', mode: 'manual-reviewed', paidMillis: 32400000, regularMillis: 32400000, overtimeMillis: 0, doubleMillis: 0, premiumCents: 1250, overtimeReviewed: true, scheduledCreditMillis: 1800000, overtimeFingerprint: 'synthetic-rates-aware-review' } }, workLimits: {'2026-10-19':480}, workWindows: {'2026-10-19':{startTime:'08:00',endTime:'16:00',timeZone:'America/Los_Angeles',effectiveOn:'2026-10-19',sequence:1}}, workReviews: {'2026-10-19':{decision:'worked',reason:'Synthetic review'}} }],
    ['document', { revisions: [{ revision: 1, dataBase64: file.toString('base64') }, { revision: 2, dataBase64: Buffer.from('New synthetic revision').toString('base64') }] }],
    ['snapshot', { preview: { grossCents: 16000, start: '2026-10-19', end: '2026-10-19' }, actorId: 'synthetic-admin' }],
  ];
  const expected = [];
  for (const [kind, data] of values) {
    const row = { id: randomUUID(), staffId, kind, version: 1, createdAt: new Date(), updatedAt: new Date() };
    const stored = { ...row, ciphertext: vault.seal(row, data) }; await db.savePayrollRecord(stored); expected.push({ stored, data });
  }
  const reopened = createConnection(process.env.DATABASE_URL, { schema });
  try {
    const rows = await reopened.query(`SELECT * FROM "${schema}"."PayrollRecords" WHERE "staffId" = :staffId ORDER BY id`, { replacements: { staffId }, type: QueryTypes.SELECT });
    expect(rows).toHaveLength(4);
    for (const { stored, data } of expected) { const row = rows.find(value => value.id === stored.id); expect(row.ciphertext).toBe(stored.ciphertext); expect(vault.open(row)).toEqual(data); expect(row.ciphertext).not.toContain('SYNTHETIC-SECRET'); }
    const document = vault.open(rows.find(row => row.kind === 'document'));
    expect(Buffer.from(document.revisions[0].dataBase64, 'base64')).toEqual(file);
    const row = rows[0]; expect(() => vault.open({ ...row, staffId: 'another-employee' })).toThrow();
    await expect(reopened.query(`DELETE FROM "${schema}"."StaffMembers" WHERE id = :staffId`, { replacements: { staffId } })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  } finally { await reopened.close(); }
});
