// Keep test HTTP origins independent of the development VM configuration.
process.env.APP_ORIGINS = 'http://localhost:5173';
// Invoked in separate Node processes to verify persistence through the real API.
const request = require('supertest');
const app = require('../../index');
const db = require('../../services/dbAdapter');
const auth = require('../../auth/service');
const { PNG } = require('pngjs');
const { createHash, randomUUID } = require('node:crypto');
let credentials;

async function api(method, url, body, status = 200) {
  const response = await request(app)[method](url).set('Origin', 'http://localhost:5173').set('Cookie', credentials.cookie).set('X-CSRF-Token', credentials.csrf).set('Content-Type', 'application/json').send(body);
  if (response.status !== status) throw new Error(`${method} ${url}: expected ${status}, got ${response.status}`);
  return Object.hasOwn(response.body, 'data') ? response.body.data : response.body;
}

function syntheticPage(shade) {
  const page = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < page.data.length; offset += 4) page.data.set([shade, 90, 160, 255], offset);
  return PNG.sync.write(page);
}
const pageFile = (shade, name) => ({ name, contentType: 'image/png', dataBase64: syntheticPage(shade).toString('base64') });

async function saveDocuments() {
  const child = await api('post', '/api/children', { firstName: 'Synthetic', lastName: 'Document restart', dateOfBirth: '2022-06-15' }, 201);
  const root = '/api/children/' + child.id + '/documents';
  const saved = await api('post', root, { requestId: randomUUID(), title: 'Synthetic restart consent', category: 'consent',
    documentDate: '2026-10-01', notes: 'Automated fictional paperwork.', file: pageFile(40, 'synthetic-original.png') }, 201);
  const revised = await api('post', root + '/' + saved.document.id + '/revisions', { requestId: randomUUID(),
    version: saved.document.version, changeNote: 'Synthetic revised page', file: pageFile(180, 'synthetic-revised.png') }, 201);
  await api('put', root + '/' + saved.document.id, { version: revised.document.version, title: 'Updated synthetic restart consent',
    category: 'consent', documentDate: '2026-10-02', notes: 'Updated automated fictional paperwork.' });
  await api('put', '/api/children/' + child.id + '/enrollment', { active: false });
}

async function documentSnapshot() {
  const roster = await api('get', '/api/children?active=all&q=Document%20restart');
  const child = roster.items[0];
  if (!child || child.active) throw new Error('Synthetic ended child enrollment was not preserved.');
  const list = await api('get', '/api/children/' + child.id + '/documents');
  const document = list.items[0];
  if (!document) throw new Error('Synthetic document metadata was not preserved.');
  const detail = await api('get', '/api/children/' + child.id + '/documents/' + document.id);
  if (detail.revisions.length !== 2) throw new Error('Synthetic document history was not preserved.');
  const files = [];
  for (const revision of detail.revisions) {
    const stored = await db.getChildDocumentContent(document.id, revision.id);
    const bytes = Buffer.from(stored.content);
    if (createHash('sha256').update(bytes).digest('hex') !== stored.sha256) throw new Error('Synthetic document checksum changed.');
    files.push({ revisionId: revision.id, revision: revision.revision, sha256: stored.sha256, bytes: bytes.toString('base64'),
      actorId: stored.actorId, uploadedBy: stored.uploadedBy, changeNote: stored.changeNote });
  }
  return { childId: child.id, active: child.active, detail, files };
}

(async () => {
  try {
    await db.setup(process.env.DATABASE_URL, { schema: process.env.DB_SCHEMA });
    const identity = { username: 'restart-admin', displayName: 'Restart Test', password: 'Synthetic restart passphrase 20!' };
    if (!await db.findAccount(identity.username)) {
      const { hashPassword } = require('../../auth/passwords');
      await db.createAccount({ id: require('node:crypto').randomUUID(), username: identity.username, displayName: identity.displayName,
        passwordHash: await hashPassword(identity.password), role: 'admin', disabled: false, mustChangePassword: false });
    }
    const signedIn = await auth.login(identity, 'restart-test');
    credentials = { cookie: `skao_session=${signedIn.token}`, csrf: signedIn.csrfToken };
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
      await api('post', '/api/inventory', { name: 'Persistent eggs', category: 'Food', location: 'Kitchen / Shelf 1',
        ingredientId: eggs.id, unit: 'count', openingQuantity: '2', reorderThreshold: '0', reason: 'Opening count', requestId: require('node:crypto').randomUUID() }, 201);
      for (const [weekStart, childrenCount] of [['2026-09-07', 4], ['2026-09-14', 8]]) {
        const calculated = await api('post', `/api/menu/plans/${weekStart}/preview`, {
          version: 0, week: draft.week.slice(0, 3).map((day) => ({ day: day.day, menu: { breakfast: day.menu.breakfast } })), childrenCount, staffCount: 1,
        });
        await api('put', `/api/menu/plans/${weekStart}`, { previewToken: calculated.previewToken });
      }
      await saveDocuments();
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
      childDocuments: await documentSnapshot(),
    };
    await db.close();
    process.send({ snapshot }, () => process.disconnect());
  } catch (error) {
    await db.close();
    process.send({ error: error.message }, () => { process.disconnect(); process.exitCode = 1; });
  }
})();
