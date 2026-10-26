const { randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const fixture = require('./helpers/authenticatedRequest');

async function child(id = randomUUID()) {
  return db.createChild({ id, firstName: 'Synthetic', lastName: 'Billing child', dateOfBirth: '2022-05-06',
    active: true, roomId: null, preferredName: '', notes: '' });
}
const data = () => ({ profile: { billingStart: '2026-10-01', rates: [{ familyCents: 125099, ccrcCents: 24901 }] },
  charges: [{ id: 'tuition-2026-10', dueDate: '2026-10-01', familyCents: 125099, ccrcCents: 24901 }],
  payments: [{ id: 'payment-a', amountCents: 25001, reference: 'Synthetic receipt', allocations: [{ chargeId: 'tuition-2026-10', cents: 25001 }] }],
  history: [{ action: 'payment', reason: 'Synthetic statement entry' }], requests: [{ id: 'request-a', result: 'payment-a' }] });

test('billing snapshots preserve exact integer cents and nested history without leaking mutable storage references', async () => {
  const owner = await child();
  expect(await db.getChildBillingRecord(owner.id)).toBeNull();
  const input = data(), saved = await db.saveChildBillingRecord({ childId: owner.id, data: input, version: 1 });
  expect(saved).toMatchObject({ childId: owner.id, data: data(), version: 1 });
  input.payments[0].amountCents = 999999;
  saved.data.history[0].reason = 'Changed returned copy';
  const reopened = await db.getChildBillingRecord(owner.id);
  expect(reopened.data).toEqual(data());
  reopened.data.charges[0].familyCents = 1;
  expect((await db.getChildBillingRecord(owner.id)).data).toEqual(data());
});

test('billing compare-and-swap serializes concurrent first creation and rejects stale updates', async () => {
  const owner = await child();
  const outcomes = await Promise.allSettled([
    db.saveChildBillingRecord({ childId: owner.id, data: data(), version: 1 }),
    db.saveChildBillingRecord({ childId: owner.id, data: { winner: 'second' }, version: 1 }),
  ]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(result => result.status === 'rejected').reason).toMatchObject({ status: 409, code: 'BILLING_CONFLICT' });
  const first = await db.getChildBillingRecord(owner.id);
  const changed = await db.saveChildBillingRecord({ childId: owner.id, data: data(), version: 2, createdAt: '1900-01-01T00:00:00Z' }, 1);
  expect(changed.createdAt).toEqual(first.createdAt);
  await expect(db.saveChildBillingRecord({ childId: owner.id, data: {}, version: 2 }, 1)).rejects.toMatchObject({ status: 409, code: 'BILLING_CONFLICT' });
  expect(await db.getChildBillingRecord(owner.id)).toEqual(changed);
});

test('an outer audit transaction rolls back both new and existing child billing snapshots', async () => {
  const first = await child(), second = await child();
  const initial = await db.saveChildBillingRecord({ childId: first.id, data: data(), version: 1 });
  const beforeAudit = await db.listAudit({ actions: ['billing.synthetic'] });
  await expect(db.withAuthLock(async () => {
    await db.saveChildBillingRecord({ childId: first.id, data: { changed: true }, version: 2 });
    await db.saveChildBillingRecord({ childId: second.id, data: { new: true }, version: 1 });
    await db.appendAudit({ id: randomUUID(), actorId: fixture.credentials().account.id, actorUsername: 'Synthetic administrator',
      action: 'billing.synthetic', entityId: first.id, occurredAt: new Date() });
    throw new Error('Synthetic audited billing rollback');
  })).rejects.toThrow('Synthetic audited billing rollback');
  expect(await db.getChildBillingRecord(first.id)).toEqual(initial);
  expect(await db.getChildBillingRecord(second.id)).toBeNull();
  expect(await db.listAudit({ actions: ['billing.synthetic'] })).toEqual(beforeAudit);
});

test('billing scans include all children in stable ID order and preserve inactive child history', async () => {
  for (let index = 50; index >= 0; index--) {
    const owner = await child('billing-child-' + String(index).padStart(3, '0'));
    await db.saveChildBillingRecord({ childId: owner.id, data: { amountCents: index + 1 }, version: 1 });
  }
  await db.updateChild('billing-child-000', { active: false });
  const rows = await db.listChildBillingRecords();
  expect(rows).toHaveLength(51);
  expect(rows.map(row => row.childId)).toEqual(Array.from({ length: 51 }, (_, index) => 'billing-child-' + String(index).padStart(3, '0')));
  rows[0].data.amountCents = -1;
  expect((await db.getChildBillingRecord('billing-child-000')).data).toEqual({ amountCents: 1 });
  await expect(db.deleteChild('billing-child-000')).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
});

test('storage refuses missing children, non-object ledgers and invalid revision sequences', async () => {
  await expect(db.saveChildBillingRecord({ childId: 'missing-' + randomUUID(), data: {}, version: 1 })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  const owner = await child();
  for (const candidate of [
    { childId: owner.id, data: null, version: 1 }, { childId: owner.id, data: [], version: 1 },
    { childId: owner.id, data: {}, version: 0 }, { childId: owner.id, data: {}, version: 1.5 },
    { childId: owner.id, data: {}, version: 2147483648 },
  ]) await expect(db.saveChildBillingRecord(candidate)).rejects.toMatchObject({ status: 400 });
  await expect(db.saveChildBillingRecord({ childId: owner.id, data: {}, version: 2 }, 0)).rejects.toMatchObject({ status: 400 });
  expect(await db.getChildBillingRecord(owner.id)).toBeNull();
});
