const db = require('./dbAdapter');
const auth = require('../auth/service');
const facility = require('./facilityTime');
const { validateWeekStart } = require('./planValidation');

// Keep the same lock order as account assignment: an administrator cannot
// change the scope between its live authorization check and the projection.
const scoped = (token, read) => db.withAuthLock(() => db.withRoomLock(async () => {
  const account = await auth.sessionAccount(token, { touch: true });
  auth.operationalPermission(account, false);
  if (!['viewer', 'teacher'].includes(account.role)) throw auth.problem('This view is available to Class viewer and Teacher accounts.', 403, 'CLASSROOM_VIEWER_ONLY');
  const assigned = account.roomId == null ? null : await db.getRoomById(account.roomId);
  const state = account.roomId == null ? 'unassigned' : assigned?.active ? 'assigned' : 'unavailable';
  const room = state === 'assigned' ? {
    id: assigned.id, name: assigned.name, ageMinMonths: assigned.ageMinMonths ?? null,
    ageMaxMonths: assigned.ageMaxMonths ?? null, capacity: assigned.capacity ?? null,
  } : null;
  return read({ state, room }, account);
}));

function queryKeys(query, allowed) {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw auth.problem('This class view does not accept those filters.');
}
function weekQuery(query) {
  queryKeys(query, ['weekStart']);
  return validateWeekStart(query.weekStart);
}
async function activeChildren(roomId) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await db.listChildren({ roomId, active: true, page, pageSize: 200 });
    rows.push(...batch);
    if (batch.length < 200) return rows;
  }
}
const child = (row) => ({ id: row.id, firstName: row.firstName, lastName: row.lastName, preferredName: row.preferredName ?? null });
exports.overview = (token, query = {}) => {
  queryKeys(query, []);
  return scoped(token, async (scope) => ({ ...scope, today: facility.dateAt(), timeZone: facility.timeZone(),
    activeChildCount: scope.room ? await db.countChildren({ roomId: scope.room.id, active: true }) : 0 }));
};
exports.children = (token, query = {}) => {
  queryKeys(query, []);
  return scoped(token, async (scope) => {
    const items = scope.room ? (await activeChildren(scope.room.id)).map(child) : [];
    return { ...scope, items, total: items.length };
  });
};
exports.activities = (token, query = {}) => {
  const weekStart = weekQuery(query);
  return scoped(token, async (scope) => {
    const header = scope.room ? await db.getScheduleWeek(scope.room.id, weekStart) : null;
    const entries = [];
    if (header) for (const row of await db.listScheduleEntries(scope.room.id, weekStart)) {
      // An old entry without a snapshot may expose its linked name only. Never
      // replace saved class details with a current catalog's private fields.
      const saved = row.activitySnapshot;
      const name = saved?.name ?? (await db.getActivityById(row.activityId))?.name ?? 'Unavailable activity';
      entries.push({ id: row.id, date: row.date, startTime: row.startTime ?? null, endTime: row.endTime ?? null,
        timeBlock: row.timeBlock ?? null, activity: { name, description: saved?.description ?? '', durationMinutes: saved?.durationMinutes ?? null } });
    }
    entries.sort((a, b) => (a.date + ':' + (a.startTime || a.timeBlock || '') + ':' + a.id).localeCompare(b.date + ':' + (b.startTime || b.timeBlock || '') + ':' + b.id));
    return { ...scope, weekStart, hasPlan: !!header, version: header?.version ?? 0, savedAt: header?.savedAt ?? null, entries };
  });
};
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const slots = ['breakfast', 'snack', 'lunch', 'afternoonSnack'];
exports.meals = (token, query = {}) => {
  const weekStart = weekQuery(query);
  return scoped(token, async (scope) => {
    const plan = scope.room ? await db.getWeeklyPlan(weekStart) : null;
    const week = plan ? days.map((day) => {
      const menu = (Array.isArray(plan.week) ? plan.week : []).find((row) => row.day === day)?.menu;
      return { day, meals: slots.filter((slot) => menu?.[slot] != null).map((slot) => ({ slot, name: menu[slot].name, type: menu[slot].type })) };
    }) : [];
    return { ...scope, weekStart, hasPlan: !!plan, version: plan?.version ?? 0, savedAt: plan?.savedAt ?? null, scope: 'facility', week };
  });
};

exports.withScope = scoped;
exports.activeChildren = activeChildren;
exports.publicChild = child;
