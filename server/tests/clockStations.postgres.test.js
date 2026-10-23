const { randomBytes, randomUUID, createHash, createHmac, scryptSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { createConnection } = require('../database/connection');
const db = require('../services/dbAdapter');
const fixture = require('./helpers/authenticatedRequest');

const digest = value => createHash('sha256').update(value).digest('hex');
const normalized = value => JSON.parse(JSON.stringify(value));
const hashPin = pin => { const salt = randomBytes(16).toString('hex'); return 'scrypt$131072$8$1$' + salt + '$' + scryptSync(pin, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex'); };
async function records() {
  const now = new Date('2026-10-23T12:00:00.000Z'), staffId = randomUUID();
  await db.createStaff({ id: staffId, name: 'Synthetic station employee', role: 'Other', active: true, roomId: null, version: 1 });
  const secrets = { pin: '975319', code: 'SYNTHETIC-PAIRING-SECRET', token: randomBytes(32).toString('hex') };
  const lookupKey = randomBytes(32);
  const station = { id: randomUUID(), name: 'Synthetic restricted clock station', credentialHash: digest(secrets.token),
    createdAt: now, lastUsedAt: null, expiresAt: new Date(now.getTime() + 90 * 86400000), revokedAt: null };
  const pairing = { id: digest(secrets.code), name: station.name, createdBy: fixture.credentials().account.id,
    createdAt: now, expiresAt: new Date(now.getTime() + 600000), consumedAt: null };
  const pin = { staffId, pinLookup: createHmac('sha256', lookupKey).update(secrets.pin).digest('hex'),
    pinHash: hashPin(secrets.pin),
    version: 1, createdAt: now, updatedAt: now };
  const attempt = { id: digest('synthetic-station-limit:' + station.id), startedAt: now, count: 2 };
  await db.withAuthLock(async () => {
    await db.createClockStation(station); await db.createClockPairing(pairing);
    await db.saveStaffClockPin(pin); await db.saveClockStationAttempt(attempt);
  });
  return { staffId, now, secrets, station, pairing, pin, attempt };
}
async function snapshot(value) {
  return {
    station: await db.getClockStationById(value.station.id), pairing: await db.getClockPairing(value.pairing.id),
    pin: await db.getStaffClockPin(value.staffId), attempt: await db.getClockStationAttempt(value.attempt.id),
  };
}

test('station credential hashes, consumed pairings, PIN resets and attempt limits survive a new Node process and PIN disable survives reconnect', async () => {
  const value = await records(), { schema } = context();
  const changedAt = new Date(value.now.getTime() + 30000);
  const resetPin = { ...value.pin, pinLookup: digest('synthetic-new-pin-lookup'), pinHash: hashPin('864208'), version: 2, updatedAt: changedAt };
  await db.withAuthLock(async () => {
    await db.updateClockStation(value.station.id, { revokedAt: changedAt, lastUsedAt: changedAt });
    await db.updateClockPairing(value.pairing.id, { consumedAt: changedAt });
    await db.saveStaffClockPin(resetPin);
    await db.saveClockStationAttempt({ ...value.attempt, count: 4 });
  });
  const expected = normalized(await snapshot(value));
  const script = `
    const db = require('./services/dbAdapter');
    (async () => {
      try {
        await db.setup(process.env.DATABASE_URL, { schema: process.env.CLOCK_TEST_SCHEMA });
        const result = {
          station: await db.getClockStationByCredentialHash(process.env.CLOCK_TEST_CREDENTIAL_HASH),
          pairing: await db.getClockPairing(process.env.CLOCK_TEST_PAIRING_ID),
          pin: await db.getStaffClockPinByLookup(process.env.CLOCK_TEST_PIN_LOOKUP),
          attempt: await db.getClockStationAttempt(process.env.CLOCK_TEST_ATTEMPT_ID),
        };
        process.stdout.write(JSON.stringify(result));
      } finally { await db.close(); }
    })().catch(() => { process.stderr.write('Synthetic station reconnect failed.'); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, CLOCK_TEST_SCHEMA: schema, CLOCK_TEST_CREDENTIAL_HASH: value.station.credentialHash,
      CLOCK_TEST_PAIRING_ID: value.pairing.id, CLOCK_TEST_PIN_LOOKUP: resetPin.pinLookup, CLOCK_TEST_ATTEMPT_ID: value.attempt.id },
  });
  expect(JSON.parse(output)).toEqual(expected);
  expect(expected.station.revokedAt).toBe(changedAt.toISOString());
  expect(expected.pin.version).toBe(2); expect(expected.attempt.count).toBe(4);
  expect(await db.getStaffClockPinByLookup(value.pin.pinLookup)).toBeNull();

  const reopened = createConnection(process.env.DATABASE_URL, { schema });
  try {
    const read = name => reopened.query(`SELECT * FROM "${schema}"."${name}"`, { type: QueryTypes.SELECT });
    const stored = await Promise.all(['ClockStations', 'ClockStationPairings', 'StaffClockPins', 'ClockStationAttempts'].map(read));
    const serialized = JSON.stringify(stored);
    for (const secret of Object.values(value.secrets)) expect(serialized).not.toContain(JSON.stringify(secret));
    expect(Object.keys(stored[0][0]).sort()).toEqual(['createdAt', 'credentialHash', 'expiresAt', 'id', 'lastUsedAt', 'name', 'revokedAt']);
    expect(Object.keys(stored[2][0]).sort()).toEqual(['createdAt', 'pinHash', 'pinLookup', 'staffId', 'updatedAt', 'version']);
    // Disabling preserves a version tombstone. Reusing the same PIN later
    // must never resurrect a grant issued for an earlier PIN revision.
    await db.saveStaffClockPin({ ...resetPin, pinLookup: digest('synthetic-disabled-pin'), pinHash: 'disabled', version: 3 });
    expect(await read('StaffClockPins')).toMatchObject([{ staffId: value.staffId, pinHash: 'disabled', version: 3 }]);
    expect(await db.getStaffClockPinByLookup(resetPin.pinLookup)).toBeNull();
  } finally { await reopened.close(); }
});

test('native uniqueness, reference and value constraints prevent shared PINs, missing owners and malformed persisted security records', async () => {
  const value = await records(), { connection, schema } = context();
  const otherId = randomUUID();
  await db.createStaff({ id: otherId, name: 'Synthetic second station employee', role: 'Other', active: true, roomId: null, version: 1 });
  await expect(db.createClockStation({ ...value.station, id: randomUUID() })).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  await expect(db.createClockPairing(value.pairing)).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  await expect(db.saveStaffClockPin({ ...value.pin, staffId: otherId })).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  expect(await db.getStaffClockPin(value.staffId)).toMatchObject({ staffId: value.staffId, pinLookup: value.pin.pinLookup, version: 1 });
  expect(await db.getStaffClockPin(otherId)).toBeNull();
  await expect(db.saveStaffClockPin({ ...value.pin, staffId: 'missing-' + randomUUID(), pinLookup: digest('synthetic-missing-staff') })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(db.createClockPairing({ ...value.pairing, id: digest('synthetic-missing-owner'), createdBy: 'missing-' + randomUUID() })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(connection.query(`DELETE FROM "${schema}"."StaffMembers" WHERE id = :id`, { replacements: { id: value.staffId } })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  for (const operation of [
    () => db.createClockStation({ ...value.station, id: randomUUID(), credentialHash: 'not-a-credential-hash' }),
    () => db.createClockStation({ ...value.station, id: randomUUID(), credentialHash: digest('synthetic-expired-before-created'), expiresAt: value.now }),
    () => db.saveStaffClockPin({ ...value.pin, staffId: otherId, pinLookup: digest('synthetic-zero-pin-version'), version: 0 }),
    () => db.saveClockStationAttempt({ ...value.attempt, id: digest('synthetic-negative-attempts'), count: -1 }),
  ]) await expect(operation()).rejects.toMatchObject({ original: { code: '23514' } });
});

test('an audit insert failure rolls back station revocation, consumed pairing, PIN reset and attempt changes together', async () => {
  const value = await records(), before = await snapshot(value), resetLookup = digest('synthetic-rollback-pin-reset');
  await expect(db.withAuthLock(async () => {
    await db.updateClockStation(value.station.id, { revokedAt: new Date(value.now.getTime() + 1000) });
    await db.updateClockPairing(value.pairing.id, { consumedAt: new Date(value.now.getTime() + 1000) });
    await db.saveStaffClockPin({ ...value.pin, pinLookup: resetLookup, pinHash: 'disabled', version: 2, updatedAt: new Date(value.now.getTime() + 1000) });
    await db.saveClockStationAttempt({ ...value.attempt, count: 99 });
    await db.appendAudit({ id: randomUUID(), actorId: 'missing-' + randomUUID(), actorUsername: 'Synthetic station audit', action: 'station.clock', entityId: value.staffId, occurredAt: new Date() });
  })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  expect(await snapshot(value)).toEqual(before);
  expect(await db.getStaffClockPinByLookup(resetLookup)).toBeNull();
});

test('the native auth lock serializes durable attempt increments and single-use pairing decisions', async () => {
  const value = await records();
  const increment = () => db.withAuthLock(async () => {
    const previous = await db.getClockStationAttempt(value.attempt.id);
    await db.saveClockStationAttempt({ ...previous, count: previous.count + 1 });
  });
  await Promise.all([increment(), increment()]);
  expect(await db.getClockStationAttempt(value.attempt.id)).toMatchObject({ count: 4 });
  const consume = () => db.withAuthLock(async () => {
    const pairing = await db.getClockPairing(value.pairing.id);
    if (pairing.consumedAt) return false;
    await db.updateClockPairing(pairing.id, { consumedAt: new Date(value.now.getTime() + 1000) });
    return true;
  });
  expect((await Promise.all([consume(), consume()])).sort()).toEqual([false, true]);
});
