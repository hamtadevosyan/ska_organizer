const request = require("supertest");
const app = require("../index");
const db = require("../services/dbAdapter");

describe("Meal Planner end-to-end API flow", () => {
  beforeEach(async () => {
    const oatmeal = await db.createMeal({
      name: "Oatmeal",
      type: "breakfast"
    });
    await db.createMeal({ name: "Banana", type: "snack" });
    await db.createMeal({ name: "Chicken Rice", type: "lunch" });
    await db.createMeal({ name: "Yogurt", type: "afternoonSnack" });

    const oats = await db.createIngredient({
      name: "Oats",
      unit: "g",
      shelfLifeDays: 180
    });

    await db.addMealIngredient({
      mealId: oatmeal.id,
      ingredientId: oats.id,
      quantity: 30
    });
  });

  test("selects a saved meal, recalculates the draft, saves it, and subtracts stock", async () => {
    const generated = await request(app).get("/api/menu/generate");

    expect(generated.status).toBe(200);
    expect(generated.body.data.week).toHaveLength(5);

    const pancakesResponse = await request(app)
      .post("/api/meals")
      .send({
        name: "Pancakes",
        type: "breakfast",
        description: "A saved breakfast choice"
      });
    const eggsResponse = await request(app)
      .post("/api/ingredients")
      .send({ name: "Eggs", unit: "count" });

    expect(pancakesResponse.status).toBe(201);
    expect(eggsResponse.status).toBe(201);

    const pancakes = pancakesResponse.body.data;
    const eggs = eggsResponse.body.data;

    const recipeResponse = await request(app)
      .post(`/api/meals/${pancakes.id}/ingredients`)
      .send({ ingredientId: eggs.id, quantity: 2 });

    expect(recipeResponse.status).toBe(201);

    const catalogResponse = await request(app).get("/api/meals");
    const savedPancakes = catalogResponse.body.data.find(
      (meal) => meal.id === pancakes.id
    );

    expect(savedPancakes).toMatchObject({
      id: pancakes.id,
      name: "Pancakes",
      type: "breakfast"
    });

    const draftWeek = generated.body.data.week;
    draftWeek[0].menu.breakfast = savedPancakes;

    const shoppingResponse = await request(app)
      .post("/api/shopping/generate")
      .send({
        week: draftWeek,
        childrenCount: 20,
        staffCount: 5
      });

    expect(shoppingResponse.status).toBe(200);

    const draftEggs = shoppingResponse.body.data.items.find(
      (item) => item.ingredient.id === eggs.id
    );
    const draftOats = shoppingResponse.body.data.items.find(
      (item) => item.ingredient.name === "Oats"
    );

    // One pancake breakfast: 2 eggs per person for 25 people.
    expect(draftEggs.quantity).toBe(50);
    // Four oatmeal breakfasts: 30 g per person for 25 people.
    expect(draftOats.quantity).toBe(3000);

    const saveResponse = await request(app)
      .post("/api/menu/confirm")
      .send({ week: draftWeek });

    expect(saveResponse.status).toBe(200);

    const currentMenuResponse = await request(app).get("/api/menu/current");

    expect(currentMenuResponse.status).toBe(200);
    expect(currentMenuResponse.body.data.week[0].menu.breakfast.id).toBe(
      pancakes.id
    );

    const shelfResponse = await request(app)
      .post("/api/shelf/check")
      .send({
        items: [{ ingredientId: eggs.id, quantity: 20 }]
      });

    expect(shelfResponse.status).toBe(200);

    const finalListResponse = await request(app).get("/api/shelf/final");
    const finalEggs = finalListResponse.body.data.items.find(
      (item) => item.ingredient.id === eggs.id
    );

    expect(finalListResponse.status).toBe(200);
    expect(finalEggs).toMatchObject({
      required: 50,
      inStorage: 20,
      toBuy: 30
    });
  });
});
