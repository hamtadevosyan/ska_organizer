// server/services/shelfService.js

const db = require("./dbAdapter");

exports.saveShelfCheck = async (items) => {
  return db.saveShelfCheck(items);
};

exports.generateFinalShoppingList = async () => {
  const shelf = await db.getShelf();
  const confirmed = await db.getConfirmedMenu();

  if (!confirmed || !confirmed.week) {
    throw new Error("No confirmed menu found");
  }

  // First generate the raw shopping list
  const shoppingService = require("./shoppingService");
  const raw = await shoppingService.generateShoppingList();

  const finalItems = [];

  for (const item of raw.items) {
    const shelfItem = shelf.find((s) => s.ingredientId === item.ingredient.id);

    let toBuy = item.quantity;

    let warnings = [];

    if (shelfItem) {
      // Subtract what is already in storage
      toBuy = Math.max(0, item.quantity - shelfItem.quantity);

      // Expiration warning
      if (shelfItem.expiresAt) {
        const expires = new Date(shelfItem.expiresAt);
        const now = new Date();
        const diffDays = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));

        if (diffDays <= 2) {
          warnings.push(`Warning: ${item.ingredient.name} in storage expires in ${diffDays} days`);
        }
      }
    }

    finalItems.push({
      ingredient: item.ingredient,
      required: item.quantity,
      inStorage: shelfItem ? shelfItem.quantity : 0,
      toBuy,
      warnings
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    items: finalItems
  };
};

