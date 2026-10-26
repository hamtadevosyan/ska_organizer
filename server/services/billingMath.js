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
function chargeView(charge, payments, today) {
  const result = { ...charge, payers: {}, amountCents: 0, paidCents: 0, outstandingCents: 0 };
  for (const payer of payers) {
    const changes = (charge.adjustments || []).filter(row => row.payer === payer);
    const amountCents = charge.payers[payer].amountCents + changes.reduce((sum, row) => sum + row.amountCents, 0);
    const paidCents = payments.filter(row => !row.reversed && row.payer === payer).reduce((sum, row) => sum + row.allocations.filter(a => a.chargeId === charge.id).reduce((total, a) => total + a.amountCents, 0), 0);
    const date = changes.filter(row => row.dueDate).at(-1)?.dueDate || charge.payers[payer].dueDate;
    const outstandingCents = amountCents - paidCents;
    const daysOverdue = Math.max(0, daysBetween(date, today));
    result.payers[payer] = { amountCents, paidCents, outstandingCents, dueDate: date, daysOverdue, overdue: outstandingCents > 0 && daysOverdue >= 5 };
    result.amountCents += amountCents; result.paidCents += paidCents; result.outstandingCents += outstandingCents;
  }
  result.status = result.amountCents === 0 ? 'waived' : result.outstandingCents === 0 ? 'paid' : result.paidCents > 0 ? 'partial' : 'unpaid';
  return result;
}
function paymentView(payment) {
  const allocatedCents = payment.reversed ? 0 : payment.allocations.reduce((sum, row) => sum + row.amountCents, 0);
  return { ...payment, allocatedCents, creditCents: payment.reversed ? 0 : payment.amountCents - allocatedCents };
}
const emptyTotals = () => ({ chargedCents: 0, paidCents: 0, receivedCents: 0, outstandingCents: 0, creditCents: 0, familyOutstandingCents: 0, ccrcOutstandingCents: 0, familyCreditCents: 0, ccrcCreditCents: 0, overdueCents: 0 });
function totals(charges, payments) {
  const value = emptyTotals();
  for (const row of charges) {
    value.chargedCents += row.amountCents; value.paidCents += row.paidCents; value.outstandingCents += row.outstandingCents;
    for (const payer of payers) {
      value[payer + 'OutstandingCents'] += row.payers[payer].outstandingCents;
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
