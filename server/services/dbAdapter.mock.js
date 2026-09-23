// server/services/dbAdapter.mock.js

const { AsyncLocalStorage } = require('node:async_hooks');
const { amount } = require('./inventoryValidation');

// In-memory mock data store
const mock = {
  rooms: [], scheduleEntries: [], scheduleWeeks: [], staff: [], inventoryGroups: [], inventoryItems: [], inventoryMovements: [], purchaseReceipts: [],
  accounts: [], sessions: [], loginAttempts: [], auditEvents: [],
  children: [],
  attendance: [], attendanceCorrections: [],
  activities: [],
  meals: [
    { id: "meal-1", name: "Oatmeal", type: "breakfast", description: "" },
    { id: "meal-2", name: "Banana", type: "snack", description: "" },
    { id: "meal-3", name: "Chicken Rice", type: "lunch", description: "" },
    { id: "meal-4", name: "Yogurt", type: "afternoonSnack", description: "" }
  ],
  ingredients: [
    { id: "ing-1", name: "Oats", unit: "g", shelfLifeDays: 180 },
    { id: "ing-2", name: "Milk", unit: "ml", shelfLifeDays: 7 },
    { id: "ing-3", name: "Bananas", unit: "count", shelfLifeDays: 7 },
    { id: "ing-4", name: "Chicken", unit: "g", shelfLifeDays: 3 },
    { id: "ing-5", name: "Rice", unit: "g", shelfLifeDays: 180 },
    { id: "ing-6", name: "Yogurt", unit: "g", shelfLifeDays: 7 }
  ],
  mealIngredients: [
    { id: "link-1", mealId: "meal-1", ingredientId: "ing-1", quantity: 30 },
    { id: "link-2", mealId: "meal-1", ingredientId: "ing-2", quantity: 100 },
    { id: "link-3", mealId: "meal-2", ingredientId: "ing-3", quantity: 1 },
    { id: "link-4", mealId: "meal-3", ingredientId: "ing-4", quantity: 75 },
    { id: "link-5", mealId: "meal-3", ingredientId: "ing-5", quantity: 50 },
    { id: "link-6", mealId: "meal-4", ingredientId: "ing-6", quantity: 100 }
  ],
  shelf: [],
  confirmedMenu: null,
  weeklyPlans: {},
  uuid: () => Math.random().toString(36).substring(2, 10),
  nowIso: () => new Date().toISOString()
};

let transactionQueue = Promise.resolve();
const inventoryStatus = (item) => amount(item.quantity) === 0n ? 'out' : amount(item.quantity) <= amount(item.reorderThreshold) ? 'low' : 'available';
const filteredInventory = ({ q, category, location, status, groupId } = {}) => mock.inventoryItems
  .filter((item) => (!q || q.toLowerCase().split(/\s+/).every((word) => item.name.toLowerCase().includes(word))) &&
    (!category || item.category === category) && (!groupId || item.groupId === groupId) && (!location || item.location === location) && (!status || inventoryStatus(item) === status))
  .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
const searchName = (child) => [child.firstName, child.lastName, child.preferredName].filter(Boolean).join(' ').toLowerCase();
const normalizeName = (name) => (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
const filteredStaff = ({ q, roomId, active } = {}) => mock.staff
  .filter((person) => (roomId === undefined || person.roomId === roomId) && (active === undefined || person.active === active) &&
    (!q || q.toLowerCase().split(/\s+/).every((part) => person.name.toLowerCase().includes(part))))
  .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
const filteredChildren = ({ q, roomId, active } = {}) => mock.children
  .filter((c) => (roomId === undefined || c.roomId === roomId) && (active === undefined || c.active === active) &&
    (!q || q.toLowerCase().split(/\s+/).every((part) => searchName(c).includes(part))))
  .sort((a, b) => (a.firstName || '').localeCompare(b.firstName || '') || (a.lastName || '').localeCompare(b.lastName || '') || a.id.localeCompare(b.id));
const inScheduleWeek = (entry, roomId, weekStart) => {
  const end = new Date(weekStart + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 7);
  return entry.roomId === roomId && entry.date >= weekStart && entry.date < end.toISOString().slice(0, 10);
};
const transactionContext = new AsyncLocalStorage();
const withTransaction = (fn) => {
  if (transactionContext.getStore()) return fn();
  const operation = transactionQueue.then(() => transactionContext.run(true, async () => {
    const snapshot = structuredClone(Object.fromEntries(Object.entries(mock).filter(([, value]) => typeof value !== 'function')));
    try { return await fn(); } catch (error) { Object.assign(mock, snapshot); throw error; }
  }));
  transactionQueue = operation.catch(() => {});
  return operation;
};
module.exports = {
  withTransaction, withCatalogLock: withTransaction, withAuthLock: withTransaction, withRoomLock: withTransaction, withInventoryLock: withTransaction,
  listInventoryGroups: async () => structuredClone(mock.inventoryGroups.slice().sort((a, b) => a.name.localeCompare(b.name))),
  inventoryGroupCounts: async () => mock.inventoryGroups.map((group) => {
    const items = filteredInventory({ groupId: group.id });
    return { groupId: group.id, total: items.length, available: items.filter((item) => inventoryStatus(item) === 'available').length,
      lowStock: items.filter((item) => inventoryStatus(item) === 'low').length, outOfStock: items.filter((item) => inventoryStatus(item) === 'out').length };
  }),
  getInventoryGroupById: async (id) => structuredClone(mock.inventoryGroups.find((group) => group.id === id) || null),
  getInventoryGroupByName: async (nameKey) => structuredClone(mock.inventoryGroups.find((group) => group.nameKey === nameKey) || null),
  getInventoryGroupByRequestId: async (requestId) => structuredClone(mock.inventoryGroups.find((group) => group.requestId === requestId) || null),
  createInventoryGroup: async (values) => {
    const group = { id: mock.uuid(), createdAt: mock.nowIso(), updatedAt: mock.nowIso(), ...values };
    mock.inventoryGroups.push(group); return structuredClone(group);
  },
  listInventory: async ({ page = 1, pageSize = 50, ...filters } = {}) => structuredClone(filteredInventory(filters).slice((page - 1) * pageSize, page * pageSize)),
  countInventory: async (filters) => filteredInventory(filters).length,
  inventoryOptions: async () => ({ categories: [...new Set(mock.inventoryItems.map((item) => item.category))].sort(), locations: [...new Set(mock.inventoryItems.map((item) => item.location))].sort() }),
  getInventoryById: async (id) => structuredClone(mock.inventoryItems.find((item) => item.id === id) || null),
  createInventory: async (values) => {
    const item = { id: mock.uuid(), createdAt: mock.nowIso(), updatedAt: mock.nowIso(), ...values };
    mock.inventoryItems.push(item); return structuredClone(item);
  },
  updateInventory: async (id, values) => {
    const item = mock.inventoryItems.find((item) => item.id === id);
    if (!item) return null;
    Object.assign(item, values, { updatedAt: mock.nowIso() }); return structuredClone(item);
  },
  appendInventoryMovement: async (values) => {
    const movement = { id: mock.uuid(), ...values }; mock.inventoryMovements.push(movement); return structuredClone(movement);
  },
  getInventoryMovementByRequestId: async (id) => structuredClone(mock.inventoryMovements.find((row) => row.requestId === id) || null),
  listInventoryMovements: async (itemId, { page = 1, pageSize = 50 } = {}) => structuredClone(mock.inventoryMovements
    .filter((row) => row.itemId === itemId).sort((a, b) => b.itemVersion - a.itemVersion).slice((page - 1) * pageSize, page * pageSize)),
  countInventoryMovements: async (itemId) => mock.inventoryMovements.filter((row) => row.itemId === itemId).length,
  listInventoryForIngredients: async (ids) => structuredClone(mock.inventoryItems.filter((item) => ids.includes(item.ingredientId)).sort((a, b) => a.id.localeCompare(b.id))),
  createPurchaseReceipt: async (values) => {
    const receipt = { id: mock.uuid(), ...values }; mock.purchaseReceipts.push(receipt); return structuredClone(receipt);
  },
  getPurchaseByMovementId: async (movementId) => structuredClone(mock.purchaseReceipts.find((row) => row.movementId === movementId) || null),
  listPurchaseReceipts: async ({ itemId, page = 1, pageSize = 25 } = {}) => structuredClone(mock.purchaseReceipts
    .filter((row) => !itemId || row.itemId === itemId)
    .sort((a, b) => b.receivedOn.localeCompare(a.receivedOn) || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id))
    .slice((page - 1) * pageSize, page * pageSize)),
  countPurchaseReceipts: async ({ itemId } = {}) => mock.purchaseReceipts.filter((row) => !itemId || row.itemId === itemId).length,
  listReportPurchases: async ({ from, to, limit }) => structuredClone(mock.purchaseReceipts
    .filter((row) => row.receivedOn >= from && row.receivedOn <= to)
    .sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || new Date(a.recordedAt) - new Date(b.recordedAt) || a.id.localeCompare(b.id))
    .slice(0, limit)),
  listStaff: async ({ page = 1, pageSize = 50, ...filters } = {}) => structuredClone(filteredStaff(filters).slice((page - 1) * pageSize, page * pageSize)),
  countStaff: async (filters) => filteredStaff(filters).length,
  getStaffById: async (id) => structuredClone(mock.staff.find((person) => person.id === id) || null),
  createStaff: async (payload) => {
    const person = { id: mock.uuid(), active: true, roomId: null, version: 1, createdAt: mock.nowIso(), updatedAt: mock.nowIso(), ...payload };
    mock.staff.push(person);
    return structuredClone(person);
  },
  updateStaff: async (id, changes) => {
    const person = mock.staff.find((row) => row.id === id);
    if (!person) return null;
    Object.assign(person, changes, { updatedAt: mock.nowIso() });
    return structuredClone(person);
  },
  listRooms: async ({ includeArchived = false } = {}) => structuredClone(mock.rooms.filter((room) => includeArchived || room.active).sort((a, b) => a.name.localeCompare(b.name))),
  getRoomById: async (id) => structuredClone(mock.rooms.find((room) => room.id === id) || null),
  createRoom: async (payload) => {
    const room = { id: mock.uuid(), active: true, createdAt: mock.nowIso(), updatedAt: mock.nowIso(), ...payload };
    mock.rooms.push(room);
    return structuredClone(room);
  },
  updateRoom: async (id, changes) => {
    const room = mock.rooms.find((row) => row.id === id);
    if (!room) return null;
    Object.assign(room, changes, { updatedAt: mock.nowIso() });
    return structuredClone(room);
  },
  roomChildCounts: async () => {
    const counts = Object.create(null);
    for (const child of mock.children) if (child.active && child.roomId != null) counts[child.roomId] = (counts[child.roomId] || 0) + 1;
    return counts;
  },
  countChildren: async (filters) => filteredChildren(filters).length,
  listScheduleEntries: async (roomId, weekStart) => structuredClone(mock.scheduleEntries.filter((row) => inScheduleWeek(row, roomId, weekStart))),
  getScheduleEntryById: async (id) => structuredClone(mock.scheduleEntries.find((row) => row.id === id) || null),
  getScheduleWeek: async (roomId, weekStart) => structuredClone(mock.scheduleWeeks.find((row) => row.roomId === roomId && row.weekStart === weekStart) || null),
  saveScheduleWeek: async (values) => {
    mock.scheduleWeeks = mock.scheduleWeeks.filter((row) => row.roomId !== values.roomId || row.weekStart !== values.weekStart);
    mock.scheduleWeeks.push(structuredClone(values));
    return structuredClone(values);
  },
  activityInSchedule: async (id) => mock.scheduleEntries.some((entry) => entry.activityId === id),
  saveScheduleEntries: async (roomId, weekStart, entries) => {
    mock.scheduleEntries = mock.scheduleEntries.filter((row) => !inScheduleWeek(row, roomId, weekStart));
    const created = entries.map((entry) => ({ ...entry, roomId, id: entry.id || mock.uuid(), createdAt: mock.nowIso(), updatedAt: mock.nowIso() }));
    mock.scheduleEntries.push(...created);
    return structuredClone(created);
  },
  ingredientHasQuantities: async (id) => mock.inventoryItems.some((item) => item.ingredientId === id) || mock.mealIngredients.some((link) => link.ingredientId === id) ||
    mock.shelf.some((item) => item.ingredientId === id) ||
    Object.values(mock.weeklyPlans).some((plan) => plan.items.some((item) => item.ingredient.id === id) ||
      Object.hasOwn(plan.inHouse, id)),
  getMealIngredientById: async (id) => mock.mealIngredients.find((link) => link.id === id) || null,
  // ------------------------------------------------------
  // RESET (for tests)
  // ------------------------------------------------------
  reset: () => {
    mock.scheduleWeeks = [];
    mock.rooms = []; mock.scheduleEntries = []; mock.staff = []; mock.inventoryGroups = []; mock.inventoryItems = []; mock.inventoryMovements = []; mock.purchaseReceipts = [];
    mock.accounts = []; mock.sessions = []; mock.loginAttempts = []; mock.auditEvents = [];
    mock.children = [];
    mock.attendance = [];
    mock.attendanceCorrections = [];
    mock.activities = [];
    mock.meals = [];
    mock.ingredients = [];
    mock.mealIngredients = [];
    mock.shelf = [];
    mock.confirmedMenu = null;
    mock.weeklyPlans = {};
  },

  getWeeklyPlan: async (weekStart) => structuredClone(mock.weeklyPlans[weekStart] || null),
  saveWeeklyPlan: async (snapshot, version) => {
    if ((mock.weeklyPlans[snapshot.weekStart]?.version || 0) !== version) {
      throw require('./planValidation').problem('This week was saved elsewhere. Reopen the saved week before saving again.', 409);
    }
    const saved = structuredClone({ ...snapshot, version: version + 1, savedAt: mock.nowIso() });
    mock.weeklyPlans[snapshot.weekStart] = saved;
    return structuredClone(saved);
  },

  // ------------------------------------------------------
  // CHILDREN
  // ------------------------------------------------------
  listChildren: async ({ page = 1, pageSize = 50, ...filters } = {}) =>
    structuredClone(filteredChildren(filters).slice((page - 1) * pageSize, page * pageSize)),

  findChildDuplicates: async (firstName, lastName, excludeId) => structuredClone(mock.children.filter((child) =>
    child.id !== excludeId && normalizeName(child.firstName) === normalizeName(firstName) && normalizeName(child.lastName) === normalizeName(lastName)).slice(0, 20)),

  getChildById: async (id) =>
    mock.children.find((c) => c.id === id) || null,

  createChild: async (payload) => {
    const rec = { id: payload.id || mock.uuid(), active: true, roomId: null, createdAt: mock.nowIso(), updatedAt: mock.nowIso(), ...payload };
    mock.children.push(rec);
    return rec;
  },

  updateChild: async (id, changes) => {
    const idx = mock.children.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    mock.children[idx] = { ...mock.children[idx], ...changes, updatedAt: mock.nowIso() };
    return mock.children[idx];
  },

  deleteChild: async (id) => {
    const idx = mock.children.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    mock.children.splice(idx, 1);
    return true;
  },

  // ------------------------------------------------------
  // ATTENDANCE  (YOUR ORIGINAL FUNCTIONS — RESTORED)
  // ------------------------------------------------------
  listAttendance: async ({ roomId, childId, date, from, to, openOnly = false, includeVoided = true, needsReview } = {}) => {
    if (date) ({ from, to } = require('./facilityTime').dayBounds(date));
    return structuredClone(mock.attendance.filter((row) =>
      (!roomId || row.roomId === roomId) && (!childId || row.childId === childId) &&
      (includeVoided || !row.voided) && (!openOnly || !row.checkOut) &&
      (needsReview === undefined || row.needsReview === needsReview) &&
      (!to || (row.checkIn && new Date(row.checkIn) < new Date(to))) &&
      (!from || !row.checkOut || new Date(row.checkOut) > new Date(from) || new Date(row.checkIn) >= new Date(from)))
      .sort((a, b) => new Date(a.checkIn || 0) - new Date(b.checkIn || 0) || a.id.localeCompare(b.id)));
  },
  getAttendanceByRequestId: async (requestId) => structuredClone(mock.attendance.find((row) => row.requestId === requestId) || null),
  listReportAttendance: async ({ from, to, roomId, limit }) => structuredClone(mock.attendance
    .filter((row) => (!roomId || row.roomId === roomId) && row.checkIn && new Date(row.checkIn) < new Date(to) &&
      (!row.checkOut || new Date(row.checkOut) > new Date(from) || new Date(row.checkIn) >= new Date(from)))
    .sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn) || a.id.localeCompare(b.id)).slice(0, limit)),
  countUndatedAttendance: async ({ roomId }) => mock.attendance.filter((row) => !row.checkIn && !row.voided && (!roomId || row.roomId === roomId)).length,
  listReportChildren: async (ids) => mock.children.filter((row) => ids.includes(row.id))
    .map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
  createAttendanceCorrection: async (values) => {
    const record = { id: mock.uuid(), ...structuredClone(values) };
    mock.attendanceCorrections.push(record);
    return structuredClone(record);
  },
  listAttendanceCorrections: async (attendanceId) => structuredClone(mock.attendanceCorrections.filter((row) => row.attendanceId === attendanceId)
    .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || a.after.version - b.after.version)),

  getAttendanceById: async (id) =>
    mock.attendance.find((a) => a.id === id) || null,

  createAttendance: async (payload) => {
    const rec = {
      id: mock.uuid(),
      checkIn: mock.nowIso(),
      checkOut: null,
      version: 1, voided: false, needsReview: false, requestId: null,
      ...payload
    };
    mock.attendance.push(rec);
    return rec;
  },

  updateAttendance: async (id, changes) => {
    const idx = mock.attendance.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    mock.attendance[idx] = { ...mock.attendance[idx], ...changes };
    return mock.attendance[idx];
  },

  deleteAttendance: async (id) => {
    const idx = mock.attendance.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    mock.attendance.splice(idx, 1);
    return true;
  },

  checkIn: async (payload) => {
    const rec = {
      id: mock.uuid(),
      ...payload,
      checkIn: mock.nowIso(),
      checkOut: null
    };
    mock.attendance.push(rec);
    return rec;
  },

  checkOut: async (id) => {
    const idx = mock.attendance.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    mock.attendance[idx].checkOut = mock.nowIso();
    return mock.attendance[idx];
  },

  getPresentChildrenForRoom: async (roomId) =>
    mock.attendance.filter((a) => a.roomId === roomId && !a.checkOut),

  // ------------------------------------------------------
  // ACTIVITIES
  // ------------------------------------------------------
  listActivities: async (opts = {}) => {
    let items = [...mock.activities];

    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.description || "").toLowerCase().includes(q)
      );
    }

    if (opts.roomId) {
      items = items.filter((a) => a.roomId === opts.roomId);
    }

    return structuredClone(items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
  },

  getActivityById: async (id) =>
    structuredClone(mock.activities.find((a) => a.id === id) || null),

  createActivity: async (payload) => {
    const rec = {
      version: 1, durationMinutes: null, ageMinMonths: null, ageMaxMonths: null, materials: [],
      ...payload,
      id: payload.id || mock.uuid(),
      name: payload.name,
      description: payload.description || "",
      roomId: payload.roomId || null,
      startTime: payload.startTime || null,
      endTime: payload.endTime || null,
      createdAt: mock.nowIso(), updatedAt: mock.nowIso()
    };
    mock.activities.push(rec);
    return structuredClone(rec);
  },

  updateActivity: async (id, changes) => {
    const idx = mock.activities.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    mock.activities[idx] = { ...mock.activities[idx], ...changes, updatedAt: mock.nowIso() };
    return structuredClone(mock.activities[idx]);
  },

  deleteActivity: async (id) => {
    const idx = mock.activities.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    mock.activities.splice(idx, 1);
    return true;
  },

  // ------------------------------------------------------
  // MEALS
  // ------------------------------------------------------
  listMeals: async ({ type, includeArchived = false } = {}) => mock.meals.filter((m) => (includeArchived || !m.archived) && (!type || m.type === type)),

  listMealsByType: async (type) =>
    mock.meals.filter((m) => m.type === type && !m.archived),

  getMealById: async (id) =>
    mock.meals.find((m) => m.id === id) || null,

  createMeal: async (payload) => {
    const rec = {
      id: payload.id || mock.uuid(),
      name: payload.name,
      archived: payload.archived || false,
      type: payload.type,
      description: payload.description || "",
      createdAt: mock.nowIso()
    };
    mock.meals.push(rec);
    return rec;
  },

  updateMeal: async (id, changes) => {
    const idx = mock.meals.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    mock.meals[idx] = { ...mock.meals[idx], ...changes };
    return mock.meals[idx];
  },

  deleteMeal: async (id) => {
    const idx = mock.meals.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    mock.meals.splice(idx, 1);
    return true;
  },

  // ------------------------------------------------------
  // INGREDIENTS
  // ------------------------------------------------------
  listIngredients: async ({ includeArchived = false } = {}) => mock.ingredients.filter((i) => includeArchived || !i.archived),

  getIngredientById: async (id) =>
    mock.ingredients.find((i) => i.id === id) || null,

  createIngredient: async (payload) => {
    const rec = {
      id: payload.id || mock.uuid(),
      name: payload.name,
      archived: payload.archived || false,
      unit: payload.unit,
      shelfLifeDays: payload.shelfLifeDays,
      createdAt: mock.nowIso()
    };
    mock.ingredients.push(rec);
    return rec;
  },

  updateIngredient: async (id, changes) => {
    const idx = mock.ingredients.findIndex((i) => i.id === id);
    if (idx === -1) return null;
    mock.ingredients[idx] = { ...mock.ingredients[idx], ...changes };
    return mock.ingredients[idx];
  },

  deleteIngredient: async (id) => {
    const idx = mock.ingredients.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    mock.ingredients.splice(idx, 1);
    return true;
  },

  // ------------------------------------------------------
  // MEAL INGREDIENTS
  // ------------------------------------------------------
  listMealIngredients: async (mealId) =>
    mock.mealIngredients.filter((mi) => mi.mealId === mealId),

  addMealIngredient: async (payload) => {
    if (mock.mealIngredients.some((link) => link.mealId === payload.mealId && link.ingredientId === payload.ingredientId)) {
      throw require('./catalogValidation').fieldError('ingredientId', 'This ingredient is already in the recipe.', 409);
    }
    const rec = {
      id: payload.id || mock.uuid(),
      mealId: payload.mealId,
      ingredientId: payload.ingredientId,
      quantity: payload.quantity,
      createdAt: mock.nowIso()
    };
    mock.mealIngredients.push(rec);
    return rec;
  },

  updateMealIngredient: async (id, changes) => {
    const idx = mock.mealIngredients.findIndex((mi) => mi.id === id);
    if (idx === -1) return null;
    mock.mealIngredients[idx] = { ...mock.mealIngredients[idx], ...changes };
    return mock.mealIngredients[idx];
  },

  deleteMealIngredient: async (id) => {
    const idx = mock.mealIngredients.findIndex((mi) => mi.id === id);
    if (idx === -1) return false;
    mock.mealIngredients.splice(idx, 1);
    return true;
  },

  // ------------------------------------------------------
  // CONFIRMED MENU
  // ------------------------------------------------------
  saveConfirmedMenu: async ({ week }) => {
    mock.confirmedMenu = {
      week,
      confirmedAt: mock.nowIso()
    };
    return mock.confirmedMenu;
  },

  getConfirmedMenu: async () => mock.confirmedMenu,

  // ------------------------------------------------------
  // SHELF STORAGE
  // ------------------------------------------------------
  saveShelfCheck: async (items) => {
    mock.shelf = items;
    return mock.shelf;
  },

  getShelf: async () => mock.shelf
};

const copy = (value) => structuredClone(value);
const find = (collection, id) => copy(mock[collection].find((item) => item.id === id) || null);
const insert = (collection, value) => { mock[collection].push(copy(value)); return copy(value); };
const edit = (collection, id, values) => {
  const index = mock[collection].findIndex((item) => item.id === id);
  if (index < 0) return null;
  mock[collection][index] = { ...mock[collection][index], ...copy(values) };
  return copy(mock[collection][index]);
};
const remove = (collection, id) => { mock[collection] = mock[collection].filter((item) => item.id !== id); };
Object.assign(module.exports, {
  listAccounts: async () => copy(mock.accounts).sort((a, b) => a.username.localeCompare(b.username)),
  getAccount: async (id) => find('accounts', id),
  findAccount: async (username) => copy(mock.accounts.find((item) => item.username === username) || null),
  createAccount: async (values) => insert('accounts', { createdAt: mock.nowIso(), updatedAt: mock.nowIso(), ...values }),
  updateAccount: async (id, values) => edit('accounts', id, { ...values, updatedAt: mock.nowIso() }),
  createSession: async (values) => insert('sessions', values),
  getSession: async (id) => find('sessions', id),
  updateSession: async (id, values) => edit('sessions', id, values),
  deleteSession: async (id) => remove('sessions', id),
  revokeSessions: async (accountId) => { mock.sessions = mock.sessions.filter((session) => session.accountId !== accountId); },
  getLoginAttempt: async (id) => find('loginAttempts', id),
  saveLoginAttempt: async (values) => edit('loginAttempts', values.id, values) || insert('loginAttempts', values),
  deleteLoginAttempt: async (id) => remove('loginAttempts', id),
  cleanAuthRecords: async (now) => {
    for (const key of ['sessions', 'loginAttempts']) mock[key] = mock[key].filter((item) => new Date(item.expiresAt) > now);
  },
  appendAudit: async (values) => insert('auditEvents', values),
  listAudit: async ({ limit = 50, offset = 0, actions } = {}) => copy(mock.auditEvents).filter((row) => !actions || actions.includes(row.action)).sort((a, b) =>
    new Date(b.occurredAt) - new Date(a.occurredAt) || b.id.localeCompare(a.id)).slice(offset, offset + limit),
});
