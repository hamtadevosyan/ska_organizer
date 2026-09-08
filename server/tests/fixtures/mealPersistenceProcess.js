// Invoked in separate Node processes to verify persistence through the real API.
const request = require('supertest');
const app = require('../../index');
const db = require('../../services/dbAdapter');

async function api(method, url, body, status = 200) {
  const response = await request(app)[method](url).send(body);
  if (response.status !== status) throw new Error(`${method} ${url}: expected ${status}, got ${response.status}`);
  return response.body.data;
}

(async () => {
  try {
    await db.setup(process.env.DATABASE_URL, { schema: process.env.DB_SCHEMA });
    if (process.argv[2] === 'write') {
      const meal = await api('post', '/api/meals', { name: 'Egg Breakfast', type: 'breakfast' }, 201);
      for (const type of ['snack', 'lunch', 'afternoonSnack']) {
        await api('post', '/api/meals', { name: `${type} example`, type }, 201);
      }
      const eggs = await api('post', '/api/ingredients', { name: 'Eggs', unit: 'count', shelfLifeDays: 7 }, 201);
      await api('post', `/api/meals/${meal.id}/ingredients`, { ingredientId: eggs.id, quantity: 1 }, 201);
      const draft = await api('get', '/api/menu/generate');
      const shopping = await api('post', '/api/shopping/generate', { week: draft.week, childrenCount: 4, staffCount: 1 });
      if (shopping.items[0].quantity !== 25) throw new Error('Draft quantity changed');
      if (await api('get', '/api/menu/current') !== null) throw new Error('Draft was saved automatically');
      await api('post', '/api/menu/confirm', { week: draft.week });
      await api('post', '/api/shelf/check', { items: [{ ingredientId: eggs.id, quantity: 20, expiresAt: '2099-01-01' }] });
      for (const [weekStart, childrenCount] of [['2026-09-07', 4], ['2026-09-14', 8]]) {
        const calculated = await api('post', `/api/menu/plans/${weekStart}/preview`, {
          version: 0, week: draft.week.slice(0, 3).map((day) => ({ day: day.day, menu: { breakfast: day.menu.breakfast } })), childrenCount, staffCount: 1, inHouse: { [eggs.id]: 2 },
        });
        await api('put', `/api/menu/plans/${weekStart}`, { previewToken: calculated.previewToken });
      }
    }
    const meals = await api('get', '/api/meals');
    const breakfast = meals.find((meal) => meal.type === 'breakfast');
    const snapshot = {
      meals, ingredients: await api('get', '/api/ingredients'),
      recipe: await api('get', `/api/meals/${breakfast.id}/ingredients`),
      menu: await api('get', '/api/menu/current'),
      shelf: await db.getShelf(),
      shopping: (await api('get', '/api/shelf/final')).items,
      datedPlans: [await api('get', '/api/menu/plans/2026-09-07'), await api('get', '/api/menu/plans/2026-09-14')],
      datedShopping: await api('get', '/api/shelf/final?weekStart=2026-09-07'),
    };
    await db.close();
    process.send({ snapshot }, () => process.disconnect());
  } catch (error) {
    await db.close();
    process.send({ error: error.message }, () => { process.disconnect(); process.exitCode = 1; });
  }
})();
