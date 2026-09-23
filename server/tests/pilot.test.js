const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const configureSecret = require('../config/database-secret');
const format = require('../operations/backup-format');

afterEach(() => jest.restoreAllMocks());

test('readiness checks storage without exposing data or granting anonymous access', async () => {
  expect((await anonymous(app).get('/api/ready')).body).toEqual({ status: 'ready' });
  const health = jest.spyOn(db, 'health').mockRejectedValueOnce(new Error('postgresql://private:password@db/private'));
  const down = await anonymous(app).get('/api/ready');
  expect(down.status).toBe(503);
  expect(down.body).toEqual({ status: 'unavailable' });
  expect(down.headers['cache-control']).toBe('no-store');
  expect(health).toHaveBeenCalledTimes(1);
  expect((await anonymous(app).get('/api/rooms')).status).toBe(401);
  expect((await anonymous(app).get('/api/health')).body).toEqual({ status: 'ok' });
});

test('database outage has a retryable error and a matching safe log request identifier', async () => {
  const raw = Object.assign(new Error('private child and password must not appear'), { name: 'SequelizeConnectionRefusedError', sql: 'private SQL' });
  const list = jest.spyOn(db, 'listRooms').mockRejectedValueOnce(raw);
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request(app).get('/api/rooms').set('X-Request-Id', 'spoofed-request');
  expect(response.status).toBe(503);
  expect(list).toHaveBeenCalledTimes(1);
  expect(response.headers['retry-after']).toBe('5');
  expect(response.body).toEqual({ error: { message: 'Storage is temporarily unavailable. Please try again.', code: 'DATABASE_UNAVAILABLE' } });
  const record = JSON.parse(log.mock.calls[0][0]);
  expect(record).toEqual({ event: 'request_failed', requestId: response.headers['x-request-id'], method: 'GET', status: 503, code: 'DATABASE_UNAVAILABLE' });
  expect(record.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|password|spoofed/);
  expect(response.headers['set-cookie']).toBeUndefined(); // An outage is not a sign-out.
});

test('unexpected errors remain generic and omit exception contents in logs', async () => {
  jest.spyOn(db, 'listRooms').mockRejectedValueOnce(new Error('Secret SQL values'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request(app).get('/api/rooms');
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { message: 'Internal server error.' } });
  expect(JSON.stringify(log.mock.calls)).not.toContain('Secret');
});

test('a mounted password is encoded once and development URLs are preserved', () => {
  const env = { DATABASE_PASSWORD_FILE: '/test/secret', DATABASE_HOST: 'db', DATABASE_USER: 'ska_app', DATABASE_NAME: 'ska_organizer' };
  configureSecret(env, () => 'Example%/secret\n');
  expect(new URL(env.DATABASE_URL).password).toBe('Example%25%2Fsecret');
  const development = { DATABASE_URL: 'postgresql://example/db' };
  configureSecret(development, () => { throw new Error('Should not be read'); });
  expect(development.DATABASE_URL).toBe('postgresql://example/db');
  expect(() => configureSecret({ ...env }, () => 'other')).toThrow('not both');
  const noUrl = { ...env }; delete noUrl.DATABASE_URL;
  expect(() => configureSecret(noUrl, () => { throw new Error('secret file content'); })).toThrow('Could not read DATABASE_PASSWORD_FILE. Check the mounted secret.');
});

function manifest() {
  return { format: 1, name: 'backup-2026-09-23T12-00-00-000Z-0123456789ab', release: 'a'.repeat(40), sha256: 'b'.repeat(64), postgresMajor: 17,
    tables: format.required.map((name) => ({ name, count: 1, columns: [{ column_name: 'id', data_type: 'uuid' }], sha256: 'c'.repeat(64) })) };
}
test('recovery rejects changed content even when counts match, and checks table definitions', () => {
  const expected = manifest().tables;
  const changed = structuredClone(expected); changed[0].sha256 = 'd'.repeat(64);
  expect(() => format.compareTables(expected, changed)).toThrow('do not match');
  changed[0] = { ...expected[0], columns: [] };
  expect(() => format.compareTables(expected, changed)).toThrow('do not match');
  expect(() => format.compareTables(expected, [...expected].reverse())).not.toThrow();
});
test('backup names cannot leave the backup folder and every required table must be represented', () => {
  expect(format.safeName('../private')).toBe(false);
  expect(format.safeName('backup-2026/../../private')).toBe(false);
  expect(() => format.validateManifest(manifest())).not.toThrow();
  const missing = manifest(); missing.tables.pop();
  expect(() => format.validateManifest(missing)).toThrow('missing required');
  const duplicate = manifest(); duplicate.tables.push(duplicate.tables[0]);
  expect(() => format.validateManifest(duplicate)).toThrow('Invalid table');
});
test('coverage distinguishes empty domains and row hashes include row boundaries', () => {
  expect(Object.values(format.coverageResult(manifest().tables)).every(Boolean)).toBe(true);
  const empty = manifest().tables.map((table) => ({ ...table, count: table.name === 'Children' ? 0 : table.count }));
  expect(format.coverageResult(empty).children).toBe(false);
  const first = format.rowDigest(); first.add('a'); first.add('bc');
  const second = format.rowDigest(); second.add('ab'); second.add('c');
  expect(first.finish().sha256).not.toBe(second.finish().sha256);
});
