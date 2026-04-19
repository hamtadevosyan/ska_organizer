// server/services/dbAdapter.mock.js

// In-memory mock data store
const mock = {
  children: [],
  attendance: [],
  activities: [],
  meals: [],
  ingredients: [],
  mealIngredients: [],
  shelf: [],
  confirmedMenu: null,
  uuid: () => Math.random().toString(36).substring(2, 10),
  nowIso: () => new Date().toISOString()
};

module.exports = {
  // ------------------------------------------------------
  // RESET (for tests)
  // ------------------------------------------------------
  reset: () => {
    mock.children = [];
    mock.attendance = [];
    mock.activities = [];
    mock.meals = [];
    mock.ingredients = [];
    mock.mealIngredients = [];
    mock.shelf = [];
    mock.confirmedMenu = null;
  },

  // ------------------------------------------------------
  // CHILDREN
  // ------------------------------------------------------
  listChildren: async () => mock.children,

  getChildById: async (id) =>
    mock.children.find((c) => c.id === id) || null,

  createChild: async (payload) => {
    const rec = { id: payload.id || mock.uuid(), ...payload };
    mock.children.push(rec);
    return rec;
  },

  updateChild: async (id, changes) => {
    const idx = mock.children.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    mock.children[idx] = { ...mock.children[idx], ...changes };
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
  listAttendance: async () => mock.attendance,

  getAttendanceById: async (id) =>
    mock.attendance.find((a) => a.id === id) || null,

  createAttendance: async (payload) => {
    const rec = {
      id: mock.uuid(),
      ...payload,
      checkIn: mock.nowIso(),
      checkOut: null
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

    return items;
  },

  getActivityById: async (id) =>
    mock.activities.find((a) => a.id === id) || null,

  createActivity: async (payload) => {
    const rec = {
      id: payload.id || mock.uuid(),
      name: payload.name,
      description: payload.description || "",
      roomId: payload.roomId || null,
      startTime: payload.startTime || null,
      endTime: payload.endTime || null,
      createdAt: mock.nowIso()
    };
    mock.activities.push(rec);
    return rec;
  },

  updateActivity: async (id, changes) => {
    const idx = mock.activities.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    mock.activities[idx] = { ...mock.activities[idx], ...changes };
    return mock.activities[idx];
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
  listMeals: async () => mock.meals,

  listMealsByType: async (type) =>
    mock.meals.filter((m) => m.type === type),

  getMealById: async (id) =>
    mock.meals.find((m) => m.id === id) || null,

  createMeal: async (payload) => {
    const rec = {
      id: payload.id || mock.uuid(),
      name: payload.name,
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
  listIngredients: async () => mock.ingredients,

  getIngredientById: async (id) =>
    mock.ingredients.find((i) => i.id === id) || null,

  createIngredient: async (payload) => {
    const rec = {
      id: payload.id || mock.uuid(),
      name: payload.name,
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
  saveConfirmedMenu: async (week) => {
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

