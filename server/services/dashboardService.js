const db = require('./dbAdapter');
const time = require('./facilityTime');
const { problem } = require('./planValidation');

// Only operational events belong on the shared dashboard. Never expose account
// access changes, usernames, raw entity identifiers or authentication history.
const events = {
  'child.create': ['Child added', '/children'],
  'child.update': ['Child details updated', '/children'],
  'child.enrollment': ['Child enrollment updated', '/children'],
  'child.assign_room': ['Child room assignment updated', '/children'],
  'attendance.check_in': ['Child checked in', '/attendance'],
  'attendance.check_out': ['Child checked out', '/attendance'],
  'attendance.correct': ['Attendance corrected', '/attendance'],
  'staff.create': ['Staff member added', '/staff'],
  'staff.update': ['Staff details updated', '/staff'],
  'room.create': ['Room added', '/rooms'],
  'room.update': ['Room details updated', '/rooms'],
  'inventory.group.create': ['Inventory group added', '/inventory'],
  'inventory.create': ['Inventory item added', '/inventory'],
  'inventory.adjust': ['Stock amount updated', '/inventory'],
  'inventory.update': ['Inventory details updated', '/inventory'],
  'inventory.purchase.receive': ['Purchase received', '/inventory'],
  'weekly_plan.save': ['Weekly menu saved', '/meals'],
  'menu.confirm': ['Menu confirmed', '/meals'],
  'meal.create': ['Meal added', '/meals'],
  'meal.update': ['Meal updated', '/meals'],
  'meal.archive': ['Meal archived', '/meals'],
  'ingredient.create': ['Ingredient added', '/meals'],
  'ingredient.update': ['Ingredient updated', '/meals'],
  'ingredient.archive': ['Ingredient archived', '/meals'],
  'recipe.add_ingredient': ['Recipe ingredient added', '/meals'],
  'recipe.update_ingredient': ['Recipe ingredient updated', '/meals'],
  'recipe.remove_ingredient': ['Recipe ingredient removed', '/meals'],
  'shelf.save': ['Shelf check saved', '/meals'],
  'activity.create': ['Activity added', '/activities'],
  'activity.update': ['Activity updated', '/activities'],
  'activity.delete': ['Activity removed', '/activities'],
  'activity.save_week': ['Activity week saved', '/activities'],
  'schedule.save_week': ['Room schedule saved', '/activities'],
};
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const slots = { breakfast: 'Breakfast', snack: 'Morning snack', lunch: 'Lunch', afternoonSnack: 'Afternoon snack' };
async function section(label, read) {
  try { return { data: await read() }; }
  catch { return { error: `Could not load ${label}. Please try again.` }; }
}
async function attendance(now, today) {
  const records = await db.listAttendance({ openOnly: true, includeVoided: false });
  const children = new Set();
  const reviewRequired = records.some((row) => {
    const start = row.checkIn && new Date(row.checkIn);
    if (row.needsReview || !start || !Number.isFinite(start.getTime()) || start > now ||
        time.dateAt(start) !== today || !row.childId || children.has(row.childId)) return true;
    children.add(row.childId);
    return false;
  });
  return { count: reviewRequired ? null : children.size, reviewRequired };
}
async function meals(weekStart, day) {
  const plan = await db.getWeeklyPlan(weekStart);
  const menu = plan?.week.find((row) => row.day === day)?.menu;
  return { savedAt: plan?.savedAt || null, items: Object.entries(slots)
    .filter(([slot]) => menu?.[slot])
    .map(([slot, label]) => ({ slot, label, name: menu[slot].name })) };
}
// Read header + entries together under the same lock used by schedule saves.
// Saved snapshots remain authoritative after catalog corrections or archiving.
const activities = (weekStart, date) => db.withRoomLock(async () => {
  const rooms = await db.listRooms({ includeArchived: true });
  const result = [];
  for (const room of rooms) {
    const rows = (await db.listScheduleEntries(room.id, weekStart)).filter((row) => row.date === date);
    if (!room.active && !rows.length) continue;
    const header = await db.getScheduleWeek(room.id, weekStart);
    const entries = rows.map((row) => ({ id: row.id, name: row.activitySnapshot?.name || 'Activity details unavailable',
      startTime: row.startTime || null, endTime: row.endTime || null, timeBlock: row.timeBlock || null }));
    const order = (row) => row.startTime || ({ morning: '25:01', midday: '25:02', afternoon: '25:03' }[row.timeBlock] || '25:04');
    entries.sort((a, b) => order(a).localeCompare(order(b)) || a.id.localeCompare(b.id));
    result.push({ id: room.id, name: room.name, active: room.active, savedAt: header?.savedAt || null, entries });
  }
  return { rooms: result };
});

exports.getMetrics = async (query = {}) => {
  if (Object.keys(query).some((key) => key !== 'date')) throw problem('Only the dashboard date can be selected.');
  const now = new Date();
  const timeZone = time.timeZone();
  const today = time.dateAt(now, timeZone);
  const date = query.date === undefined ? today : time.validateDate(query.date);
  const dayIndex = new Date(date + 'T12:00:00Z').getUTCDay();
  const weekStart = time.addDays(date, -((dayIndex + 6) % 7));
  const definitions = {
    enrollment: ['enrollment', async () => ({ count: await db.countChildren({ active: true }) })],
    attendance: ['attendance', () => attendance(now, today)],
    staff: ['staff', async () => ({ count: await db.countStaff({ active: true }) })],
    inventory: ['stock levels', async () => {
      const [total, low, out] = await Promise.all([db.countInventory(), db.countInventory({ status: 'low' }), db.countInventory({ status: 'out' })]);
      return { total, low, out };
    }],
    meals: ['meals', () => meals(weekStart, days[dayIndex])],
    activities: ['room activities', () => activities(weekStart, date)],
    changes: ['recent changes', async () => (await db.listAudit({ actions: Object.keys(events), limit: 10 }))
      .map((row) => ({ id: row.id, label: events[row.action][0], href: events[row.action][1], occurredAt: row.occurredAt }))],
  };
  const sections = Object.fromEntries(await Promise.all(Object.entries(definitions)
    .map(async ([key, [label, read]]) => [key, await section(label, read)])));
  return { today, date, weekStart, timeZone, takenAt: now.toISOString(), sections,
    // Compatibility for existing integrations: a failed metric is omitted,
    // never represented as zero. The client uses explicit section results.
    ...(sections.enrollment.data ? { totalStudents: sections.enrollment.data.count } : {}),
    ...(sections.staff.data ? { totalStaff: sections.staff.data.count } : {}),
    ...(sections.inventory.data ? { inventoryCount: sections.inventory.data.total } : {}) };
};
