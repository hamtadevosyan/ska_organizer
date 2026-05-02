const request = require("supertest");
const app = require("../index");
const db = require("../services/dbAdapter");

describe("Shopping List API", () => {
  beforeEach(async () => {
    db.meals = [];
    db.ingredients = [];
    db.mealIngredients = [];
    db.confirmedMenu = null;

    const breakfast = await db.createMeal({ name: "Oatmeal", type: "breakfast" });
    await db.createMeal({ name: "Banana", type: "snack" });
    await db.createMeal({ name: "Chicken Rice", type: "lunch" });
    await db.createMeal({ name: "Yogurt", type: "afternoonSnack" });

    const oats = await db.createIngredient({ name: "Oats", unit: "g", shelfLifeDays: 180 });
    const milk = await db.createIngredient({ name: "Milk", unit: "ml", shelfLifeDays: 7 });

    await db.addMealIngredient({ mealId: breakfast.id, ingredientId: oats.id, quantity: 30 });
    await db.addMealIngredient({ mealId: breakfast.id, ingredientId: milk.id, quantity: 100 });

    const generated = await request(app).get("/api/menu/generate");

    await request(app)
      .post("/api/menu/confirm")
      .send({ week: generated.body.data.week });
  });

  test("POST /api/shopping/generate returns aggregated ingredients", async () => {
    const res = await request(app)
      .post("/api/shopping/generate")
      .send({ childrenCount: 10, staffCount: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);

    const oats = res.body.data.items.find((i) => i.ingredient.name === "Oats");
    expect(oats.quantity).toBeGreaterThan(0);
  });
});
