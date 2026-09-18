const db = require('./dbAdapter');
const { amount, decimal } = require('./inventoryValidation');
const { convert } = require('./stockUnits');

// Call inside catalog -> inventory locks so every ingredient uses one consistent
// stock sample. Read every matching location, independently of UI pagination.
async function applyStock(items) {
  const rows = items.length ? await db.listInventoryForIngredients(items.map((item) => item.ingredient.id)) : [];
  const byIngredient = new Map();
  for (const row of rows) {
    const matches = byIngredient.get(row.ingredientId) || [];
    matches.push(row); byIngredient.set(row.ingredientId, matches);
  }
  return items.map((item) => {
    const matches = byIngredient.get(item.ingredient.id) || [];
    const available = matches.reduce((sum, row) => sum + convert(amount(row.quantity), row.unit, item.ingredient.unit), 0n);
    const needed = amount(item.quantity);
    return { ...item, inStorage: Number(decimal(available)), toBuy: Number(decimal(needed > available ? needed - available : 0n)),
      stockItems: matches.map((row) => ({ id: row.id, name: row.name, location: row.location, unit: row.unit,
        quantity: decimal(amount(row.quantity)), version: row.version })) };
  });
}
module.exports = { applyStock, convert };
