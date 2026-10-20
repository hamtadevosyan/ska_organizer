const db = require('./dbAdapter');
const { problem } = require('./planValidation');
const classRole = role => ['teacher', 'viewer'].includes(role);
const summary = staff => staff ? { id: staff.id, name: staff.name, active: staff.active, roomId: staff.roomId ?? null } : null;

// A job title never grants application permissions. A linked class account
// takes its class from the employee record, checked again on every request.
async function resolve(account, { allowInactive = false } = {}) {
  if (!account) return null;
  if (!account.staffMemberId) return { ...account, staffMemberId: null, linkedStaff: null };
  const staff = await db.getStaffById(account.staffMemberId);
  if ((!staff || !staff.active) && !allowInactive) return null;
  return { ...account, linkedStaff: summary(staff),
    roomId: classRole(account.role) ? staff?.roomId ?? null : null };
}

async function assignment(input, previous, role) {
  const id = input.staffMemberId === undefined ? previous?.staffMemberId ?? null : input.staffMemberId;
  if (id === null) return { staffMemberId: null, staff: null };
  if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 255) throw problem('Choose a valid staff record.');
  const staff = await db.getStaffById(id);
  if (!staff || (!staff.active && (id !== previous?.staffMemberId || !input.disabled))) throw problem('Choose an active staff record, or unlink this inactive employee.', 409);
  if ((await db.listAccounts()).some(account => account.staffMemberId === id && account.id !== previous?.id)) {
    throw problem('This staff member already has a sign-in account. Manage that existing account.', 409);
  }
  const expectedRoom = classRole(role) ? staff.roomId ?? null : null;
  if (input.roomId !== undefined && input.roomId !== expectedRoom) {
    throw problem('The linked staff record supplies the class. Refresh the account or update the staff assignment first.', 409);
  }
  return { staffMemberId: id, staff };
}

// Caller holds authentication then room locks, including direct service calls.
async function beforeStaffUpdate(previous, next) {
  if (!previous.active || next.active) return;
  const accounts = await db.listAccounts();
  const linked = accounts.find(account => account.staffMemberId === previous.id && !account.disabled);
  if (linked?.role === 'admin' && accounts.filter(account => account.role === 'admin' && !account.disabled).length <= 1) {
    throw problem('Another enabled administrator is required before deactivating this staff member.', 409);
  }
}
async function afterStaffUpdate(previous, next) {
  const linked = (await db.listAccounts()).find(account => account.staffMemberId === next.id);
  if (!linked) return;
  const roomId = classRole(linked.role) ? next.roomId ?? null : null;
  const changedScope = (previous.roomId ?? null) !== (next.roomId ?? null);
  if (!next.active || (linked.roomId ?? null) !== roomId) {
    await db.updateAccount(linked.id, { roomId, ...(!next.active ? { disabled: true } : {}) });
  }
  if (changedScope || previous.active !== next.active) await db.revokeSessions(linked.id);
  // Reactivating employment deliberately does not re-enable a disabled login.
}
module.exports = { resolve, assignment, beforeStaffUpdate, afterStaffUpdate, classRole };
