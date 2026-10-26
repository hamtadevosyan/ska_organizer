const math = require('../services/billingMath');

test.each([['2026-02', 31, '2026-02-28'], ['2028-02', 31, '2028-02-29'], ['2026-04', 31, '2026-04-30'], ['2026-12', 1, '2026-12-01']])('monthly due dates clamp only to the last actual day: %s', (month, day, expected) => {
  expect(math.dueDate(month, day)).toBe(expected);
});
test.each([['2026-03-07', '2026-03-12'], ['2026-10-31', '2026-11-05'], ['2026-12-29', '2027-01-03'], ['2028-02-27', '2028-03-03']])('five calendar days remain five across boundaries: %s', (start, end) => {
  expect(math.daysBetween(start, end)).toBe(5);
});
test.each([-1, 1.1, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER])('currency rejects invalid or unsafe values: %s', value => {
  expect(() => math.cents(value, 'amount')).toThrow();
});
test('partial payments and reversals do not mix family and CCRC responsibility or lose cents', () => {
  const charge = { id: 'tuition', payers: { family: { amountCents: 10001, dueDate: '2026-10-01' }, ccrc: { amountCents: 19999, dueDate: '2026-11-15' } }, adjustments: [] };
  const payment = { id: 'receipt', payer: 'family', amountCents: 5010, reversed: false, allocations: [{ chargeId: 'tuition', amountCents: 5001 }] };
  const view = math.chargeView(charge, [payment], '2026-10-06');
  expect(view).toMatchObject({ amountCents: 30000, paidCents: 5001, outstandingCents: 24999, status: 'partial',
    payers: { family: { outstandingCents: 5000, overdue: true }, ccrc: { outstandingCents: 19999, overdue: false } } });
  expect(math.totals([view], [math.paymentView(payment)])).toMatchObject({ chargedCents: 30000, paidCents: 5001, receivedCents: 5010, creditCents: 9, familyCreditCents: 9, ccrcCreditCents: 0, overdueCents: 5000 });
  payment.reversed = true;
  expect(math.chargeView(charge, [payment], '2026-10-06')).toMatchObject({ paidCents: 0, outstandingCents: 30000 });
  expect(math.paymentView(payment)).toMatchObject({ allocatedCents: 0, creditCents: 0 });
});
test('an adjustment retains original amounts and resolves a five-day alert without changing payments', () => {
  const charge = { id: 'registration', payers: { family: { amountCents: 20000, dueDate: '2026-10-01' }, ccrc: { amountCents: 0, dueDate: '2026-10-01' } }, adjustments: [{ payer: 'family', amountCents: -20000, reason: 'Waived' }] };
  expect(math.chargeView(charge, [], '2026-10-06')).toMatchObject({ amountCents: 0, outstandingCents: 0, status: 'waived', payers: { family: { overdue: false } } });
  expect(charge.payers.family.amountCents).toBe(20000);
});

test('a pending service month keeps every cent in the ledger without asserting a fixed subsidy or overdue parent debt', () => {
  const charge = { id: 'monthly:2026-10', settlementMode: 'ccrc_actual', tuitionCents: 100001, ccrcReview: null, adjustments: [] };
  const payments = [
    { id: 'ccrc-receipt', payer: 'ccrc', amountCents: 75049, serviceChargeId: charge.id, serviceMonth: '2026-10', allocations: [{ chargeId: charge.id, amountCents: 75049 }] },
    { id: 'parent-receipt', payer: 'family', amountCents: 19001, allocations: [{ chargeId: charge.id, amountCents: 19001 }] },
  ];
  const pending = math.chargeView(charge, payments, '2026-12-31');
  expect(pending).toMatchObject({ status: 'awaiting_ccrc', paidCents: 94050, outstandingCents: 5951, ccrcReceivedCents: 75049, ccrcUnappliedCents: 0, payers: { family: { dueDate: null, overdue: false }, ccrc: { outstandingCents: 0 } } });
  expect(math.totals([pending], payments.map(math.paymentView))).toMatchObject({ chargedCents: 100001, receivedCents: 94050, outstandingCents: 5951, awaitingCcrcCents: 5951, awaitingCcrcCount: 1, familyOutstandingCents: 0, ccrcOutstandingCents: 0, overdueCents: 0 });
  const settled = math.chargeView({ ...charge, ccrcReview: { familyDueDate: '2026-12-26' } }, payments, '2026-12-31');
  expect(settled).toMatchObject({ status: 'partial', payers: { family: { outstandingCents: 5951, daysOverdue: 5, overdue: true } } });
});
