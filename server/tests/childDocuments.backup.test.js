const format = require('../operations/backup-format');
const { fingerprint } = require('../operations/pilot-data');

function manifest(version) {
  return { format: version, name: 'backup-2026-10-07T12-00-00-000Z-0123456789ab', release: 'a'.repeat(40),
    sha256: 'b'.repeat(64), postgresMajor: 17,
    tables: format.requiredForFormat(version).map((name) => ({ name, count: 1, columns: [], sha256: 'c'.repeat(64) })) };
}

test('current backups require staff files and warning settings while older backups stay restorable', () => {
  expect(() => format.validateManifest(manifest(1))).not.toThrow();
  expect(() => format.validateManifest(manifest(2))).not.toThrow();
  expect(() => format.validateManifest(manifest(3))).not.toThrow();
  expect(() => format.validateManifest(manifest(4))).not.toThrow();
  expect(manifest(1).tables.map(({ name }) => name)).not.toContain('ChildDocuments');
  expect(manifest(2).tables.map(({ name }) => name)).not.toContain('RegistrationForms');
  for (const missingName of ['ChildDocuments', 'ChildDocumentRevisions', 'RegistrationForms', 'RegistrationFormRevisions']) {
    const incomplete = manifest(3);
    incomplete.tables = incomplete.tables.filter(({ name }) => name !== missingName);
    expect(() => format.validateManifest(incomplete)).toThrow('missing required');
  }
  for (const missingName of ['ChildDocuments', 'ChildDocumentRevisions']) {
    const incomplete = manifest(2);
    incomplete.tables = incomplete.tables.filter(({ name }) => name !== missingName);
    expect(() => format.validateManifest(incomplete)).toThrow('missing required');
  }
  for (const missingName of ['StaffDocuments', 'StaffDocumentRevisions', 'StaffDocumentSettings']) {
    const incomplete = manifest(4);
    incomplete.tables = incomplete.tables.filter(({ name }) => name !== missingName);
    expect(() => format.validateManifest(incomplete)).toThrow('missing required');
  }
  expect(() => format.validateManifest({ ...manifest(4), format: 5 })).toThrow('Unsupported');
  expect(format.coverageResult(manifest(3).tables).staffDocuments).toBe(false);
  expect(format.coverageResult(manifest(4).tables).staffDocuments).toBe(true);
  expect(format.coverageResult(manifest(4).tables).staffDocumentSettings).toBe(true);
  expect(format.coverageResult(manifest(1).tables).documents).toBe(false);
  expect(format.coverageResult(manifest(2).tables).documents).toBe(true);
  expect(format.coverageResult(manifest(2).tables.map((table) => table.name === 'ChildDocumentRevisions'
    ? { ...table, count: 0 } : table)).documents).toBe(false);
  expect(format.coverageResult(manifest(2).tables).registrationForms).toBe(false);
  expect(format.coverageResult(manifest(3).tables).registrationForms).toBe(true);
  expect(format.coverageResult(manifest(3).tables.map((table) => table.name === 'RegistrationFormRevisions'
    ? { ...table, count: 0 } : table)).registrationForms).toBe(false);
});

const fileTables = ['ChildDocumentRevisions', 'RegistrationFormRevisions', 'StaffDocumentRevisions'];
function fixtureClient(version, extraTables = []) {
  let table; let finished;
  return { query: jest.fn(async (sql, values) => {
    if (sql.startsWith('SELECT tablename')) return { rows: [...format.requiredForFormat(version), ...extraTables].map((tablename) => ({ tablename })) };
    if (sql.includes('information_schema.columns')) return { rows: [{ column_name: fileTables.includes(values[0]) ? 'content' : 'id', data_type: 'bytea' }] };
    if (sql.startsWith('DECLARE')) { table = /FROM public\."([^"]+)"/.exec(sql)[1]; finished = false; return { rows: [] }; }
    if (sql.startsWith('FETCH')) {
      if (finished) return { rows: [] };
      finished = true;
      return { rows: [{ value: JSON.stringify({ id: table, ...(fileTables.includes(table) ? { content: '\\x89504e47' } : {}) }) }] };
    }
    if (sql === 'CLOSE pilot_rows') return { rows: [] };
    throw new Error('Unexpected fingerprint query.');
  }) };
}

test('all file fingerprints read one revision at a time and hash the complete binary content', async () => {
  const client = fixtureClient(4);
  const result = await fingerprint(client);
  const commands = client.query.mock.calls.map(([sql]) => sql);
  for (const name of fileTables) {
    const declaration = commands.findIndex((sql) => sql.includes('FROM public."' + name + '"'));
    expect(commands[declaration]).toContain('ORDER BY t."id" COLLATE "C"');
    expect(commands[declaration]).not.toContain('ORDER BY to_jsonb(t)');
    expect(commands[declaration + 1]).toBe('FETCH 1 FROM pilot_rows');
    expect(commands[declaration + 2]).toBe('FETCH 1 FROM pilot_rows');
    const expected = format.rowDigest(); expected.add(JSON.stringify({ id: name, content: '\\x89504e47' }));
    expect(result.find((table) => table.name === name)).toMatchObject(expected.finish());
    const changed = format.rowDigest(); changed.add(JSON.stringify({ id: name, content: '\\x89504e48' }));
    expect(result.find((table) => table.name === name).sha256).not.toBe(changed.finish().sha256);
  }
});

test('current backup creation rejects a database without migrated staff document tables', async () => {
  await expect(fingerprint(fixtureClient(2))).rejects.toThrow('Migrate the organizer database');
  await expect(fingerprint(fixtureClient(3))).rejects.toThrow('Migrate the organizer database');
});

test('format three verification preserves its old file ordering even if staff tables are present', async () => {
  const client = fixtureClient(3, ['StaffDocuments', 'StaffDocumentRevisions', 'StaffDocumentSettings']);
  const result = await fingerprint(client, 3);
  expect(result).toHaveLength(format.requiredForFormat(3).length + 3);
  const commands = client.query.mock.calls.map(([sql]) => sql);
  expect(commands.find((sql) => sql.includes('FROM public."StaffDocumentRevisions"'))).toContain('ORDER BY to_jsonb(t)::text COLLATE "C"');
  expect(commands.find((sql) => sql.includes('FROM public."RegistrationFormRevisions"'))).toContain('ORDER BY t."id" COLLATE "C"');
});

test('format two restores retain document ordering and do not require blank form tables', async () => {
  const client = fixtureClient(2);
  const result = await fingerprint(client, 2);
  expect(result.map(({ name }) => name)).toEqual(format.requiredForFormat(2));
  expect(client.query.mock.calls.find(([sql]) => sql.includes('FROM public."ChildDocumentRevisions"'))[0])
    .toContain('ORDER BY t."id" COLLATE "C"');
  // Existing format two backups may include extra tables, whose original
  // fingerprints must remain valid even after format three is introduced.
  const extra = fixtureClient(2, ['RegistrationForms', 'RegistrationFormRevisions']);
  await fingerprint(extra, 2);
  expect(extra.query.mock.calls.find(([sql]) => sql.includes('FROM public."RegistrationFormRevisions"'))[0])
    .toContain('ORDER BY to_jsonb(t)::text COLLATE "C"');
});

test('old restore verification keeps legacy fingerprint ordering without requiring newer tables', async () => {
  const client = fixtureClient(1);
  const result = await fingerprint(client, 1);
  expect(result.map(({ name }) => name)).toEqual(format.legacyRequired);
  expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('DECLARE'))
    .every(([sql]) => sql.endsWith('ORDER BY to_jsonb(t)::text COLLATE "C"'))).toBe(true);
});
