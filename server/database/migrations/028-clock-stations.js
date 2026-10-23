exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const q = sequelize.getQueryInterface();
  const table = tableName => ({ tableName, schema });
  const id = () => ({ type: T.STRING, primaryKey: true, allowNull: false });
  const date = () => ({ type: T.DATE, allowNull: false });
  await q.createTable(table('ClockStations'), {
    id: id(), name: { type: T.STRING(160), allowNull: false },
    credentialHash: { type: T.STRING(64), allowNull: false, unique: true },
    createdAt: date(), lastUsedAt: { type: T.DATE, allowNull: true }, expiresAt: date(),
    revokedAt: { type: T.DATE, allowNull: true },
  }, { transaction });
  await q.addIndex(table('ClockStations'), ['expiresAt'], { name: 'clock_stations_expiry', transaction });
  await q.createTable(table('ClockStationPairings'), {
    id: { type: T.STRING(64), primaryKey: true, allowNull: false },
    name: { type: T.STRING(160), allowNull: false },
    createdBy: { type: T.STRING, allowNull: false, references: { model: table('Accounts'), key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
    createdAt: date(), expiresAt: date(), consumedAt: { type: T.DATE, allowNull: true },
  }, { transaction });
  await q.addIndex(table('ClockStationPairings'), ['expiresAt'], { name: 'clock_pairings_expiry', transaction });
  await q.createTable(table('StaffClockPins'), {
    staffId: { type: T.STRING, primaryKey: true, allowNull: false, references: { model: table('StaffMembers'), key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
    pinLookup: { type: T.STRING(64), allowNull: false, unique: true }, pinHash: { type: T.TEXT, allowNull: false },
    version: { type: T.INTEGER, allowNull: false }, createdAt: date(), updatedAt: date(),
  }, { transaction });
  await q.createTable(table('ClockStationAttempts'), {
    id: { type: T.STRING(64), primaryKey: true, allowNull: false }, startedAt: date(),
    count: { type: T.INTEGER, allowNull: false },
  }, { transaction });
  await q.addIndex(table('ClockStationAttempts'), ['startedAt'], { name: 'clock_attempts_started', transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."ClockStations"
    ADD CONSTRAINT clock_station_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 160),
    ADD CONSTRAINT clock_station_hash_valid CHECK ("credentialHash" ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT clock_station_expiry_valid CHECK ("expiresAt" > "createdAt")`, { transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."ClockStationPairings"
    ADD CONSTRAINT clock_pairing_hash_valid CHECK (id ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT clock_pairing_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 160),
    ADD CONSTRAINT clock_pairing_expiry_valid CHECK ("expiresAt" > "createdAt")`, { transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."StaffClockPins"
    ADD CONSTRAINT clock_pin_lookup_valid CHECK ("pinLookup" ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT clock_pin_hash_present CHECK (length("pinHash") > 0),
    ADD CONSTRAINT clock_pin_version_positive CHECK (version > 0)`, { transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."ClockStationAttempts"
    ADD CONSTRAINT clock_attempt_id_valid CHECK (id ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT clock_attempt_count_valid CHECK (count >= 0)`, { transaction });
};
