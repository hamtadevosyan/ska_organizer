const time = require('./facilityTime');
const { problem } = require('../auth/service');
const payers = ['family', 'ccrc'];
const invalid = (message, field = 'billing') => Object.assign(problem(message, 400, 'BILLING_INVALID'), { fields: { [field]: message } });
function cents(value, field, signed = false) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1000000000 || (!signed && value < 0)) throw invalid('Enter a valid amount with no more than two decimal places.', field);
  return value;
}
function month(value, field = 'month') {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '9998-12') throw invalid('Choose a valid billing month.', field);
  return value;
}
function nextMonth(value) {
  const [year, number] = month(value).split('-').map(Number);
  return String(number === 12 ? year + 1 : year).padStart(4, '0') + '-' + String(number === 12 ? 1 : number + 1).padStart(2, '0');
}
function dueDate(period, day) {
  const first = nextMonth(period) + '-01';
  const last = time.addDays(first, -1);
  return period + '-' + String(Math.min(day, Number(last.slice(-2)))).padStart(2, '0');
}
function daysBetween(first, last) { return Math.floor((Date.parse(last + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / 86400000); }
function applied(charge, payments, payer) {
  return payments.filter(row => !row.reversed && row.payer === payer).reduce((sum, row) => sum + row.allocations.filter(a => a.chargeId === charge.id).reduce((total, a) => total + a.amountCents, 0), 0);
}
function chargeView(charge, payments, today) {
  if (charge.settlementMode === 'ccrc_actual') {
    const amountCents = charge.tuitionCents + (charge.adjustments || []).reduce((sum, row) => sum + row.amountCents, 0);
    const familyPaid = applied(charge, payments, 'family'), ccrcPaid = applied(charge, payments, 'ccrc');
    const paidCents = familyPaid + ccrcPaid, outstandingCents = amountCents - paidCents;
    if (![amountCents, paidCents, outstandingCents].every(Number.isSafeInteger) || outstandingCents < 0) throw new Error('Invalid billing arithmetic.');
    const pendingCcrc = !charge.ccrcReview;
    const ccrcReceipts = payments.filter(row => !row.reversed && row.payer === 'ccrc');
    const ccrcReceivedCents = ccrcReceipts.reduce((sum, row) => sum + (row.serviceChargeId === charge.id ? row.amountCents : !row.serviceChargeId ? row.allocations.filter(value => value.chargeId === charge.id).reduce((total, value) => total + value.amountCents, 0) : 0), 0);
    const ccrcUnappliedCents = ccrcReceipts.filter(row => row.serviceChargeId === charge.id).reduce((sum, row) => sum + paymentView(row).creditCents, 0);
    const dueDate = charge.ccrcReview?.familyDueDate || null;
    const daysOverdue = dueDate ? Math.max(0, daysBetween(dueDate, today)) : 0;
    return { ...charge, pendingCcrc, ccrcReceivedCents, ccrcUnappliedCents, amountCents, paidCents, outstandingCents,
      allocationCapacityCents: { family: outstandingCents, ccrc: outstandingCents },
      payers: {
        family: { amountCents: amountCents - ccrcPaid, paidCents: familyPaid, outstandingCents, dueDate, daysOverdue, overdue: !pendingCcrc && outstandingCents > 0 && daysOverdue >= 5 },
        ccrc: { amountCents: ccrcPaid, paidCents: ccrcPaid, outstandingCents: 0, dueDate: null, daysOverdue: 0, overdue: false },
      }, status: pendingCcrc ? 'awaiting_ccrc' : amountCents === 0 ? 'waived' : outstandingCents === 0 ? 'paid' : paidCents > 0 ? 'partial' : 'unpaid' };
  }
  const result = { ...charge, payers: {}, amountCents: 0, paidCents: 0, outstandingCents: 0 };
  for (const payer of payers) {
    const changes = (charge.adjustments || []).filter(row => row.payer === payer);
    const amountCents = charge.payers[payer].amountCents + changes.reduce((sum, row) => sum + row.amountCents, 0);
    const paidCents = applied(charge, payments, payer);
    const date = changes.filter(row => row.dueDate).at(-1)?.dueDate || charge.payers[payer].dueDate;
    const outstandingCents = amountCents - paidCents;
    const daysOverdue = Math.max(0, daysBetween(date, today));
    result.payers[payer] = { amountCents, paidCents, outstandingCents, dueDate: date, daysOverdue, overdue: outstandingCents > 0 && daysOverdue >= 5 };
    result.amountCents += amountCents; result.paidCents += paidCents; result.outstandingCents += outstandingCents;
  }
  result.status = result.amountCents === 0 ? 'waived' : result.outstandingCents === 0 ? 'paid' : result.paidCents > 0 ? 'partial' : 'unpaid';
  result.allocationCapacityCents = Object.fromEntries(payers.map(payer => [payer, result.payers[payer].outstandingCents]));
  return result;
}
function paymentView(payment) {
  const allocatedCents = payment.reversed ? 0 : payment.allocations.reduce((sum, row) => sum + row.amountCents, 0);
  return { ...payment, allocatedCents, creditCents: payment.reversed ? 0 : payment.amountCents - allocatedCents };
}
const emptyTotals = () => ({ chargedCents: 0, paidCents: 0, receivedCents: 0, outstandingCents: 0, creditCents: 0, familyOutstandingCents: 0, ccrcOutstandingCents: 0, familyCreditCents: 0, ccrcCreditCents: 0, overdueCents: 0, awaitingCcrcCents: 0, awaitingCcrcCount: 0 });
function totals(charges, payments) {
  const value = emptyTotals();
  for (const row of charges) {
    value.chargedCents += row.amountCents; value.paidCents += row.paidCents; value.outstandingCents += row.outstandingCents;
    if (row.pendingCcrc) { value.awaitingCcrcCents += row.outstandingCents; value.awaitingCcrcCount++; }
    for (const payer of payers) {
      if (!(row.pendingCcrc && payer === 'family')) value[payer + 'OutstandingCents'] += row.payers[payer].outstandingCents;
      if (row.payers[payer].overdue) value.overdueCents += row.payers[payer].outstandingCents;
    }
  }
  for (const row of payments) {
    if (!row.reversed) value.receivedCents += row.amountCents;
    value.creditCents += row.creditCents; value[row.payer + 'CreditCents'] += row.creditCents;
  }
  if (Object.values(value).some(amount => !Number.isSafeInteger(amount) || amount < 0)) throw new Error('Invalid billing arithmetic.');
  return value;
}
module.exports = { invalid, cents, month, nextMonth, dueDate, daysBetween, chargeView, paymentView, totals, emptyTotals, payers };
