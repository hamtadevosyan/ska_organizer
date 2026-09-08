// server/services/dbAdapter.mock.js

// In-memory mock data store
const mock = {
  children: [],
  attendance: [],
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

let catalogQueue = Promise.resolve();
module.exports = {
  withCatalogLock: (fn) => {
    const operation = catalogQueue.then(fn);
    catalogQueue = operation.catch(() => {});
    return operation;
  },
  ingredientHasQuantities: async (id) => mock.mealIngredients.some((link) => link.ingredientId === id) ||
    mock.shelf.some((item) => item.ingredientId === id) ||
    Object.values(mock.weeklyPlans).some((plan) => plan.items.some((item) => item.ingredient.id === id) ||
      Object.hasOwn(plan.inHouse, id)),
  getMealIngredientById: async (id) => mock.mealIngredients.find((link) => link.id === id) || null,
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
