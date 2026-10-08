const format = require('../operations/backup-format');
const { fingerprint } = require('../operations/pilot-data');

function manifest(version) {
  return { format: version, name: 'backup-2026-10-07T12-00-00-000Z-0123456789ab', release: 'a'.repeat(40),
    sha256: 'b'.repeat(64), postgresMajor: 17,
    tables: format.requiredForFormat(version).map((name) => ({ name, count: 1, columns: [], sha256: 'c'.repeat(64) })) };
}

test('current backups require both document metadata and file revisions while older backups stay restorable', () => {
  expect(() => format.validateManifest(manifest(1))).not.toThrow();
  expect(() => format.validateManifest(manifest(2))).not.toThrow();
  for (const missingName of ['ChildDocuments', 'ChildDocumentRevisions']) {
    const incomplete = manifest(2);
    incomplete.tables = incomplete.tables.filter(({ name }) => name !== missingName);
    expect(() => format.validateManifest(incomplete)).toThrow('missing required');
  }
  expect(() => format.validateManifest({ ...manifest(2), format: 3 })).toThrow('Unsupported');
  expect(format.coverageResult(manifest(1).tables).documents).toBe(false);
  expect(format.coverageResult(manifest(2).tables).documents).toBe(true);
  expect(format.coverageResult(manifest(2).tables.map((table) => table.name === 'ChildDocumentRevisions'
    ? { ...table, count: 0 } : table)).documents).toBe(false);
});

function fixtureClient(version) {
  let table; let finished;
  return { query: jest.fn(async (sql, values) => {
    if (sql.startsWith('SELECT tablename')) return { rows: format.requiredForFormat(version).map((tablename) => ({ tablename })) };
    if (sql.includes('information_schema.columns')) return { rows: [{ column_name: values[0] === 'ChildDocumentRevisions' ? 'content' : 'id', data_type: 'bytea' }] };
    if (sql.startsWith('DECLARE')) { table = /FROM public\."([^"]+)"/.exec(sql)[1]; finished = false; return { rows: [] }; }
    if (sql.startsWith('FETCH')) {
      if (finished) return { rows: [] };
      finished = true;
      return { rows: [{ value: JSON.stringify({ id: table, ...(table === 'ChildDocumentRevisions' ? { content: '\\x89504e47' } : {}) }) }] };
    }
    if (sql === 'CLOSE pilot_rows') return { rows: [] };
    throw new Error('Unexpected fingerprint query.');
  }) };
}

test('file fingerprints read one revision at a time and hash the complete binary content', async () => {
  const client = fixtureClient(2);
  const result = await fingerprint(client);
  const commands = client.query.mock.calls.map(([sql]) => sql);
  const declaration = commands.findIndex((sql) => sql.includes('FROM public."ChildDocumentRevisions"'));
  expect(commands[declaration]).toContain('ORDER BY t."id" COLLATE "C"');
  expect(commands[declaration + 1]).toBe('FETCH 1 FROM pilot_rows');
  expect(commands[declaration + 2]).toBe('FETCH 1 FROM pilot_rows');
  const expected = format.rowDigest(); expected.add(JSON.stringify({ id: 'ChildDocumentRevisions', content: '\\x89504e47' }));
  expect(result.find(({ name }) => name === 'ChildDocumentRevisions')).toMatchObject(expected.finish());
});

test('old restore verification keeps legacy fingerprint ordering without requiring newer tables', async () => {
  const client = fixtureClient(1);
  const result = await fingerprint(client, 1);
  expect(result.map(({ name }) => name)).toEqual(format.legacyRequired);
  expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('DECLARE'))
    .every(([sql]) => sql.endsWith('ORDER BY to_jsonb(t)::text COLLATE "C"'))).toBe(true);
});
