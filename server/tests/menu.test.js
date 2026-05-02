const request = require("supertest");
const app = require("../index");
const db = require("../services/dbAdapter");

describe("Menu API", () => {
  beforeEach(async () => {
    // Reset mock DB
    db.children = [];
    db.attendance = [];
    db.activities = [];
    db.meals = [];
    db.confirmedMenu = null;

    // Seed meals
    await db.createMeal({ name: "Oatmeal", type: "breakfast" });
    await db.createMeal({ name: "Banana", type: "snack" });
    await db.createMeal({ name: "Chicken Rice", type: "lunch" });
    await db.createMeal({ name: "Yogurt", type: "afternoonSnack" });
  });

  test("GET /api/menu/generate returns weekly menu", async () => {
    const res = await request(app).get("/api/menu/generate");

    expect(res.status).toBe(200);
    expect(res.body.data.week).toHaveLength(5);
    expect(res.body.data.week[0].menu.breakfast.name).toBe("Oatmeal");
  });

  test("POST /api/menu/confirm stores confirmed menu", async () => {
    const generated = await request(app).get("/api/menu/generate");

    const res = await request(app)
      .post("/api/menu/confirm")
      .send({ week: generated.body.data.week });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");

    const current = await request(app).get("/api/menu/current");
    expect(current.status).toBe(200);
    expect(current.body.data.week).toHaveLength(5);
  });
});

