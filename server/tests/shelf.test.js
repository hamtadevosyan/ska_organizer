const request = require('./helpers/authenticatedRequest');
const app = require("../index");
const db = require("../services/dbAdapter");
const { addRecipeIngredient } = require('./helpers/recipeMeal');

describe("Shelf Check API", () => {
  let oats;
  let milk;
  beforeEach(async () => {
    const breakfast = await db.createMeal({ name: "Oatmeal", type: "breakfast" });

    // Catalog ordering and recipe ordering need not match. Keep the intended
    // stock item's ID instead of assuming the first row always means oats.
    milk = await db.createIngredient({ name: "Milk", unit: "ml", shelfLifeDays: 7 });
    oats = await db.createIngredient({ name: "Oats", unit: "g", shelfLifeDays: 180 });

    await db.addMealIngredient({ mealId: breakfast.id, ingredientId: oats.id, quantity: 30 });
    await db.addMealIngredient({ mealId: breakfast.id, ingredientId: milk.id, quantity: 100 });
    for (const [name, type] of [['Banana', 'snack'], ['Chicken Rice', 'lunch'], ['Yogurt', 'afternoonSnack']]) {
      await addRecipeIngredient(await db.createMeal({ name, type }));
    }

    const generated = await request(app).get("/api/menu/generate");
    expect(generated.status).toBe(200);

    const confirmed = await request(app)
      .post("/api/menu/confirm")
      .send({ week: generated.body.data.week });
    expect(confirmed.status).toBe(200);
  });

  test("POST /api/shelf/check stores shelf data", async () => {
    const res = await request(app)
      .post("/api/shelf/check")
      .send({
        items: [
          { ingredientId: oats.id, quantity: 500 }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(await db.getShelf()).toEqual([{ ingredientId: oats.id, quantity: 500 }]);
  });

  test.each(['original', 'reversed'])("GET /api/shelf/final matches the stocked ingredient with %s meal key order", async (order) => {
    if (order === 'reversed') {
      // PostgreSQL JSONB may return object keys in a different order after a
      // restart. The shopping rows can move without changing any stock math.
      const saved = await db.getConfirmedMenu();
      await db.saveConfirmedMenu({ week: saved.week.map((day) => ({ ...day,
        menu: Object.fromEntries(Object.entries(day.menu).reverse()),
      })) });
    }

    const checked = await request(app)
      .post("/api/shelf/check")
      .send({
        items: [
          { ingredientId: oats.id, quantity: 500 }
        ]
      });
    expect(checked.status).toBe(200);

    const res = await request(app).get("/api/shelf/final");

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(5);

    const stockedOats = res.body.data.items.find((item) => item.ingredient.id === oats.id);
    expect(stockedOats).toMatchObject({ required: 3750, inStorage: 500, toBuy: 3250 });
    const unstockedMilk = res.body.data.items.find((item) => item.ingredient.id === milk.id);
    expect(unstockedMilk).toMatchObject({ required: 12500, inStorage: 0, toBuy: 12500 });
    for (const item of res.body.data.items.filter((item) => ![oats.id, milk.id].includes(item.ingredient.id))) {
      expect(item).toMatchObject({ required: 125, inStorage: 0, toBuy: 125 });
    }
  });
});
