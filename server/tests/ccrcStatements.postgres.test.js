const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes, QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');

test('private statement bytes, reviewed source lines and posted payment provenance survive a separate Node process', async () => {
  const { schema } = context();
  const id = randomUUID(), childId = randomUUID(), paymentId = randomUUID(), requestId = randomUUID();
  const content = Buffer.from(Array.from({ length: 4097 }, (_, index) => index % 256));
  const source = { id, fingerprint: createHash('sha256').update(content).digest('hex'), filename: 'synthetic-ccrc.pdf',
    contentType: 'application/pdf', byteLength: content.length, content, version: 1,
    data: { status: 'draft', extraction: { pageCount: 2, pages: [{ page: 1, text: 'Synthetic first page' }, { page: 2, text: 'Synthetic final child row; total $1,000.00' }] },
      review: { statementReference: 'SYNTHETIC-ONLY', paymentDate: '2026-11-20', totalCents: 100000,
        lines: [{ id: 'line-final', childId, serviceMonth: '2026-10', amountCents: 100000, page: 2, sourceExcerpt: 'Synthetic final child row' }] },
      requests: [], history: [{ type: 'upload', actorId: 'synthetic-administrator' }], postedPayments: [] } };
  await db.saveCcrcStatement(source);
  const saved = await db.saveCcrcStatement({ id, version: 2, data: { ...source.data, status: 'posted',
    requests: [{ id: requestId, fingerprint: 'synthetic-reviewed-confirmation' }],
    postedPayments: [{ childId, paymentId, lineId: 'line-final', serviceMonth: '2026-10', paymentDate: '2026-11-20', amountCents: 100000 }],
    history: [...source.data.history, { type: 'post', actorId: 'synthetic-administrator', sourcePage: 2 }] } }, 1);
  const expected = JSON.parse(JSON.stringify({ ...saved, content: saved.content.toString('base64') }));
  const script = `
    const db = require('./services/dbAdapter');
    (async () => {
      try {
        await db.setup(process.env.DATABASE_URL, { schema: process.env.CCRC_TEST_SCHEMA });
        const row = await db.getCcrcStatement(process.env.CCRC_TEST_ID);
        const byHash = await db.getCcrcStatementByFingerprint(row.fingerprint);
        const list = await db.listCcrcStatements();
        const identity = await db.getCcrcStatementIdentity(row.id);
        process.stdout.write(JSON.stringify({ row: { ...row, content: row.content.toString('base64') }, sameId: byHash.id,
          identity, listedIds: list.map(value => value.id), listedContent: list.some(value => Object.hasOwn(value, 'content')) }));
      } finally { await db.close(); }
    })().catch(() => { process.stderr.write('Synthetic private CCRC reconnect failed.'); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, CCRC_TEST_SCHEMA: schema, CCRC_TEST_ID: id } });
  expect(JSON.parse(output)).toEqual({ row: expected, sameId: id, identity: { id, fingerprint: source.fingerprint, status: 'posted' }, listedIds: [id], listedContent: false });
});

test('migration030 preserves populated tuition history and enforces private statement shape, size and fingerprint uniqueness natively', async () => {
  const { connection } = context(), schema = 'skao_ccrc_' + randomUUID().replaceAll('-', '');
  const qi = connection.getQueryInterface(), table = tableName => ({ tableName, schema });
  const quoted = name => qi.queryGenerator.quoteTable(table(name));
  const directory = path.join(__dirname, '../database/migrations');
  const previous = fs.readdirSync(directory).filter(name => /^\d{3}-.+\.js$/.test(name) && name < '030-').sort();
  const now = new Date(); let created = false;
  try {
    await connection.createSchema(schema); created = true;
    await connection.transaction(async transaction => {
      await qi.createTable(table('SequelizeMeta'), { name: { type: DataTypes.STRING, primaryKey: true, allowNull: false } }, { transaction });
      for (const filename of previous) {
        await require(path.join(directory, filename)).up({ sequelize: connection, schema, transaction, DataTypes });
        await qi.bulkInsert(table('SequelizeMeta'), [{ name: filename.slice(0, -3) }], { transaction });
      }
      await qi.bulkInsert(table('Children'), [{ id: 'existing-tuition-child', firstName: 'Existing', lastName: 'Synthetic child',
        dateOfBirth: '2022-05-06', active: true, roomId: null, createdAt: now, updatedAt: now }], { transaction });
      await connection.query(`INSERT INTO ${quoted('ChildBillingRecords')} ("childId", data, version, "createdAt", "updatedAt")
        VALUES ('existing-tuition-child', CAST(:data AS jsonb), 1, :now, :now)`,
      { replacements: { data: JSON.stringify({ charges: [{ id: 'monthly:2026-10', tuitionCents: 120000 }], payments: [{ amountCents: 100000 }] }), now }, transaction });
    });
    const before = await connection.query(`SELECT * FROM ${quoted('ChildBillingRecords')}`, { type: QueryTypes.SELECT });
    expect(await migrate(connection, schema)).toEqual(['030-ccrc-statements']);
    expect(await connection.query(`SELECT * FROM ${quoted('ChildBillingRecords')}`, { type: QueryTypes.SELECT })).toEqual(before);
    expect(await migrate(connection, schema)).toEqual([]);

    const content = Buffer.from('Synthetic original statement bytes'), fingerprint = createHash('sha256').update(content).digest('hex');
    const insert = (changes = {}) => {
      const row = { id: randomUUID(), fingerprint, filename: 'synthetic.pdf', contentType: 'application/pdf', byteLength: content.length, content, data: {}, version: 1, ...changes };
      return connection.query(`INSERT INTO ${quoted('CcrcStatementImports')}
        (id, fingerprint, filename, "contentType", "byteLength", content, data, version, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, CAST($7 AS jsonb), $8, $9, $9)`,
      { bind: [row.id, row.fingerprint, row.filename, row.contentType, row.byteLength, row.content, JSON.stringify(row.data), row.version, now] });
    };
    for (const changes of [
      { version: 0 }, { data: null }, { data: [] }, { data: 'not-an-object' },
      { fingerprint: 'A'.repeat(64) }, { contentType: 'text/html' }, { filename: '   ' },
      { byteLength: content.length + 1 }, { content: Buffer.alloc(0), byteLength: 0 },
      { content: Buffer.alloc(5 * 1024 * 1024 + 1), byteLength: 5 * 1024 * 1024 + 1 },
    ]) await expect(insert(changes)).rejects.toMatchObject({ original: { code: '23514' } });
    await insert();
    await expect(insert({ filename: 'same-file-renamed.pdf' })).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    const rows = await connection.query(`SELECT content, fingerprint, "byteLength", data, version FROM ${quoted('CcrcStatementImports')}`, { type: QueryTypes.SELECT });
    expect(rows).toEqual([{ content, fingerprint, byteLength: content.length, data: {}, version: 1 }]);
  } finally { if (created) await connection.dropSchema(schema, { cascade: true }); }
});
