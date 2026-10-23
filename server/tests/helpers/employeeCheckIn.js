const { randomUUID } = require('node:crypto');
const db = require('../../services/dbAdapter');
const vault = require('../../services/payrollVault');
const payroll = require('../../services/payrollService');
const fixture = require('./authenticatedRequest');

// Exercise the real manager-clock path. Tests install their own temporary
// payroll key; this helper never bypasses attendance or authorization checks.
module.exports = async function employeeCheckIn(staffId) {
  const previous = await db.getPayrollRecord('ledger:' + staffId);
  if (previous && vault.open(previous).sessions.some(session => !session.voided && session.end === null)) return;
  return payroll.managerClock(fixture.credentials().cookie.split('=')[1], staffId, {
    action: 'checkin', requestId: randomUUID(), version: previous?.version || 0,
  });
};
