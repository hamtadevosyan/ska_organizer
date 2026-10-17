const { amount, decimal, UNITS } = require('./inventoryValidation');
const { compatible, convert } = require('./stockUnits');
const { problem } = require('./planValidation');

const MAX = 999999999999999999n;
const MAX_LINES = 2000;
const MAX_SOURCES = 6000;
const MAX_ENTRIES = 3000;
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const positive = (value) => value > 0n ? value : 0n;
const maximum = (...values) => values.reduce((a, b) => a > b ? a : b, 0n);

// Required amounts round up; available stock rounds down. A reverse conversion
// detects a remainder without inventing factors for count, boxes or packages.
function demand(value, from, to) {
  const rounded = convert(value, from, to);
  return convert(rounded, to, from) < value ? rounded + 1n : rounded;
}
function storedAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value >= 1e12) throw problem('Invalid saved quantity.');
    return amount(value.toFixed(6));
  }
  return amount(value);
}
function checkedAmount(value) {
  if (value > MAX) throw problem('This purchasing calculation is too large. Include fewer plans or smaller quantities.', 422);
  return value;
}

function calculate({ weekStart, includeMeals, roomIds, lowStockTargets, mealPlan, activityPlans, inventory, inactiveGroupIds = [],
  version = 0, stockTakenAt = new Date().toISOString() }) {
  const issues = [];
  const issueKeys = new Set();
  const issue = (code, message, resolution, href) => {
    const key = code + ':' + message;
    if (issueKeys.has(key)) return;
    issueKeys.add(key); issues.push({ code, message, resolution, ...(href ? { href } : {}) });
    if (issues.length > MAX_LINES) throw problem('This purchasing calculation has too many unresolved details. Include fewer plans and correct their requirements.', 422);
  };
  const inactiveGroups = new Set(inactiveGroupIds);
  const inactive = (row) => !!row.archived || inactiveGroups.has(row.groupId);
  const retainedStocks = [...inventory].sort((a, b) => a.id.localeCompare(b.id));
  const stocks = retainedStocks.filter((row) => !inactive(row));
  // Exact material/target references need the retained row for diagnostics;
  // food allocation and every availability calculation use active stock only.
  const byId = new Map(retainedStocks.map((row) => [row.id, row]));
  const rows = new Map();
  let sourceCount = 0;
  const rowFor = (stock) => {
    if (!rows.has(stock.id)) rows.set(stock.id, { stock, consumed: 0n, events: new Map(), food: 0n,
      target: 0n, sources: [], notes: new Set(), reused: 0n });
    return rows.get(stock.id);
  };
  const source = (row, value) => {
    sourceCount += 1;
    if (sourceCount > MAX_SOURCES) throw problem('This purchasing calculation has too many source details. Include fewer room plans.', 422);
    row.sources.push(value);
  };
  let entryCount = 0;
  for (const plan of activityPlans) {
    if (!plan.room) {
      issue('ROOM_MISSING', 'A selected activity room is unavailable.', 'Remove that room from this list or restore it.', '/rooms');
      continue;
    }
    if (!plan.header && !plan.entries.length) {
      issue('ACTIVITY_PLAN_MISSING', `${plan.room.name} has no saved activity plan for this week.`, 'Save its activity plan or remove this room from the purchasing selection.', '/activities');
      continue;
    }
    for (const entry of plan.entries) {
      if (++entryCount > MAX_ENTRIES) throw problem('This purchasing calculation has too many activities. Include fewer room plans.', 422);
      const activity = entry?.activitySnapshot;
      if (!activity || !Array.isArray(activity.materials)) {
        issue('ACTIVITY_SNAPSHOT_MISSING', `${plan.room.name}: a saved activity has no complete material snapshot.`, 'Open the activity plan, review the latest material details, and save it before recalculating.', '/activities');
        continue;
      }
      if (activity.materialsNotes != null && typeof activity.materialsNotes !== 'string' ||
        activity.materialsLinks != null && !Array.isArray(activity.materialsLinks)) {
        issue('ACTIVITY_SNAPSHOT_MISSING', `${plan.room.name}: ${activity.name} has incomplete saved material notes or links.`,
          'Review material requirements and save this activity plan again.', '/activities');
      }
      if (entry.materialHintsUnknown || typeof activity.materialsNotes === 'string' && activity.materialsNotes.trim() || Array.isArray(activity.materialsLinks) && activity.materialsLinks.length) issue('ACTIVITY_MATERIAL_UNLINKED',
        `${plan.room.name}: ${activity.name} includes material notes or links without quantified inventory requirements.`,
        'Link every required material to Inventory with its quantity, then update and save this activity plan.', '/activities');
      const date = new Date(entry.date + 'T00:00:00Z');
      const endOfWeek = new Date(weekStart + 'T00:00:00Z'); endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 7);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.date || entry.date < weekStart || entry.date >= endOfWeek.toISOString().slice(0, 10)) {
        issue('ACTIVITY_DATE_INVALID', `${plan.room.name}: a saved activity has an invalid date.`, 'Correct and save the activity date before recalculating.', '/activities');
        continue;
      }
      if (activity.materials.length > 30) {
        issue('ACTIVITY_MATERIALS_INVALID', `${plan.room.name}: ${activity.name} has an invalid saved material list.`,
          'Review the activity materials and save its plan again.', '/activities');
        continue;
      }
      for (const material of activity.materials) {
        if (!material || typeof material !== 'object') {
          issue('MATERIAL_QUANTITY_UNKNOWN', `${activity.name} has an incomplete saved material.`,
            'Choose an inventory item and positive quantity, then update and save this activity plan.', '/activities');
          continue;
        }
        const stock = byId.get(material.itemId);
        if (!stock) {
          issue('MATERIAL_MISSING', `${plan.room.name}: ${activity.name} requires an inventory item that is unavailable.`,
            'Choose an available inventory record for this material, then update and save the activity plan.', '/activities');
          continue;
        }
        if (inactive(stock)) {
          let requested = '';
          try { requested = decimal(storedAmount(material.quantity)) + ' ' + material.unit + ' of '; } catch { /* Unknown amounts remain in the saved activity. */ }
          issue('MATERIAL_ARCHIVED', `${plan.room.name}: ${activity.name} requires ${requested}${stock.name}${stock.location ? ' at ' + stock.location : ''}, which is archived.`,
            'Replace this exact material with an active Inventory item, then update and save the activity plan. Saved requirements are not reassigned to similarly named items.', '/activities');
          continue;
        }
        if (!UNITS.includes(material.unit) || !UNITS.includes(stock.unit) || !compatible(material.unit, stock.unit)) {
          issue('MATERIAL_UNIT_INCOMPATIBLE', `${activity.name}: ${stock.name} has incompatible saved and recorded units.`,
            'Correct the material quantity and unit in the activity, then update and save the plan. Package sizes are never guessed.', '/activities');
          continue;
        }
        let quantity;
        try { quantity = storedAmount(material.quantity); }
        catch { quantity = 0n; }
        if (quantity <= 0n || typeof material.reusable !== 'boolean') {
          issue('MATERIAL_QUANTITY_UNKNOWN', `${activity.name}: ${stock.name} has an unknown material quantity or reuse choice.`,
            'Set a positive material quantity and whether it is reusable, then update and save the activity plan.', '/activities');
          continue;
        }
        quantity = checkedAmount(demand(quantity, material.unit, stock.unit));
        const row = rowFor(stock);
        source(row, { kind: 'activity', label: `${plan.room.name} · ${activity.name}`, quantity: decimal(quantity), unit: stock.unit,
          roomId: plan.room.id, date: entry.date, reusable: material.reusable });
        if (material.unit !== stock.unit) row.notes.add(`Saved ${material.unit} demand was converted to ${stock.unit}; requirements round up to six decimal places.`);
        if (material.reusable) {
          const timed = typeof entry.startTime === 'string' && clock.test(entry.startTime) &&
            typeof entry.endTime === 'string' && (clock.test(entry.endTime) || entry.endTime === '24:00') && entry.endTime > entry.startTime;
          if (!timed) row.notes.add('A saved activity has unknown legacy times. Its reusable equipment conservatively occupies the whole day.');
          const events = row.events.get(entry.date) || [];
          events.push({ time: timed ? minute(entry.startTime) : 0, change: quantity },
            { time: timed ? minute(entry.endTime) : 1440, change: -quantity });
          row.events.set(entry.date, events);
        } else row.consumed = checkedAmount(row.consumed + quantity);
      }
    }
  }
  for (const row of rows.values()) {
    for (const events of row.events.values()) {
      let current = 0n;
      // Finishing activities release equipment before another activity starts.
      events.sort((a, b) => a.time - b.time || (a.change < b.change ? -1 : a.change > b.change ? 1 : 0));
      for (const event of events) { current += event.change; row.reused = maximum(row.reused, current); }
    }
    checkedAmount(row.consumed + row.reused);
    if (row.reused) row.notes.add(`Reusable equipment needs the largest simultaneous total across the selected rooms: ${decimal(row.reused)} ${row.stock.unit}.`);
  }
  for (const target of lowStockTargets) {
    const stock = byId.get(target.itemId);
    if (!stock) {
      issue('LOW_STOCK_ITEM_MISSING', 'A selected low-stock inventory record is unavailable.', 'Remove it from this list or restore the inventory record.', '/inventory');
      continue;
    }
    if (inactive(stock)) {
      issue('LOW_STOCK_ITEM_ARCHIVED', `${stock.name}${stock.location ? ' at ' + stock.location : ''} is archived and cannot supply the selected coverage target.`,
        'Remove this archived target and choose an active Inventory item if the supply is still needed.', '/inventory');
      continue;
    }
    if (!UNITS.includes(stock.unit)) {
      issue('LOW_STOCK_UNIT_INCOMPATIBLE', `${stock.name} has an unsupported recorded unit for its coverage target.`,
        'Correct its inventory unit and target. Package sizes are never guessed.', '/inventory');
      continue;
    }
    const row = rowFor(stock);
    row.target = amount(target.targetQuantity);
    source(row, { kind: 'low-stock', label: 'Total coverage target', quantity: decimal(row.target), unit: stock.unit });
    row.notes.add('The target is total stock coverage. Plan demand within that target is counted once; this is not an extra quantity or a reservation.');
  }

  const food = new Map();
  if (includeMeals) {
    if (!mealPlan) issue('MEAL_PLAN_MISSING', 'There is no saved meal plan for this week.', 'Save a meal plan for this week or turn off Include meals.', '/meals');
    else {
      if (!mealPlan.recipes || !Array.isArray(mealPlan.items) || !Array.isArray(mealPlan.week) || !mealPlan.week.length) {
        issue('MEAL_SNAPSHOT_INCOMPLETE', 'The saved meal plan has incomplete recipe or demand snapshots.', 'Open the meal plan, review current recipes, and save it before recalculating.', '/meals');
      }
      for (const item of Array.isArray(mealPlan.items) ? mealPlan.items : []) {
        const ingredient = item?.ingredient;
        let quantity;
        try { quantity = storedAmount(item?.quantity); } catch { quantity = null; }
        if (!ingredient || typeof ingredient.id !== 'string' || !ingredient.name || !UNITS.includes(ingredient.unit) || quantity === null) {
          issue('MEAL_DEMAND_INVALID', 'The saved meal plan contains an unavailable ingredient or unknown demand.', 'Correct the recipe and save the meal plan with current recipes before recalculating.', '/meals');
          continue;
        }
        const previous = food.get(ingredient.id);
        if (previous && previous.ingredient.unit !== ingredient.unit) {
          issue('MEAL_UNIT_CONFLICT', `${ingredient.name} has conflicting units in the saved plan.`, 'Correct the recipe units and save this meal plan again.', '/meals');
          continue;
        }
        const value = previous || { ingredient, quantity: 0n, sources: [] };
        value.quantity = checkedAmount(value.quantity + quantity); food.set(ingredient.id, value);
      }
      const seenDays = new Set();
      for (const day of Array.isArray(mealPlan.week) ? mealPlan.week : []) {
        if (!day || !days.includes(day.day) || seenDays.has(day.day) || !day.menu || typeof day.menu !== 'object' || Array.isArray(day.menu) || !Object.keys(day.menu).length) {
          issue('MEAL_SNAPSHOT_INCOMPLETE', 'The saved meal plan has an invalid or incomplete day selection.', 'Review meal selections and save this meal plan again.', '/meals');
          continue;
        }
        seenDays.add(day.day);
        for (const [slot, selection] of Object.entries(day.menu)) {
          if (!selection || typeof selection !== 'object' || typeof selection.id !== 'string') {
            issue('MEAL_SNAPSHOT_INCOMPLETE', `${day.day}: a saved meal selection is unavailable.`, 'Review meal selections and save this meal plan again.', '/meals');
            continue;
          }
          const recipe = mealPlan.recipes?.[day.day]?.[slot];
          if (!recipe || !Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.problems?.length) {
            issue('RECIPE_INCOMPLETE', `${day.day}: ${selection.name || recipe?.meal?.name || slot} has an incomplete saved recipe.`,
              'Correct its ingredients and quantities, then save this meal plan using current recipes.', '/meals');
            continue;
          }
          const dayIndex = days.indexOf(day.day);
          const date = new Date(weekStart + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + dayIndex);
          const dateKey = date.toISOString().slice(0, 10);
          const children = mealPlan.dailyChildrenCounts?.[dateKey] ?? mealPlan.childrenCount;
          const staff = mealPlan.staffCount;
          if (!Number.isSafeInteger(children) || children < 0 || !Number.isSafeInteger(staff) || staff < 0 || !Number.isSafeInteger(children + staff)) {
            issue('MEAL_COUNTS_UNKNOWN', `${day.day}: the saved meal plan has unknown serving counts.`, 'Review serving counts and save this meal plan again.', '/meals');
            continue;
          }
          for (const part of recipe.ingredients) {
            let perPerson;
            try { perPerson = storedAmount(part?.quantityPerPerson); } catch { perPerson = 0n; }
            const value = food.get(part?.ingredient?.id);
            if (!value || value.ingredient.unit !== part?.ingredient?.unit || perPerson <= 0n) {
              issue('RECIPE_INGREDIENT_INVALID', `${day.day}: ${recipe.meal?.name || slot} has a missing ingredient or invalid quantity.`,
                'Correct the recipe and save this meal plan using current recipes.', '/meals');
              continue;
            }
            const contribution = checkedAmount(perPerson * BigInt(children + staff));
            if (contribution) value.sources.push({ label: `${day.day} · ${recipe.meal?.name || selection.name || slot}`,
              quantity: contribution, date: dateKey });
          }
        }
      }
    }
  }
  const unlinked = [];
  for (const value of [...food.values()].sort((a, b) => a.ingredient.id.localeCompare(b.ingredient.id))) {
    if (!value.quantity) continue;
    const linked = stocks.filter((stock) => stock.ingredientId === value.ingredient.id);
    const candidates = linked.filter((stock) => UNITS.includes(stock.unit) && compatible(stock.unit, value.ingredient.unit));
    if (linked.length !== candidates.length) issue('FOOD_UNIT_INCOMPATIBLE', `${value.ingredient.name} has a linked inventory record with an incompatible unit.`,
      'Correct the inventory unit or ingredient link. Mass, volume, counts and packages are not interchangeable.', '/inventory');
    // The saved gross total is authoritative. Source weights distribute it
    // exactly even if old floating arithmetic rounded the final meal total.
    if (!value.sources.length) {
      issue('FOOD_SOURCE_MISSING', `${value.ingredient.name} has no complete saved recipe source.`, 'Review recipes and save this meal plan again.', '/meals');
      value.sources.push({ label: 'Saved meal plan', quantity: value.quantity });
    }
    const totalWeight = value.sources.reduce((sum, part) => sum + part.quantity, 0n);
    let assignedWeight = 0n;
    value.sources = value.sources.map((part, index) => {
      const portion = index === value.sources.length - 1 ? value.quantity - assignedWeight : value.quantity * part.quantity / totalWeight;
      assignedWeight += portion; return { ...part, quantity: portion };
    });
    let remaining = value.quantity;
    const assign = (row, canonicalQuantity) => {
      if (canonicalQuantity <= 0n) return;
      const quantity = checkedAmount(demand(canonicalQuantity, value.ingredient.unit, row.stock.unit));
      row.food = checkedAmount(row.food + quantity);
      let rest = canonicalQuantity;
      const contributions = [];
      for (const part of value.sources) {
        const portion = part.quantity < rest ? part.quantity : rest;
        if (!portion) continue;
        contributions.push({ ...part, quantity: portion }); part.quantity -= portion; rest -= portion;
        if (!rest) break;
      }
      contributions.forEach((part) => {
        source(row, { kind: 'meal', label: part.label, quantity: decimal(part.quantity), unit: value.ingredient.unit,
          ...(part.date ? { date: part.date } : {}) });
      });
      if (row.stock.unit !== value.ingredient.unit) row.notes.add(`Meal sources retain saved ${value.ingredient.unit} quantities. Their demand was converted to ${row.stock.unit}; requirements round up to six decimal places.`);
      row.notes.add('Food is allocated across compatible records linked to this ingredient after exact activity requirements. Each record’s stock is subtracted once.');
      remaining -= canonicalQuantity;
    };
    if (!candidates.length) {
      const archivedLinks = retainedStocks.some((stock) => stock.ingredientId === value.ingredient.id && inactive(stock));
      issue('FOOD_UNLINKED', `${value.ingredient.name} has no active compatible linked inventory record.${archivedLinks ? ' Archived stock is unavailable for this calculation.' : ''}`,
        'Create or link an active inventory record in the recipe unit, then recalculate.', '/inventory');
      unlinked.push({ id: 'ingredient:' + value.ingredient.id, itemId: null, ingredientId: value.ingredient.id,
        name: value.ingredient.name, unit: value.ingredient.unit, location: null, needed: decimal(value.quantity), inStorage: '0',
        toBuy: decimal(value.quantity), buyQuantity: decimal(value.quantity), selected: true, checked: false, stockItems: [],
        sources: value.sources.filter((part) => part.quantity).map((part) => ({ kind: 'meal', label: part.label,
          quantity: decimal(part.quantity), unit: value.ingredient.unit, ...(part.date ? { date: part.date } : {}) })),
        notes: ['Link a compatible inventory record before saving this list.'] });
      sourceCount += unlinked.at(-1).sources.length;
      if (sourceCount > MAX_SOURCES) throw problem('This purchasing calculation has too many source details. Include fewer plans.', 422);
      continue;
    }
    for (const stock of candidates) {
      if (!remaining) break;
      const row = rowFor(stock);
      const spare = positive(storedAmount(stock.quantity) - row.consumed - row.reused - row.food);
      const capacity = convert(spare, stock.unit, value.ingredient.unit);
      assign(row, capacity < remaining ? capacity : remaining);
    }
    // Coverage targets overlap food demand, so use their remaining coverage
    // before assigning residual food purchases to another physical location.
    for (const stock of candidates) {
      if (!remaining) break;
      const row = rowFor(stock);
      const capacity = convert(positive(row.target - row.consumed - row.reused - row.food), stock.unit, value.ingredient.unit);
      assign(row, capacity < remaining ? capacity : remaining);
    }
    if (remaining) assign(rowFor(candidates[0]), remaining);
  }
  const lines = [...rows.values()].filter((row) => row.sources.length).map((row) => {
    const needed = checkedAmount(maximum(row.consumed + row.reused + row.food, row.target));
    const available = storedAmount(row.stock.quantity);
    const toBuy = positive(needed - available);
    return { id: 'inventory:' + row.stock.id, itemId: row.stock.id, ingredientId: row.stock.ingredientId || null,
      name: row.stock.name, unit: row.stock.unit, location: row.stock.location || null,
      needed: decimal(needed), inStorage: decimal(available), toBuy: decimal(toBuy), buyQuantity: decimal(toBuy),
      selected: toBuy > 0n, checked: false, stockItems: [{ id: row.stock.id, name: row.stock.name,
        location: row.stock.location || null, unit: row.stock.unit, quantity: decimal(available), version: row.stock.version,
        allocated: decimal(available < needed ? available : needed) }], sources: row.sources, notes: [...row.notes] };
  }).concat(unlinked).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (lines.length > MAX_LINES) throw problem('This purchasing calculation contains too many items. Include fewer plans or low-stock targets.', 422);
  return { weekStart, version, savedAt: null, stockTakenAt, includeMeals, roomIds, lowStockTargets,
    mealPlan: includeMeals && mealPlan ? { version: mealPlan.version, savedAt: mealPlan.savedAt || null } : null,
    activityPlans: activityPlans.filter((plan) => plan.room).map((plan) => ({ roomId: plan.room.id, roomName: plan.room.name,
      version: plan.header?.version || 0, savedAt: plan.header?.savedAt || null })), lines, issues };
}

module.exports = { calculate, demand, MAX_LINES, MAX_ENTRIES };
