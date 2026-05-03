const request = require("supertest");
const app = require("../index");
const db = require("../services/dbAdapter");

describe("Meals Management API", () => {
  beforeEach(() => {
    db.meals = [];
    db.ingredients = [];
    db.mealIngredients = [];
  });

  test("POST /api/meals creates a meal", async () => {
    const res = await request(app)
      .post("/api/meals")
      .send({
        name: "Pancakes",
        type: "breakfast",
        description: "Breakfast meal"
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("data.id");
    expect(res.body.data.name).toBe("Pancakes");
  });

  test("POST /api/ingredients creates an ingredient", async () => {
    const res = await request(app)
      .post("/api/ingredients")
      .send({
        name: "Eggs",
        unit: "count"
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("data.id");
    expect(res.body.data.name).toBe("Eggs");
  });

  test("POST /api/meals/:mealId/ingredients connects ingredient to meal", async () => {
    const mealRes = await request(app)
      .post("/api/meals")
      .send({
        name: "Oatmeal",
        type: "breakfast",
        description: "Warm breakfast"
      });

    const ingredientRes = await request(app)
      .post("/api/ingredients")
      .send({
        name: "Oats",
        unit: "g"
      });

    const mealId = mealRes.body.data.id;
    const ingredientId = ingredientRes.body.data.id;

    const linkRes = await request(app)
      .post(`/api/meals/${mealId}/ingredients`)
      .send({
        ingredientId,
        quantity: 30
      });

    expect(linkRes.status).toBe(201);
    expect(linkRes.body).toHaveProperty("data.id");
    expect(linkRes.body.data.mealId).toBe(mealId);
    expect(linkRes.body.data.ingredientId).toBe(ingredientId);
    expect(linkRes.body.data.quantity).toBe(30);

    const listRes = await request(app).get(`/api/meals/${mealId}/ingredients`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].ingredientId).toBe(ingredientId);
  });
});
